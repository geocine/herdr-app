//! HERDR FORK (geocine): native helpers for the geocine mod, imported as `"geocine"`.
//!
//! The mod used to start a process for each of these (Git's sh, cmd, PowerShell, robocopy):
//! 100-450 ms each on Windows, mostly the process starting. Here they are a thread and a
//! syscall or two. They read this computer only; the mod keeps its shell path for other
//! machines (`on`). Each call runs on its own thread, so the window never waits on a disk.
//!
//! Kept in this one file (and `defaults/geocine.d.ts`) so rebasing on upstream touches only
//! the few lines that register it in mods.rs and main.rs.

use std::{
    cmp::Ordering,
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
};

use gpui_shell::{HostError, HostModule, HostValue};
use serde_json::{Value, json};

use crate::mods::{from_host, to_host};

pub const DECLARATIONS: &str = include_str!("../defaults/geocine.d.ts");

pub fn module() -> HostModule {
    HostModule::new("geocine")
        .declarations(DECLARATIONS)
        .async_function("listDirs", |a| {
            let paths = strings(a.get(0));
            let limit = a.get(1).map(from_host).and_then(|v| v.as_u64()).unwrap_or(5000) as usize;
            Ok(off_thread(move || Ok(Value::Array(paths.iter().map(|p| list_dir(p, limit)).collect()))))
        })
        .async_function("walk", |a| {
            let root = a.get(0).map(from_host).and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
            let o = a.get(1).map(from_host).unwrap_or(Value::Null);
            let opts = WalkOptions {
                depth: o["depth"].as_u64().unwrap_or(12) as usize,
                prune: names(&o["prune"]),
                top_prune: names(&o["topPrune"]),
                max_dirs: o["maxDirs"].as_u64().unwrap_or(20000) as usize,
                max_files: o["maxFiles"].as_u64().unwrap_or(40000) as usize,
            };
            Ok(off_thread(move || walk(Path::new(&root), &opts)))
        })
        .async_function("kinds", |a| {
            let root = a.get(0).map(from_host).and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
            let rels = strings(a.get(1));
            Ok(off_thread(move || Ok(kinds(Path::new(&root), &rels))))
        })
        .async_function("copyFile", |a| {
            let src = a.get(0).map(from_host).and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
            let dir = a.get(1).map(from_host).and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
            let max = a.get(2).map(from_host).and_then(|v| v.as_u64()).unwrap_or(u64::MAX);
            Ok(off_thread(move || copy_file(Path::new(&src), Path::new(&dir), max)))
        })
}

fn strings(v: Option<&HostValue>) -> Vec<String> {
    v.map(from_host).and_then(|v| v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())).unwrap_or_default()
}

fn names(v: &Value) -> HashSet<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_lowercase)).collect()).unwrap_or_default()
}

/// Runs `f` on a thread of its own; the script's promise settles with its answer.
fn off_thread(
    f: impl FnOnce() -> Result<Value, String> + Send + 'static,
) -> impl std::future::Future<Output = Result<HostValue, HostError>> + Send {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::spawn(move || {
        let _ = tx.send_blocking(f());
    });
    async move {
        let v = rx.recv().await.map_err(|_| HostError::new("the disk read was lost"))?.map_err(HostError::new)?;
        Ok(to_host(&v))
    }
}

/// A link (symlink or junction) to a folder is a folder; a dangling one is a file.
fn is_dir_following(path: &Path, link: bool, dir: bool) -> bool {
    if link { std::fs::metadata(path).is_ok_and(|m| m.is_dir()) } else { dir }
}

/// Folders first, then natural order ignoring case ("file2" before "file10"), then the name.
fn natural(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let (mut n, mut m) = (String::new(), String::new());
                while let Some(c) = x.peek().copied().filter(char::is_ascii_digit) { n.push(c); x.next(); }
                while let Some(d) = y.peek().copied().filter(char::is_ascii_digit) { m.push(d); y.next(); }
                let (n, m) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let o = n.len().cmp(&m.len()).then_with(|| n.cmp(m));
                if o != Ordering::Equal { return o; }
            }
            (Some(c), Some(d)) => {
                let o = c.to_lowercase().cmp(d.to_lowercase());
                if o != Ordering::Equal { return o; }
                x.next();
                y.next();
            }
        }
    }
}

/// One folder: { path, entries: [{name, dir}] (folders first, natural order, the first `limit`),
/// more } or { path, error }. `.git` is left out.
fn list_dir(path: &str, limit: usize) -> Value {
    let read = match std::fs::read_dir(path) {
        Ok(r) => r,
        Err(e) => return json!({ "path": path, "error": format!("Cannot open this folder: {e}") }),
    };
    let mut list: Vec<(String, bool)> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let Ok(t) = entry.file_type() else { continue };
        list.push((name, is_dir_following(&entry.path(), t.is_symlink(), t.is_dir())));
        // Enough to sort and cut, as the mod did (it read limit + 1).
        if list.len() > limit.saturating_mul(4).max(limit + 1) {
            break;
        }
    }
    list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| natural(&a.0, &b.0)));
    let more = list.len() > limit;
    list.truncate(limit);
    let entries: Vec<Value> = list.into_iter().map(|(name, dir)| json!({ "name": name, "dir": dir })).collect();
    json!({ "path": path, "entries": entries, "more": more })
}

struct WalkOptions {
    depth: usize,
    prune: HashSet<String>,
    top_prune: HashSet<String>,
    max_dirs: usize,
    max_files: usize,
}

/// Every path below root, breadth first: { dirs: [rel], files: [rel], cut: ["dirs"|"files"] },
/// "/"-separated. A pruned folder or a link to one is listed but not entered; `.git` is skipped.
fn walk(root: &Path, o: &WalkOptions) -> Result<Value, String> {
    std::fs::read_dir(root).map_err(|e| format!("Cannot read this folder: {e}"))?;
    let (mut dirs, mut files) = (Vec::new(), Vec::new());
    let (mut cut_dirs, mut cut_files) = (false, false);
    let mut queue: VecDeque<(PathBuf, String, usize)> = VecDeque::from([(root.to_path_buf(), String::new(), 0)]);
    while let Some((dir, rel, level)) = queue.pop_front() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(t) = entry.file_type() else { continue };
            let link = t.is_symlink();
            if is_dir_following(&entry.path(), link, t.is_dir()) {
                if name == ".git" {
                    continue;
                }
                if dirs.len() >= o.max_dirs {
                    cut_dirs = true;
                    continue;
                }
                let low = name.to_lowercase();
                let enter = !link && !o.prune.contains(&low) && !(level == 0 && o.top_prune.contains(&low)) && level + 1 < o.depth;
                if enter {
                    queue.push_back((entry.path(), r.clone(), level + 1));
                }
                dirs.push(r);
            } else {
                if files.len() >= o.max_files {
                    cut_files = true;
                    continue;
                }
                files.push(r);
            }
        }
    }
    let cut: Vec<&str> = [(cut_dirs, "dirs"), (cut_files, "files")].into_iter().filter(|(c, _)| *c).map(|(_, n)| n).collect();
    Ok(json!({ "dirs": dirs, "files": files, "cut": cut }))
}

/// Which of rels (relative to root) exist: [[rel, "d" | "f"]]; missing ones are left out.
fn kinds(root: &Path, rels: &[String]) -> Value {
    Value::Array(
        rels.iter()
            .filter_map(|rel| std::fs::metadata(root.join(rel)).ok().map(|m| json!([rel, if m.is_dir() { "d" } else { "f" }])))
            .collect(),
    )
}

/// Copies one file into `dir` (made if missing), keeping its name, unless it is over `max`
/// bytes: { copied, size, missing }.
fn copy_file(src: &Path, dir: &Path, max: u64) -> Result<Value, String> {
    let meta = match std::fs::metadata(src) {
        Ok(m) if m.is_file() => m,
        _ => return Ok(json!({ "copied": false, "size": null, "missing": true })),
    };
    let size = meta.len();
    if size > max {
        return Ok(json!({ "copied": false, "size": size, "missing": false }));
    }
    let name = src.file_name().ok_or("no file name")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Cannot make the cache folder: {e}"))?;
    std::fs::copy(src, dir.join(name)).map_err(|e| format!("Cannot copy this file: {e}"))?;
    Ok(json!({ "copied": true, "size": size, "missing": false }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("herdr-fork-native-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn folders_first_in_natural_order_without_git() {
        let d = scratch("list");
        for f in ["file10.txt", "file2.txt", "B.txt", "a.txt"] {
            std::fs::write(d.join(f), "").unwrap();
        }
        for f in ["zeta", "Alpha", ".git"] {
            std::fs::create_dir(d.join(f)).unwrap();
        }
        let v = list_dir(d.to_str().unwrap(), 5000);
        let names: Vec<&str> = v["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Alpha", "zeta", "a.txt", "B.txt", "file2.txt", "file10.txt"]);
        assert_eq!(v["entries"][0]["dir"], true);
        assert_eq!(v["more"], false);
        let cut = list_dir(d.to_str().unwrap(), 2);
        assert_eq!(cut["entries"].as_array().unwrap().len(), 2);
        assert_eq!(cut["more"], true);
        assert!(list_dir(d.join("nope").to_str().unwrap(), 10)["error"].is_string());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn walk_prunes_limits_and_skips_git() {
        let d = scratch("walk");
        for p in ["src/deep/x", "node_modules/pkg", ".git/objects", "AppData/Local"] {
            std::fs::create_dir_all(d.join(p)).unwrap();
        }
        for f in ["src/a.rs", "src/deep/x/b.rs", "node_modules/pkg/i.js", "top.md"] {
            std::fs::write(d.join(f), "").unwrap();
        }
        let o = WalkOptions { depth: 12, prune: names(&json!(["node_modules"])), top_prune: names(&json!(["AppData"])), max_dirs: 100, max_files: 100 };
        let v = walk(&d, &o).unwrap();
        let has = |k: &str, p: &str| v[k].as_array().unwrap().iter().any(|x| x == p);
        assert!(has("dirs", "src/deep/x") && has("files", "src/deep/x/b.rs") && has("files", "top.md"));
        assert!(has("dirs", "node_modules") && !has("dirs", "node_modules/pkg"), "pruned: listed, not entered");
        assert!(has("dirs", "AppData") && !has("dirs", "AppData/Local"), "pruned at the top");
        assert!(!has("dirs", ".git"));
        let shallow = walk(&d, &WalkOptions { depth: 1, max_files: 0, ..o }).unwrap();
        assert!(!shallow["dirs"].as_array().unwrap().iter().any(|x| x == "src/deep"));
        assert_eq!(shallow["cut"], json!(["files"]));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn kinds_and_copies() {
        let d = scratch("kinds");
        std::fs::create_dir(d.join("sub")).unwrap();
        std::fs::write(d.join("f.png"), [1u8, 2, 3]).unwrap();
        assert_eq!(kinds(&d, &["sub".into(), "f.png".into(), "gone".into()]), json!([["sub", "d"], ["f.png", "f"]]));
        let c = copy_file(&d.join("f.png"), &d.join("cache/k"), 10).unwrap();
        assert_eq!(c, json!({ "copied": true, "size": 3, "missing": false }));
        assert_eq!(std::fs::read(d.join("cache/k/f.png")).unwrap(), [1, 2, 3]);
        assert_eq!(copy_file(&d.join("f.png"), &d.join("c2"), 2).unwrap()["copied"], false);
        assert_eq!(copy_file(&d.join("nope.png"), &d.join("c3"), 10).unwrap()["missing"], true);
        std::fs::remove_dir_all(&d).unwrap();
    }
}
