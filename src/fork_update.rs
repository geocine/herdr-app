//! This fork's own update notices (geocine/herdr-app). The fork never updates
//! itself (it's built without `HERDR_APP_RELEASE`, update.rs): these only tell,
//! in the corner and in Settings → Updates.
//!
//! - A newer fork release (on by default, settings.json `fork_updates.release`):
//!   GitHub's latest release of geocine/herdr-app. Its tag
//!   (`geocine-YYYYMMDD-HHMM`, scripts/fork-release.ps1) against this build's
//!   (`HERDR_BUILD_TAG`). A build from source has no release tag: GitHub
//!   compares the release with this build's commit. A commit GitHub doesn't
//!   know (not pushed) or histories that went separate ways (a rebase) tell
//!   nothing, so nothing shows in the corner.
//! - Upstream commits since this fork's base (off by default,
//!   `fork_updates.upstream`): GitHub's compare of each build's `upstream_sha`
//!   with upstream's master, for the app and (when it says) the core.
//!
//! On update.rs's clock (an hour), each kind only while its notice is on;
//! "Check for updates" (`app.check_updates`) checks both now. GitHub's API
//! without an account (60 requests an hour per address): at most four a
//! check, the answers kept in `.fork-updates.json` so a restart doesn't ask
//! again. Only a generic User-Agent goes out.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// The fork, its branch and how to install it (distribution/install-geocine.ps1).
pub const REPO: &str = "geocine/herdr-app";
const BRANCH: &str = "geocine";
pub const REPO_URL: &str = "https://github.com/geocine/herdr-app/tree/geocine";
pub const INSTALL: &str = r#"powershell -c "irm https://raw.githubusercontent.com/geocine/herdr-app/geocine/distribution/install-geocine.ps1 | iex""#;
const UPSTREAM_APP: &str = "herdrdev/herdr-app";
const UPSTREAM_CORE: &str = "herdrdev/herdr-core";
const API: &str = "https://api.github.com";
const AGENT: &str = "herdr-fork";

const EVERY: Duration = Duration::from_secs(60 * 60);
/// After a failed check (offline, GitHub's limit).
const RETRY: Duration = Duration::from_secs(30 * 60);

/// settings.json `fork_updates`: which notices show in the corner.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Notices {
    /// A newer release of this fork.
    pub release: bool,
    /// Upstream commits this fork isn't based on yet.
    pub upstream: bool,
}

impl Default for Notices {
    fn default() -> Self {
        Notices { release: true, upstream: false }
    }
}

impl Notices {
    pub fn is_default(&self) -> bool {
        *self == Notices::default()
    }
}

/// The latest fork release, and whether it's newer than this build (None: can't tell).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Release {
    pub tag: String,
    pub url: String,
    pub newer: Option<bool>,
    /// Why it can't tell.
    pub note: Option<String>,
    pub checked: u64,
}

/// Upstream commits since a build's base.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Behind {
    pub base: String,
    pub commits: u64,
    pub url: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Upstream {
    pub app: Option<Behind>,
    pub core: Option<Behind>,
    /// Why there's nothing to compare.
    pub note: Option<String>,
    pub checked: u64,
}

/// What the last checks found (`.fork-updates.json`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    /// When the last check ended (unix seconds), and what went wrong in it.
    pub checked: Option<u64>,
    pub error: Option<String>,
    pub release: Option<Release>,
    pub upstream: Option<Upstream>,
    /// Corner notices closed (`Notice::key`): they stay closed until there's news.
    pub dismissed: Vec<String>,
}

// ---- deciding --------------------------------------------------------------

/// The time in a fork release tag: `geocine-20261107-1559` → 202611071559.
fn stamp(tag: &str) -> Option<u64> {
    let (day, time) = tag.strip_prefix(BRANCH)?.strip_prefix('-')?.split_once('-')?;
    let digits = |s: &str, n| s.len() == n && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(day, 8) || !digits(time, 4) {
        return None;
    }
    format!("{day}{time}").parse().ok()
}

/// `latest` is a later fork release than `have`; None when either isn't one.
pub fn newer_tag(latest: &str, have: &str) -> Option<bool> {
    Some(stamp(latest)? > stamp(have)?)
}

/// What this build can be compared by: its release tag, else its commit.
#[derive(Debug, PartialEq)]
enum Have<'a> {
    Tag(&'a str),
    Commit(&'a str),
    Nothing,
}

fn have(build: Option<&crate::update::Build>) -> Have<'_> {
    let Some(b) = build else { return Have::Nothing };
    match (b.tag.as_deref().filter(|t| stamp(t).is_some()), b.sha.as_deref()) {
        (Some(tag), _) => Have::Tag(tag),
        (None, Some(sha)) => Have::Commit(sha),
        (None, None) => Have::Nothing,
    }
}

/// GitHub's compare of the release (base) with this build (head): newer when
/// the build is behind it; None when they went separate ways.
fn newer_by_commit(status: &str) -> Option<bool> {
    match status {
        "identical" | "ahead" => Some(false),
        "behind" => Some(true),
        _ => None,
    }
}

/// What shows in the corner, if anything: a newer release first, then upstream.
#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    /// Closing it remembers this until there's news.
    pub key: String,
    pub label: String,
    /// "See release" or "See commits", and where.
    pub link: (&'static str, String),
    /// A release: the line that installs it.
    pub install: bool,
}

pub fn notice_for(state: &State, on: Notices) -> Option<Notice> {
    let closed = |key: &str| state.dismissed.iter().any(|d| d == key);
    if on.release
        && let Some(r) = &state.release
        && r.newer == Some(true)
        && !closed(&format!("release:{}", r.tag))
    {
        return Some(Notice {
            key: format!("release:{}", r.tag),
            label: format!("{} is out. Run the install line again to update.", r.tag),
            link: ("See release", r.url.clone()),
            install: true,
        });
    }
    let up = state.upstream.as_ref().filter(|_| on.upstream)?;
    let commits = |b: &Option<Behind>| b.as_ref().map_or(0, |b| b.commits);
    let (app, core) = (commits(&up.app), commits(&up.core));
    let base = |b: &Option<Behind>| b.as_ref().map_or("", |b| b.base.as_str()).to_owned();
    // The counts are part of it: a closed one comes back once upstream has more.
    let key = format!("upstream:{}:{app}:{}:{core}", base(&up.app), base(&up.core));
    if app + core == 0 || closed(&key) {
        return None;
    }
    let n = |n: u64| format!("{n} new commit{}", if n == 1 { "" } else { "s" });
    let label = match (app, core) {
        (0, c) => format!("Upstream herdr-core has {} since this fork's base", n(c)),
        (a, 0) => format!("Upstream has {} since this fork's base", n(a)),
        (a, c) => format!("Upstream has {} for Herdr and {c} for herdr-core since this fork's base", n(a)),
    };
    let url = if app > 0 { &up.app } else { &up.core }.as_ref().map(|b| b.url.clone()).unwrap_or_default();
    Some(Notice { key, label, link: ("See commits", url), install: false })
}

/// A kind is due an hour after it was last checked (never checked: now).
fn due(checked: Option<u64>, now: u64) -> u64 {
    checked.map_or(now, |at| (at + EVERY.as_secs()).max(now))
}

/// When the next automatic check is due: the soonest of the kinds that are
/// on. None: nothing is on.
fn next_due(state: &State, on: Notices, now: u64) -> Option<u64> {
    let release = on.release.then(|| due(state.release.as_ref().map(|r| r.checked), now));
    let upstream = on.upstream.then(|| due(state.upstream.as_ref().map(|u| u.checked), now));
    release.into_iter().chain(upstream).min()
}

// ---- asking GitHub -----------------------------------------------------------

#[derive(Debug, PartialEq)]
enum Fail {
    Offline,
    Limited,
    NotFound,
    Other(String),
}

impl Fail {
    fn say(&self) -> String {
        match self {
            Fail::Offline => "Couldn't reach GitHub. Check your connection and try again.".into(),
            Fail::Limited => "GitHub's limit for checks without an account is used up. Try again in an hour.".into(),
            Fail::NotFound => "GitHub doesn't know this.".into(),
            Fail::Other(why) => format!("GitHub answered: {why}"),
        }
    }
}

/// A GET to GitHub's API: the JSON, or why not. curl's `-w` adds the status
/// on a line of its own.
fn get(api: &str, path: &str) -> Result<Value, Fail> {
    let url = format!("{api}{path}");
    let out = crate::spawn::command(crate::update::system("curl"))
        .args(["-sS", "--max-time", "20", "-A", AGENT, "-H", "Accept: application/vnd.github+json", "-w", "\n%{http_code}", &url])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Fail::Other(format!("curl: {e}")))?;
    if !out.status.success() {
        tracing::info!("fork update check: {url}: {}", String::from_utf8_lossy(&out.stderr).trim());
        return Err(Fail::Offline);
    }
    answer(&String::from_utf8_lossy(&out.stdout))
}

fn answer(text: &str) -> Result<Value, Fail> {
    let (body, code) = text.rsplit_once('\n').unwrap_or(("", text));
    let body: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let message = body["message"].as_str();
    match code.trim() {
        "200" => Ok(body),
        "404" | "422" => Err(Fail::NotFound),
        "429" => Err(Fail::Limited),
        "403" if message.is_some_and(|m| m.contains("rate limit")) => Err(Fail::Limited),
        code => Err(Fail::Other(message.map_or_else(|| code.to_owned(), |m| format!("{code} {m}")))),
    }
}

fn latest_release(api: &str, build: Option<&crate::update::Build>, now: u64) -> Result<Release, Fail> {
    let latest = get(api, &format!("/repos/{REPO}/releases/latest"))?;
    let tag = latest["tag_name"].as_str().ok_or(Fail::Other("a release without a tag".into()))?.to_owned();
    let url = latest["html_url"].as_str().unwrap_or_default().to_owned();
    let (newer, note) = match have(build) {
        Have::Tag(have) => (newer_tag(&tag, have), None),
        Have::Commit(sha) => match get(api, &format!("/repos/{REPO}/compare/{tag}...{sha}?per_page=1")) {
            Ok(compare) => match newer_by_commit(compare["status"].as_str().unwrap_or_default()) {
                Some(newer) => (Some(newer), None),
                None => (None, Some(format!("This build ({sha}) and {tag} went separate ways (a rebase), so Herdr can't tell which is newer."))),
            },
            Err(Fail::NotFound) => (None, Some(format!("This build's commit {sha} isn't on GitHub, so Herdr can't tell if {tag} is newer."))),
            Err(e) => return Err(e),
        },
        Have::Nothing => (None, Some(format!("This build doesn't say which commit it is, so Herdr can't tell if {tag} is newer."))),
    };
    Ok(Release { tag, url, newer, note, checked: now })
}

/// Upstream's commits since `base` (`compare/<base>...master`: master's ahead_by).
fn behind(api: &str, repo: &str, base: &str) -> Result<Behind, Fail> {
    let compare = get(api, &format!("/repos/{repo}/compare/{base}...master?per_page=1"))?;
    Ok(Behind {
        base: base.to_owned(),
        commits: compare["ahead_by"].as_u64().unwrap_or(0),
        url: compare["html_url"].as_str().map_or_else(|| format!("https://github.com/{repo}/compare/{base}...master"), str::to_owned),
    })
}

fn upstream(api: &str, app: Option<&crate::update::Build>, core: Option<&crate::update::Build>, now: u64) -> Result<Upstream, Fail> {
    let base = |b: Option<&crate::update::Build>| b.and_then(|b| b.upstream_sha.clone());
    let app = base(app).map(|sha| behind(api, UPSTREAM_APP, &sha)).transpose()?;
    let core = base(core).map(|sha| behind(api, UPSTREAM_CORE, &sha)).transpose()?;
    let note = (app.is_none() && core.is_none()).then(|| "These builds don't say which upstream commit they're based on.".to_owned());
    Ok(Upstream { app, core, note, checked: now })
}

/// Checks the kinds asked for, into `state`. Each kind keeps what it found
/// last when its check fails; the error is the check's.
fn check(api: &str, state: &mut State, release: bool, upstream_too: bool, now: u64) {
    let app = crate::update::Build::app();
    let core = crate::update::core().build;
    let mut error = None;
    if release {
        match latest_release(api, app.as_ref(), now) {
            Ok(found) => state.release = Some(found),
            Err(e) => error = Some(e),
        }
    }
    if upstream_too && error.as_ref().is_none_or(|e| *e != Fail::Offline && *e != Fail::Limited) {
        match upstream(api, app.as_ref(), core.as_ref(), now) {
            Ok(found) => state.upstream = Some(found),
            Err(e) => error = error.or(Some(e)),
        }
    }
    if let Some(e) = &error {
        tracing::info!("fork update check: {e:?}");
    }
    state.checked = Some(now);
    state.error = error.map(|e| e.say());
}

// ---- running -------------------------------------------------------------------

static STATE: Mutex<Option<State>> = Mutex::new(None);
static ON: Mutex<Notices> = Mutex::new(Notices { release: true, upstream: false });
/// Wakes the checker early: "Check for updates" (`ASKED`), or a notice turned on.
static WAKE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());
static ASKED: AtomicBool = AtomicBool::new(false);
static CHECKING: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);
/// The corner's "Copy install line" was pressed.
static COPIED: AtomicBool = AtomicBool::new(false);

fn file() -> std::path::PathBuf {
    crate::mods::app_dir().join(".fork-updates.json")
}

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut s = STATE.lock().unwrap();
    let state = s.get_or_insert_with(|| std::fs::read(file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default());
    f(state)
}

fn save(state: &State) {
    if let Ok(text) = serde_json::to_string_pretty(state) {
        let _ = crate::persist::write_atomic(&file(), text + "\n");
    }
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// settings.json's `fork_updates`, as the window reads it.
pub fn set_notices(on: Notices) {
    let was = std::mem::replace(&mut *ON.lock().unwrap(), on);
    // Turned on: look soon (the checker skips a kind checked within the hour).
    if (on.release && !was.release) || (on.upstream && !was.upstream) {
        wake();
    }
}

fn wake() {
    *WAKE.0.lock().unwrap() = true;
    WAKE.1.notify_all();
}

/// For Settings → Updates (`updates().fork`).
pub fn status() -> Value {
    let s = with_state(|s| s.clone());
    serde_json::json!({
        "repo": REPO, "repo_url": REPO_URL, "install": INSTALL,
        "checking": CHECKING.load(Ordering::Relaxed),
        "checked": s.checked, "error": s.error, "release": s.release, "upstream": s.upstream,
    })
}

pub fn notice() -> Option<Notice> {
    let on = *ON.lock().unwrap();
    with_state(|s| notice_for(s, on))
}

pub fn dismiss(key: &str) {
    COPIED.store(false, Ordering::Relaxed);
    with_state(|s| {
        if !s.dismissed.iter().any(|d| d == key) {
            // One upstream notice is closed at a time: the latest count replaces the last.
            if key.starts_with("upstream:") {
                s.dismissed.retain(|d| !d.starts_with("upstream:"));
            }
            s.dismissed.push(key.to_owned());
            save(s);
        }
    });
}

/// Checks both kinds now, whichever notices are on.
pub fn check_now() {
    if STARTED.load(Ordering::Relaxed) {
        CHECKING.store(true, Ordering::Relaxed);
    }
    ASKED.store(true, Ordering::Relaxed);
    wake();
}

/// Waits `d`, or until woken; true when "Check for updates" asked.
fn sleep(d: Duration) -> bool {
    let woken = WAKE.0.lock().unwrap();
    let (mut woken, _) = WAKE.1.wait_timeout_while(woken, d, |w| !*w).unwrap();
    *woken = false;
    ASKED.swap(false, Ordering::Relaxed)
}

/// Starts the checker (once).
pub fn start() {
    if STARTED.swap(true, Ordering::Relaxed) {
        return;
    }
    std::thread::spawn(|| {
        // After the window and the core are up, like update.rs; asked
        // meanwhile, that check runs at once.
        let start = std::time::Instant::now();
        let mut asked = false;
        while !asked && let Some(left) = Duration::from_secs(15).checked_sub(start.elapsed()) {
            asked = sleep(left);
        }
        loop {
            let on = crate::settings::load_person().map(|p| p.fork_updates).unwrap_or_else(|_| *ON.lock().unwrap());
            let now = now();
            let (release, upstream) = with_state(|s| {
                let now_due = |checked: Option<u64>| due(checked, now) <= now;
                (asked || on.release && now_due(s.release.as_ref().map(|r| r.checked)), asked || on.upstream && now_due(s.upstream.as_ref().map(|u| u.checked)))
            });
            if release || upstream {
                CHECKING.store(true, Ordering::Relaxed);
                let mut state = with_state(|s| s.clone());
                check(API, &mut state, release, upstream, now);
                with_state(|s| {
                    // Closed meanwhile: keep it.
                    state.dismissed = std::mem::take(&mut s.dismissed);
                    *s = state;
                    save(s);
                });
            }
            CHECKING.store(false, Ordering::Relaxed);
            let wait = with_state(|s| match (&s.error, next_due(s, on, now)) {
                (Some(_), _) if release || upstream => RETRY,
                (_, Some(at)) => Duration::from_secs((at - now).clamp(60, EVERY.as_secs())),
                (_, None) => EVERY,
            });
            asked = sleep(wait);
        }
    });
}

// ---- the corner ------------------------------------------------------------------

/// The corner pill for a fork notice, beside update.rs's: what's new, how to
/// get it, where the fork comes from.
pub fn pill(label: &str, cx: &mut gpui::Context<crate::window::AppWindow>) -> Option<gpui::AnyElement> {
    use gpui::prelude::FluentBuilder as _;
    use gpui::{FontWeight, InteractiveElement as _, IntoElement as _, ParentElement as _, StatefulInteractiveElement as _, Styled as _, div};
    use crate::settings::{color_or_literal as c, z};
    let n = notice().filter(|n| n.label == label)?;
    let link = |id: &'static str, text: &'static str, url: String| {
        div().id(id).px(z(6.0)).cursor_pointer().text_color(c("accent")).child(text).on_click(move |_, _, cx| cx.open_url(&url))
    };
    let copied = COPIED.load(Ordering::Relaxed);
    let key = n.key.clone();
    let pill = div()
        .absolute()
        .right(z(16.0))
        .bottom(z(16.0))
        .h(z(34.0))
        .pl(z(14.0))
        .pr(z(6.0))
        .flex()
        .items_center()
        .gap(z(6.0))
        .bg(c("popover"))
        .border_1()
        .border_color(c("border"))
        .rounded_full()
        .shadow_lg()
        .occlude()
        .text_size(z(13.0))
        .child(div().pr(z(4.0)).text_color(c("foreground")).child(n.label.clone()))
        .when(n.install, |pill| {
            pill.child(
                div()
                    .id("fork-update-copy")
                    .h(z(24.0))
                    .px(z(10.0))
                    .flex()
                    .items_center()
                    .rounded_full()
                    .cursor_pointer()
                    .bg(c("accent"))
                    .text_color(c("accent_foreground"))
                    .font_weight(FontWeight::SEMIBOLD)
                    .hover(|s| s.opacity(0.9))
                    .child(if copied { "Copied" } else { "Copy install line" })
                    .on_click(cx.listener(|_, _, _, cx| {
                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(INSTALL.into()));
                        COPIED.store(true, Ordering::Relaxed);
                        cx.notify();
                    })),
            )
        })
        .child(link("fork-update-link", n.link.0, n.link.1.clone()))
        .child(link("fork-update-repo", "From geocine/herdr-app", REPO_URL.into()))
        .child(
            div()
                .id("fork-update-dismiss")
                .size(z(24.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .cursor_pointer()
                .text_color(c("dim"))
                .hover(|s| s.bg(c("raised")).text_color(c("foreground")))
                .child("×")
                .on_click(cx.listener(move |_, _, _, cx| {
                    dismiss(&key);
                    cx.notify();
                })),
        );
    Some(pill.into_any_element())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::Build;

    #[test]
    fn notices_come_from_settings_json() {
        let p: crate::settings::Person = serde_json::from_str(r#"{"fork_updates":{"upstream":true}}"#).unwrap();
        assert_eq!(p.fork_updates, Notices { release: true, upstream: true });
        let p: crate::settings::Person = serde_json::from_str("{}").unwrap();
        assert_eq!(p.fork_updates, Notices { release: true, upstream: false });
        // The defaults aren't written back.
        assert!(serde_json::to_value(&p).unwrap().get("fork_updates").is_none());
    }

    #[test]
    fn fork_tags_compare_by_their_time() {
        assert_eq!(stamp("geocine-20261107-1559"), Some(202611071559));
        assert_eq!(newer_tag("geocine-20261107-1559", "geocine-20261106-2310"), Some(true));
        assert_eq!(newer_tag("geocine-20261106-2310", "geocine-20261107-1559"), Some(false));
        assert_eq!(newer_tag("geocine-20261107-1559", "geocine-20261107-1559"), Some(false));
        // A later year beats a later month or day.
        assert_eq!(newer_tag("geocine-20270101-0000", "geocine-20261231-2359"), Some(true));
        for odd in ["v0.1.13", "geocine-2026117-1559", "geocine-20261107-15x9", "geocinex-20261107-1559", "geocine-20261107", ""] {
            assert_eq!(newer_tag("geocine-20261107-1559", odd), None, "{odd}");
            assert_eq!(newer_tag(odd, "geocine-20261107-1559"), None, "{odd}");
        }
    }

    #[test]
    fn a_build_compares_by_its_release_tag_else_its_commit() {
        let build = |tag: Option<&str>, sha: Option<&str>| Build { tag: tag.map(Into::into), sha: sha.map(Into::into), ..Build::default() };
        assert_eq!(have(Some(&build(Some("geocine-20261107-1559"), Some("abc1234")))), Have::Tag("geocine-20261107-1559"));
        // Upstream's own tag isn't a fork release: the commit decides.
        assert_eq!(have(Some(&build(Some("v0.1.13"), Some("abc1234")))), Have::Commit("abc1234"));
        assert_eq!(have(Some(&build(None, Some("abc1234")))), Have::Commit("abc1234"));
        assert_eq!(have(Some(&build(None, None))), Have::Nothing);
        assert_eq!(have(None), Have::Nothing);
        assert_eq!(newer_by_commit("behind"), Some(true));
        assert_eq!(newer_by_commit("identical"), Some(false));
        assert_eq!(newer_by_commit("ahead"), Some(false));
        assert_eq!(newer_by_commit("diverged"), None);
    }

    fn release(newer: Option<bool>) -> Release {
        Release { tag: "geocine-20261107-1559".into(), url: "https://github.com/geocine/herdr-app/releases/tag/geocine-20261107-1559".into(), newer, note: None, checked: 1 }
    }

    fn upstream_of(app: u64, core: Option<u64>) -> Upstream {
        let b = |repo: &str, base: &str, commits| Behind { base: base.into(), commits, url: format!("https://github.com/{repo}/compare/{base}...master") };
        Upstream { app: Some(b(UPSTREAM_APP, "cfcf836", app)), core: core.map(|c| b(UPSTREAM_CORE, "c6b316f", c)), note: None, checked: 1 }
    }

    #[test]
    fn a_newer_release_shows_while_its_notice_is_on() {
        let on = Notices::default();
        let mut state = State { release: Some(release(Some(true))), ..State::default() };
        let n = notice_for(&state, on).unwrap();
        assert_eq!(n.label, "geocine-20261107-1559 is out. Run the install line again to update.");
        assert_eq!(n.link, ("See release", "https://github.com/geocine/herdr-app/releases/tag/geocine-20261107-1559".into()));
        assert!(n.install);
        assert_eq!(notice_for(&state, Notices { release: false, upstream: false }), None);
        // Not newer, or can't tell: nothing.
        for newer in [Some(false), None] {
            state.release = Some(release(newer));
            assert_eq!(notice_for(&state, on), None);
        }
        // Closed: until the next release.
        state.release = Some(release(Some(true)));
        state.dismissed = vec![n.key.clone()];
        assert_eq!(notice_for(&state, on), None);
        state.release.as_mut().unwrap().tag = "geocine-20261108-0900".into();
        assert!(notice_for(&state, on).is_some());
    }

    #[test]
    fn upstream_commits_show_only_when_asked() {
        let mut state = State { upstream: Some(upstream_of(5, None)), ..State::default() };
        assert_eq!(notice_for(&state, Notices::default()), None, "off by default");
        let on = Notices { release: true, upstream: true };
        let n = notice_for(&state, on).unwrap();
        assert_eq!(n.label, "Upstream has 5 new commits since this fork's base");
        assert_eq!(n.link, ("See commits", "https://github.com/herdrdev/herdr-app/compare/cfcf836...master".into()));
        assert!(!n.install);
        state.upstream = Some(upstream_of(1, Some(3)));
        assert_eq!(notice_for(&state, on).unwrap().label, "Upstream has 1 new commit for Herdr and 3 for herdr-core since this fork's base");
        state.upstream = Some(upstream_of(0, Some(1)));
        let n = notice_for(&state, on).unwrap();
        assert_eq!(n.label, "Upstream herdr-core has 1 new commit since this fork's base");
        assert_eq!(n.link.1, "https://github.com/herdrdev/herdr-core/compare/c6b316f...master");
        state.upstream = Some(upstream_of(0, Some(0)));
        assert_eq!(notice_for(&state, on), None);
        // Closed: until upstream has more commits, or the fork moves to a new base.
        state.upstream = Some(upstream_of(5, Some(2)));
        state.dismissed = vec![notice_for(&state, on).unwrap().key];
        assert_eq!(notice_for(&state, on), None);
        state.upstream.as_mut().unwrap().app.as_mut().unwrap().commits = 6;
        assert_eq!(notice_for(&state, on).unwrap().label, "Upstream has 6 new commits for Herdr and 2 for herdr-core since this fork's base");
        state.dismissed = vec![notice_for(&state, on).unwrap().key];
        state.upstream.as_mut().unwrap().core.as_mut().unwrap().commits = 3;
        assert!(notice_for(&state, on).is_some(), "herdr-core's count grew");
        state.dismissed = vec![notice_for(&state, on).unwrap().key];
        state.upstream.as_mut().unwrap().app.as_mut().unwrap().base = "1234567".into();
        assert!(notice_for(&state, on).is_some());
        // A newer release comes first.
        state.release = Some(release(Some(true)));
        assert!(notice_for(&state, on).unwrap().install);
    }

    #[test]
    fn checks_come_an_hour_after_the_last_one_of_a_kind_that_is_on() {
        let hour = EVERY.as_secs();
        let mut state = State::default();
        assert_eq!(next_due(&state, Notices::default(), 100), Some(100), "never checked: now");
        assert_eq!(next_due(&state, Notices { release: false, upstream: false }, 100), None);
        state.release = Some(Release { checked: 1000, ..release(Some(false)) });
        assert_eq!(next_due(&state, Notices::default(), 1100), Some(1000 + hour));
        assert_eq!(next_due(&state, Notices::default(), 1000 + 2 * hour), Some(1000 + 2 * hour));
        state.upstream = Some(Upstream { checked: 500, ..Upstream::default() });
        assert_eq!(next_due(&state, Notices { release: true, upstream: true }, 600), Some(500 + hour));
    }

    #[test]
    fn github_answers_and_its_refusals() {
        assert_eq!(answer("{\"tag_name\":\"x\"}\n200"), Ok(serde_json::json!({"tag_name":"x"})));
        assert_eq!(answer("{\"message\":\"Not Found\"}\n404"), Err(Fail::NotFound));
        let limited = "{\"message\":\"API rate limit exceeded for 1.2.3.4. (But here's the good news: ...)\"}\n403";
        assert_eq!(answer(limited), Err(Fail::Limited));
        assert_eq!(answer("\n429"), Err(Fail::Limited));
        assert_eq!(answer("{\"message\":\"Server Error\"}\n500"), Err(Fail::Other("500 Server Error".into())));
        assert_eq!(answer("{\"message\":\"Forbidden\"}\n403"), Err(Fail::Other("403 Forbidden".into())));
        assert!(Fail::Limited.say().contains("Try again in an hour"));
    }

    /// A local GitHub: the answers the checks parse, from requests they make.
    fn serve(answers: Vec<(&'static str, &'static str)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut asked = Vec::new();
            for (path, body) in answers {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let request = String::from_utf8_lossy(&request).into_owned();
                assert!(request.starts_with(&format!("GET {path} HTTP/1.1\r\n")), "{request}");
                assert!(request.contains("User-Agent: herdr-fork\r\n"), "{request}");
                asked.push(request);
                let status = if body.contains("Not Found") { "404 Not Found" } else { "200 OK" };
                write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            asked
        });
        (url, server)
    }

    #[test]
    fn a_release_is_compared_by_tag_or_by_commit() {
        let latest = r#"{"tag_name":"geocine-20261107-1559","html_url":"https://github.com/geocine/herdr-app/releases/tag/geocine-20261107-1559","target_commitish":"geocine"}"#;
        let (url, server) = serve(vec![
            ("/repos/geocine/herdr-app/releases/latest", latest),
            ("/repos/geocine/herdr-app/releases/latest", latest),
            ("/repos/geocine/herdr-app/compare/geocine-20261107-1559...abc1234?per_page=1", r#"{"status":"behind","ahead_by":0,"behind_by":3}"#),
            ("/repos/geocine/herdr-app/releases/latest", latest),
            ("/repos/geocine/herdr-app/compare/geocine-20261107-1559...fff0000?per_page=1", r#"{"message":"Not Found"}"#),
        ]);
        let tagged = Build { tag: Some("geocine-20261106-2310".into()), sha: Some("9ca8e09".into()), ..Build::default() };
        let r = latest_release(&url, Some(&tagged), 7).unwrap();
        assert_eq!((r.tag.as_str(), r.newer, r.note.as_deref(), r.checked), ("geocine-20261107-1559", Some(true), None, 7));
        assert_eq!(r.url, "https://github.com/geocine/herdr-app/releases/tag/geocine-20261107-1559");
        let source = Build { sha: Some("abc1234".into()), ..Build::default() };
        assert_eq!(latest_release(&url, Some(&source), 7).unwrap().newer, Some(true));
        let local = Build { sha: Some("fff0000".into()), ..Build::default() };
        let r = latest_release(&url, Some(&local), 7).unwrap();
        assert_eq!(r.newer, None);
        assert_eq!(r.note.as_deref(), Some("This build's commit fff0000 isn't on GitHub, so Herdr can't tell if geocine-20261107-1559 is newer."));
        server.join().unwrap();
    }

    #[test]
    fn upstream_counts_master_since_each_base() {
        let (url, server) = serve(vec![
            ("/repos/herdrdev/herdr-app/compare/cfcf836...master?per_page=1", r#"{"status":"ahead","ahead_by":5,"behind_by":0,"html_url":"https://github.com/herdrdev/herdr-app/compare/cfcf836...master"}"#),
            ("/repos/herdrdev/herdr-core/compare/c6b316f...master?per_page=1", r#"{"status":"identical","ahead_by":0,"behind_by":0}"#),
        ]);
        let app = Build { upstream_sha: Some("cfcf836".into()), ..Build::default() };
        let core = Build { upstream_sha: Some("c6b316f".into()), ..Build::default() };
        let up = upstream(&url, Some(&app), Some(&core), 9).unwrap();
        assert_eq!(up.app, Some(Behind { base: "cfcf836".into(), commits: 5, url: "https://github.com/herdrdev/herdr-app/compare/cfcf836...master".into() }));
        assert_eq!(up.core.as_ref().map(|c| (c.commits, c.url.as_str())), Some((0, "https://github.com/herdrdev/herdr-core/compare/c6b316f...master")));
        assert_eq!((up.note, up.checked), (None, 9));
        server.join().unwrap();
        // Nothing to compare: no requests.
        assert!(upstream("http://127.0.0.1:9", None, Some(&Build::default()), 9).unwrap().note.is_some());
    }

    #[test]
    fn offline_is_said_quietly() {
        // Nothing listens on port 9 (discard): curl fails at once.
        assert_eq!(get("http://127.0.0.1:9", "/repos/geocine/herdr-app/releases/latest"), Err(Fail::Offline));
    }

    #[test]
    #[ignore = "asks the real GitHub (read-only, four requests)"]
    fn live_github_answers_parse() {
        let r = latest_release(API, None, 1).unwrap();
        assert!(stamp(&r.tag).is_some(), "{r:?}");
        assert!(r.url.starts_with("https://github.com/geocine/herdr-app/releases/tag/"), "{r:?}");
        let sha = Build { sha: Some(r.tag.clone()), ..Build::default() };
        assert_eq!(latest_release(API, Some(&sha), 1).unwrap().newer, Some(false));
        let b = behind(API, UPSTREAM_APP, "adf94cb").unwrap();
        assert!(b.url.starts_with("https://github.com/herdrdev/herdr-app/compare/"), "{b:?}");
        eprintln!("{r:?}\n{b:?}");
    }
}
