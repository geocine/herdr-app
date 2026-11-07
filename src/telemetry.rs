//! Anonymous usage data: off, always, in this fork (geocine). Nothing is
//! collected, kept or sent, whatever settings.json, `HERDR_TELEMETRY`,
//! `HERDR_TELEMETRY_URL` or `HERDR_APP_RELEASE` say. There is no endpoint,
//! no install id, no thread and no files.
//!
//! Upstream's module counted use once a day and sent it to
//! telemetry.herdr.dev. The functions the rest of the app calls are kept
//! (same names and signatures) so call sites and upstream merges stay
//! untouched, but each one does nothing. On start, `start` deletes what an
//! earlier build left in the app home's `telemetry/` folder (the id, the day
//! so far, unsent reports), and nothing else.
//!
//! When merging upstream, keep this file as it is.

use serde_json::{Value, json};
use std::path::Path;

/// What the window would report. Never built: `collecting` is always false.
#[derive(Default)]
#[allow(dead_code)]
pub struct Observation {
    pub foreground: bool,
    pub agents: Vec<Option<String>>,
    pub agents_working: usize,
    pub spaces: usize,
    pub tabs: usize,
    pub terminals: usize,
    pub layout: String,
    pub mods: Vec<String>,
    pub theme: String,
    pub welcome: Option<String>,
}

/// Never: nothing is collected in this build.
pub fn collecting() -> bool {
    false
}

pub fn observe(_o: Observation) {}

pub fn command(_name: &'static str) {}

pub fn count(_name: &'static str) {}

pub fn window_open() {}

/// settings.json's `telemetry` is ignored.
pub fn set_setting(_on: bool) {}

pub fn quit() {}

pub fn clock() {}

/// What the settings screen shows: off, for good.
pub fn status() -> Value {
    json!({
        "enabled": false,
        "setting": false,
        "off_because": null,
        "sends": false,
        "endpoint": null,
        "draft": null,
        "queued": [],
        "last_sent": null,
    })
}

/// Starts nothing (`setting` is ignored) and deletes earlier usage data.
pub fn start(_setting: bool) {
    forget(&crate::mods::app_dir());
}

/// Deletes `<app home>/telemetry` (the id, `today.json`, `queue/`...), and
/// only that: a link there is unlinked, never followed.
fn forget(app_home: &Path) {
    let dir = app_home.join("telemetry");
    match std::fs::symlink_metadata(&dir) {
        Ok(m) if m.is_dir() => {
            let _ = std::fs::remove_dir_all(&dir);
        }
        Ok(_) => {
            // A file, or a link (a directory link on Windows is removed as a directory).
            let _ = std::fs::remove_file(&dir).or_else(|_| std::fs::remove_dir(&dir));
        }
        Err(_) => {}
    }
}

/// A release version (`0.2.0`, `0.2.0-rc.1`), else `other`: never a free string.
/// (Used by feedback.rs.)
pub(crate) fn version(v: &str) -> String {
    let v = v.trim().trim_start_matches("hc ").trim_start_matches('v');
    let number = |s: &str| !s.is_empty() && s.len() <= 4 && s.bytes().all(|b| b.is_ascii_digit());
    let (core, pre) = v.split_once('-').map_or((v, None), |(c, p)| (c, Some(p)));
    let parts: Vec<&str> = core.split('.').collect();
    let pre_ok = pre.is_none_or(|p| {
        let (label, n) = p.split_once('.').map_or((p, None), |(l, n)| (l, Some(n)));
        matches!(label, "alpha" | "beta" | "rc" | "preview") && n.is_none_or(number)
    });
    if parts.len() == 3 && parts.iter().all(|p| number(p)) && pre_ok { v.to_owned() } else { "other".into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_releases_or_other() {
        assert_eq!(version("0.2.0"), "0.2.0");
        assert_eq!(version("hc 0.1.5"), "0.1.5");
        assert_eq!(version("0.2.0-rc.1"), "0.2.0-rc.1");
        assert_eq!(version("0.2.0-my/secret path"), "other");
        assert_eq!(version("hc 0.1.5-acmeclient"), "other");
        assert_eq!(version("0.1.5-rc.x"), "other");
        assert_eq!(version("dev"), "other");
    }

    #[test]
    fn forgetting_deletes_only_the_telemetry_folder() {
        let home = std::env::temp_dir().join(format!("herdr-telemetry-forget-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("telemetry").join("queue")).unwrap();
        std::fs::write(home.join("telemetry").join("id"), "0123456789abcdef0123456789abcdef").unwrap();
        std::fs::write(home.join("telemetry").join("today.json"), "{}").unwrap();
        std::fs::write(home.join("telemetry").join("queue").join("2026-10-19.json"), "{}").unwrap();
        std::fs::write(home.join("settings.json"), "{\"telemetry\": true}").unwrap();
        forget(&home);
        assert!(!home.join("telemetry").exists());
        assert!(home.join("settings.json").exists(), "nothing beside it goes");
        forget(&home); // nothing there: still fine
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Even with settings.json's `"telemetry": true` and `HERDR_TELEMETRY_URL`
    /// pointing at a listening server, nothing is collected, written or sent.
    /// Runs in a process of its own, on a fresh app home.
    #[test]
    fn nothing_is_collected_or_sent_even_when_asked() {
        const NAME: &str = "nothing_is_collected_or_sent_even_when_asked";
        if std::env::var("HERDR_TEST_TELEMETRY").as_deref() == Ok(NAME) {
            // The child: everything the app ever calls, telemetry asked for.
            assert!(!crate::settings::telemetry_setting(&crate::settings::load_person()));
            start(true);
            clock();
            set_setting(true);
            assert!(!collecting());
            observe(Observation { foreground: true, agents: vec![Some("claude-code".into())], ..Observation::default() });
            command("space.new");
            count("core_lost");
            window_open();
            quit();
            std::thread::sleep(std::time::Duration::from_millis(300));
            assert!(!collecting());
            let s = status();
            assert_eq!((s["enabled"].as_bool(), s["setting"].as_bool(), s["sends"].as_bool()), (Some(false), Some(false), Some(false)));
            assert!(s["draft"].is_null() && s["queued"].as_array().is_some_and(Vec::is_empty) && s["last_sent"].is_null());
            return;
        }
        let home = std::env::temp_dir().join(format!("herdr-telemetry-off-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("telemetry").join("queue")).unwrap();
        std::fs::write(home.join("telemetry").join("id"), "0123456789abcdef0123456789abcdef").unwrap();
        std::fs::write(home.join("telemetry").join("queue").join("2026-10-19.json"), "{\"v\":1}").unwrap();
        std::fs::write(home.join("settings.json"), "{\n  \"telemetry\": true\n}\n").unwrap();
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        server.set_nonblocking(true).unwrap();
        let url = format!("http://{}/v1/report", server.local_addr().unwrap());
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &format!("telemetry::tests::{NAME}"), "--nocapture", "--test-threads=1"])
            .env("HERDR_APP_HOME", &home)
            .env("HERDR_TEST_TELEMETRY", NAME)
            .env("HERDR_TELEMETRY_URL", &url)
            .env("HERDR_TELEMETRY", "1")
            .env_remove("DO_NOT_TRACK")
            .output()
            .unwrap();
        let log = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let connected = server.accept().is_ok();
        let left = home.join("telemetry").exists();
        let settings = std::fs::read_to_string(home.join("settings.json")).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&home);
        assert!(out.status.success() && log.contains("1 passed"), "{log}");
        assert!(!connected, "something reached the telemetry server");
        assert!(!left, "the old telemetry folder is still there, or a new one was made");
        assert!(settings.contains("\"telemetry\": true"), "settings.json is left as the person wrote it");
    }
}
