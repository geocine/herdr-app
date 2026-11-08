// What is on disk: one folder's entries (lazy, for the tree) and a list of every path below the
// shown folder (for search outside a repo, or with ignored files). Here, on another machine
// (`on`), and on Windows: PowerShell there (this computer, or a Windows machine without sh).
//
// listDir follows Herdr's `files` mod and carstenlucke/herdr-roundup `roundup-files/disk.js`
// (Apache-2.0); the sh index follows cybertron288/herdr-mods `filetree` (MIT), itself a port of
// claude-code-filetree (MIT). The PowerShell index is new here. See NOTICE.md.
import { exec, window, home } from "herdr";

// The tree is a virtual list, so a long folder (node_modules) shows whole up to PER_FOLDER.
// listDir reads at most READ_AT_MOST entries and sorts them before cutting; the sort is one native
// string sort (see sortEntries), about 25 ms for 5,000 names, inside a task's ~50 ms.
export const PER_FOLDER = 5000;
const READ_AT_MOST = 5001;
// Search on disk: folders it never enters, how deep and how much it reads.
export const PRUNE = [".git", "node_modules", "target", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".nuxt", ".cache", ".gradle", ".idea", "vendor", "Pods", ".tox", ".mypy_cache", ".pytest_cache", "coverage", "$RECYCLE.BIN", "System Volume Information"];
const HOME_PRUNE = ["Library", "AppData", ".Trash", "scoop", "OneDrive"];
export const INDEX_DIRS = 20000, INDEX_PATHS = 40000;
const DEPTH = 12, HOME_DEPTH = 5;

const localWindows = (on) => !on && window()?.platform === "windows";
// PowerShell reads curly single quotes as quotes too, so they're doubled like '.
export const psQuote = (s) => "'" + String(s).replace(/['‘’‚‛]/g, "$&$&") + "'";
const noSh = (e) => String(e?.message ?? e).includes("cannot start sh");
const UTF8 = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);";
// Windows PowerShell 5.1 is always there; pwsh is faster to start when present, but optional.
async function powershell(script, on, timeout) {
  return exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `${UTF8} ${script}`], { on, timeout });
}

// Natural order, case-insensitive ("file2" before "file10").
export function compare(a, b) {
  const x = a.toLowerCase().match(/\d+|\D+/g) ?? [], y = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const nx = /^\d/.test(x[i]), ny = /^\d/.test(y[i]);
    if (nx && ny && (Number(x[i]) !== Number(y[i]) || x[i].length !== y[i].length)) return Number(x[i]) - Number(y[i]) || x[i].length - y[i].length;
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length || (a < b ? -1 : a > b ? 1 : 0);
}
// The same order as compare (folders first), without a script comparator: each name gets a key
// (lower case, digit runs zero-padded) and the keys go through one native sort. A comparator
// sort of a few thousand names runs past a task's time budget and is interrupted.
const natKey = (name) => name.toLowerCase().replace(/\d+/g, (d) => (d.length >= 20 ? d : d.padStart(20, "0")));
export function sortEntries(list) {
  const keys = list.map((e, i) => `${e.dir ? "0" : "1"}${natKey(e.name)}\0${e.name}\0${i}`);
  keys.sort();
  return keys.map((k) => list[Number(k.slice(k.lastIndexOf("\0") + 1))]);
}
const finish = (list) => {
  const kept = list.filter((e) => e && e.name && e.name !== ".git");
  return { entries: sortEntries(kept).slice(0, PER_FOLDER), more: kept.length > PER_FOLDER };
};

// ── listing folders on this Windows computer ──────────────────────────────────────────────
// PowerShell takes ~0.5 s just to start, on every folder opened. Git for Windows' sh and ls
// list one in ~70 ms with exact Unicode names, and several folders in one process; `-L` makes a
// link to a folder a folder and a dangling link a file, as before. Without them, cmd's dir
// (~65 ms), unless a name falls outside the code page (it prints "?"), then PowerShell.
const SHELLS = () => ["sh", "C:/Program Files/Git/usr/bin/sh.exe", "C:/Program Files/Git/bin/sh.exe",
  `${home()}/AppData/Local/Programs/Git/usr/bin/sh.exe`, `${home()}/scoop/apps/git/current/usr/bin/sh.exe`];
// The answer is shared by every copy of the mod (found once per run): the sh that works, or null.
// Only the answer: a search in flight belongs to the copy that started it, and would never settle
// for the others if that copy closed (so two asks at the very start may both search).
let gitSh;
export async function windowsSh() {
  if (gitSh !== undefined) return gitSh;
  for (const sh of SHELLS()) {
    try {
      const r = await exec(sh, ["-c", "/usr/bin/ls -A -p -L -U -- . >/dev/null && echo geocine-ok"], { cwd: home(), timeout: 5000 });
      if (r.stdout.includes("geocine-ok")) return (gitSh = sh);
    } catch {}
  }
  return (gitSh = null);
}
// One ls for all the folders: with more than one argument it heads each folder's entries with
// "<folder>:" ("name/" for a folder in them). /dev/null goes first so even one folder gets its
// heading (a file argument is printed before the folders and skipped). ":" can't be in a Windows
// name, so a line ending in ":" is a heading; a folder without one couldn't be listed. ls starts
// once: a shell loop would start ls per folder, ~50 ms each under Git's runtime.
// Paths go inside the -c script as quoted sh words, never as arguments of their own: Git's sh (an
// MSYS program) parses its Windows command line itself, and the app passes an argument without
// spaces unquoted, so "it's" would open a quote that swallows every later path, and "[x]" or
// "{a,b}" would be globbed into other folders. The script has spaces, so it arrives in double
// quotes, where every character is literal; sh then reads the single-quoted words exactly.
const shWord = (s) => `'${String(s).replace(/'/g, `'"'"'`)}'`;
// The command line has a limit (32k characters on Windows): runs of paths that fit (a `"` costs
// two characters there).
function pieces(paths, max = 24000) {
  const out = [];
  let cur = [], len = 0;
  for (const p of paths) {
    const w = shWord(p), n = w.length + (w.match(/"/g)?.length ?? 0) + 1;
    if (cur.length && len + n > max) { out.push(cur); cur = []; len = 0; }
    cur.push(p); len += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
// exec keeps 8 MiB of output: past this many characters (at most 3 bytes each), folders missing
// from it may have been cut off.
const NEAR_FULL = 2700000;

async function shMany(sh, paths) {
  const found = new Map();
  for (const piece of pieces(paths)) {
    const script = `/usr/bin/ls -A -p -L -U -- /dev/null ${piece.map(shWord).join(" ")} 2>/dev/null; :`;
    const r = await exec(sh, ["-c", script], { timeout: 30000 });
    const heads = new Map(piece.map((p) => [`${p}:`, p]));
    let cur = null, list = null;
    const done = () => { if (cur !== null) found.set(cur, finish(list)); };
    for (const line of r.stdout.split("\n")) {
      if (!line) continue;
      if (line.endsWith(":")) { done(); cur = heads.get(line) ?? null; list = []; continue; }
      if (cur === null || list.length >= READ_AT_MOST) continue;
      list.push(line.endsWith("/") ? { name: line.slice(0, -1), dir: true } : { name: line, dir: false });
    }
    done();
    const missing = piece.filter((p) => !found.has(p));
    // Huge folders filled the output: the ones after them are listed one by one.
    if (missing.length && piece.length > 1 && r.stdout.length >= NEAR_FULL) {
      for (const p of missing) for (const [k, v] of await shMany(sh, [p])) found.set(k, v);
    }
    for (const p of piece) if (!found.has(p)) found.set(p, new Error("Cannot open this folder"));
  }
  return found;
}

async function viaPowerShell(path, on) {
  // Links keep directory attributes even when dangling: check their target. Other reparse
  // points (OneDrive's folders) have no LinkType and are folders.
  const r = await powershell(`& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First ${READ_AT_MOST} | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } ${psQuote(path)}`, on);
  if (r.code !== 0) throw new Error((r.stderr || "Cannot list this folder").trim().split(/\r?\n/)[0]);
  const out = JSON.parse(r.stdout || "[]");
  return Array.isArray(out) ? out : [out];
}

// cmd's dir, in the folder itself (cwd: no path on its command line to quote). cmd can't stand in
// a network folder (\\host\share): it would list C:\Windows instead.
async function viaCmd(path) {
  if (/^[\\/]{2}/.test(path)) return viaPowerShell(path, null);
  const r = await exec("cmd", ["/d", "/s", "/c", "dir /b /a:d & echo //// & dir /b /a:-d"], { cwd: path, timeout: 30000 });
  if (/[?\uFFFD]/.test(r.stdout)) return viaPowerShell(path, null);
  const list = [];
  let dir = true;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.trim() === "////") { dir = false; continue; }
    if (line) list.push({ name: line, dir });
  }
  return list;
}

// Several folders (absolute, "/"-separated) at once: Map path → { entries, more } or an Error.
// One process for all of them on this Windows computer when Git's sh is there.
export async function listDirs(paths, on) {
  const out = new Map();
  if (!paths.length) return out;
  if (localWindows(on)) {
    const sh = await windowsSh();
    if (sh) {
      try { return await shMany(sh, paths); } catch {}
    }
  }
  await Promise.all(paths.map((p) => listDir(p, on).then((r) => out.set(p, r), (e) => out.set(p, e instanceof Error ? e : new Error(String(e))))));
  return out;
}

// Whether listDirs lists many folders for the price of one (worth reading ahead).
export async function cheapMany(on) { return localWindows(on) && Boolean(await windowsSh()); }

// One folder: { entries: [{ name, dir }] (folders first, natural order, the first PER_FOLDER),
// more: it held more }. `.git` is left out. A link to a folder is a folder.
export async function listDir(path, on) {
  let list;
  if (localWindows(on)) {
    const sh = await windowsSh();
    if (sh) {
      const r = (await shMany(sh, [path]).catch(() => null))?.get(path);
      if (r instanceof Error) throw r;
      if (r) return r;
    }
    list = await viaCmd(path).catch(() => viaPowerShell(path, on));
  } else {
    const script = `n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=\${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -ge ${READ_AT_MOST} ] && break; done; test -d "$1"`;
    let r;
    try { r = await exec("sh", ["-c", script, "geocine-files", path], { on }); }
    catch (e) { if (on && noSh(e)) list = await viaPowerShell(path, on); else throw e; }
    if (!list) {
      if (r.code !== 0) throw new Error((r.stderr || "Cannot list this folder").trim());
      const f = r.stdout.split("\0");
      list = [];
      for (let i = 0; i + 1 < f.length; i += 2) list.push({ name: f[i + 1], dir: f[i] === "d" });
    }
  }
  return finish(list);
}

const trim = (p) => String(p).replace(/[\\/]+$/, "");
const atHome = (root, homeDir) => {
  const r = trim(root).replace(/\\/g, "/").toLowerCase();
  return r === "" || /^[a-z]:$/.test(r) || (homeDir && r === trim(homeDir).replace(/\\/g, "/").toLowerCase());
};

// Every path below root from the disk: { dirs: Set, all: [rel], full, cut }. Skips PRUNE (and at
// home or a drive's top, HOME_PRUNE at its top level), DEPTH levels (HOME_DEPTH at home), at most
// INDEX_DIRS folders and INDEX_PATHS files. Links to folders are listed, not followed.
export async function diskIndex(root, on, homeDir) {
  const home = atHome(root, on ? null : homeDir);
  const depth = home ? HOME_DEPTH : DEPTH;
  if (localWindows(on)) return windowsIndex(root, on, depth, home);
  try { return await shIndex(root, on, depth, home); }
  catch (e) { if (on && noSh(e)) return windowsIndex(root, on, depth, home); throw e; }
}

// A breadth-first walk with .NET: a pruned or linked folder is listed but not entered.
// Lines: "d<rel>" or "f<rel>", "/"-separated; "!dirs" / "!files" when a limit cut it short.
async function windowsIndex(root, on, depth, home) {
  const prune = PRUNE.map(psQuote).join(","), top = home ? HOME_PRUNE.map(psQuote).join(",") : "";
  const script = `& { param($root)
    $prune = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); foreach ($n in @(${prune})) { [void]$prune.Add($n) }
    $top = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); foreach ($n in @(${top})) { [void]$top.Add($n) }
    $out = [Text.StringBuilder]::new(); $nd = 0; $nf = 0; $cutD = $false; $cutF = $false
    $queue = [Collections.Generic.Queue[object]]::new(); $queue.Enqueue(@([IO.DirectoryInfo]::new($root), '', 0))
    while ($queue.Count -gt 0) {
      $item = $queue.Dequeue(); $dir = $item[0]; $rel = $item[1]; $level = $item[2]
      try { $kids = $dir.EnumerateFileSystemInfos() } catch { continue }
      try {
        foreach ($k in $kids) {
          $name = $k.Name; $r = if ($rel) { $rel + '/' + $name } else { $name }
          if ($k -is [IO.DirectoryInfo]) {
            if ($name -eq '.git') { continue }
            if ($nd -ge ${INDEX_DIRS}) { $cutD = $true; continue }
            $nd++; [void]$out.Append('d').Append($r).Append([char]0)
            $link = ($k.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $k.LinkType
            if (-not $link -and -not $prune.Contains($name) -and -not ($level -eq 0 -and $top.Contains($name)) -and $level + 1 -lt ${depth}) { $queue.Enqueue(@($k, $r, ($level + 1))) }
          } else {
            if ($nf -ge ${INDEX_PATHS}) { $cutF = $true; continue }
            $nf++; [void]$out.Append('f').Append($r).Append([char]0)
          }
        }
      } catch { }
    }
    if ($cutD) { [void]$out.Append('!dirs').Append([char]0) }
    if ($cutF) { [void]$out.Append('!files').Append([char]0) }
    [Console]::Out.Write($out.ToString())
  } ${psQuote(root)}`;
  const r = await powershell(script.replace(/\n\s*/g, "\n"), on, 60000);
  if (r.code !== 0) throw new Error((r.stderr || "Cannot read this folder").trim().split(/\r?\n/)[0]);
  return parseIndex(r.stdout, "\0");
}

async function shIndex(root, on, depth, home) {
  const top = !home ? [] : HOME_PRUNE.map((n) => `-path './${n}'`);
  const names = [...PRUNE.map((n) => `-name '${n}'`), ...top].join(" -o ");
  const skip = `-type d \\( ${names} \\) -prune -o`;
  // NUL-separated (a name may hold a newline); head on NUL records via a tr swap.
  const cut = `cut() { tr '\\000\\n' '\\n\\000' | head -n "$1" | tr '\\n\\000' '\\000\\n'; }`;
  // Folders first, then a "//" record, then the rest.
  const script = `${cut}; cd "$1" || exit 3; find . -mindepth 1 -maxdepth ${depth} ${skip} -type d -print0 2>/dev/null | cut ${INDEX_DIRS + 1}; printf '//\\0'; find . -mindepth 1 -maxdepth ${depth} ${skip} ! -type d -print0 2>/dev/null | cut ${INDEX_PATHS + 1}`;
  const r = await exec("sh", ["-c", script, "geocine-files", root], { on, timeout: 60000 });
  if (r.code === 3) throw new Error("Cannot open this folder");
  let inDirs = true, nd = 0, nf = 0;
  const dirs = new Set(), all = [];
  for (const line of r.stdout.split("\0")) {
    if (line === "//") { inDirs = false; continue; }
    if (!line.startsWith("./")) continue;
    if (inDirs ? ++nd > INDEX_DIRS : ++nf > INDEX_PATHS) continue;
    const rel = line.slice(2);
    all.push(rel);
    if (inDirs) dirs.add(rel);
  }
  const cutBy = [...(nd > INDEX_DIRS ? ["dirs"] : []), ...(nf > INDEX_PATHS ? ["files"] : [])];
  return { dirs, all, full: !cutBy.length, cut: cutBy };
}

function parseIndex(stdout, sep) {
  const dirs = new Set(), all = [], cut = [];
  for (const rec of stdout.split(sep)) {
    if (!rec) continue;
    if (rec === "!dirs" || rec === "!files") { cut.push(rec.slice(1)); continue; }
    const rel = rec.slice(1);
    if (!rel) continue;
    all.push(rel);
    if (rec[0] === "d") dirs.add(rel);
  }
  return { dirs, all, full: !cut.length, cut };
}

// Which of rels (relative to root) exist: Map rel → "d" | "f"; missing ones are left out.
export async function kinds(root, rels, on) {
  const found = new Map();
  if (!rels.length) return found;
  const viaPowerShell = async () => {
    for (let i = 0; i < rels.length; i += 300) {
      const piece = rels.slice(i, i + 300).map(psQuote).join(",");
      const r = await powershell(`& { param($b) foreach ($r in @(${piece})) { $f = Join-Path $b $r; if (Test-Path -LiteralPath $f -PathType Container) { 'd' + $r } elseif (Test-Path -LiteralPath $f) { 'f' + $r } } } ${psQuote(root)}`, on);
      if (r.code !== 0) throw new Error(r.stderr || "Cannot open this folder");
      for (const line of r.stdout.split(/\r?\n/)) if (line.length > 1) found.set(line.slice(1), line[0]);
    }
    return found;
  };
  if (localWindows(on)) {
    // Git's ls: one process (PowerShell took ~0.5 s per 300 paths). A dangling link is left out.
    const sh = await windowsSh();
    if (!sh) return viaPowerShell();
    for (const piece of pieces(rels)) {
      // The paths go in the script, quoted (see shWord).
      const r = await exec(sh, ["-c", `cd -- ${shWord(root)} || exit 3; /usr/bin/ls -d -p -L -- ${piece.map(shWord).join(" ")} 2>/dev/null; :`], { timeout: 30000 });
      if (r.code === 3) throw new Error("Cannot open this folder");
      for (const line of r.stdout.split("\n")) if (line) found.set(line.endsWith("/") ? line.slice(0, -1) : line, line.endsWith("/") ? "d" : "f");
    }
    return found;
  }
  const script = `cd "$1" || exit 3; shift; for p; do if [ -d "$p" ]; then printf 'd%s\\0' "$p"; elif [ -e "$p" ] || [ -L "$p" ]; then printf 'f%s\\0' "$p"; fi; done`;
  for (let i = 0; i < rels.length; i += 2000) {
    let r;
    try { r = await exec("sh", ["-c", script, "geocine-files", root, ...rels.slice(i, i + 2000)], { on }); }
    catch (e) { if (on && noSh(e)) return viaPowerShell(); throw e; }
    if (r.code !== 0) throw new Error(r.stderr || "Cannot open this folder");
    for (const rec of r.stdout.split("\0")) if (rec.length > 1) found.set(rec.slice(1), rec[0]);
  }
  return found;
}
