//! Beta feedback: not supported in this fork (geocine). Nothing is ever sent,
//! to telemetry.herdr.dev or anywhere else, in any build, whatever
//! `HERDR_FEEDBACK_URL` or `HERDR_APP_RELEASE` say. There is no endpoint and
//! no request.
//!
//! The functions the rest of the app calls keep their names and signatures,
//! so call sites and upstream merges stay untouched: `send` and the
//! screenshot functions only answer `NOT_SUPPORTED`. `clear_shots` still
//! deletes screenshots an earlier build kept for its form.
//!
//! When merging upstream, keep this file as it is.
use serde_json::{Value, json};
use std::path::PathBuf;

/// What the person (or an agent) is told wherever feedback was offered.
pub const NOT_SUPPORTED: &str = "Feedback is not supported in this forked build.";

/// The draft the old form showed (local only: it never leaves the machine).
pub fn draft(message: &str, email: &str, images: usize, from: &str, layout: &str) -> Value {
    json!({
        "v": 1,
        "from": if from == "agent" { "agent" } else { "person" },
        "message": message.trim(),
        "email": if email.trim().is_empty() { None } else { Some(email.trim()) },
        "app": {
            "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "channel": "stable",
        },
        "core": { "version": crate::update::core().version.as_deref().map(crate::telemetry::version) },
        "layout": if crate::window::shipped_layouts().contains(&layout) { layout } else { "other" },
        "images": images,
    })
}

/// Where an earlier build's form kept its screenshots.
fn shots_dir() -> PathBuf { crate::mods::app_dir().join("data").join("frame-feedback") }

/// Keeps nothing: there is no form to attach to.
pub fn attach(_bytes: &[u8]) -> Result<String, String> {
    Err(NOT_SUPPORTED.into())
}

/// Reads nothing: each path gets `NOT_SUPPORTED`.
pub fn attach_files(paths: &[PathBuf]) -> Vec<Value> {
    paths.iter().map(|_| json!({ "error": NOT_SUPPORTED })).collect()
}

/// Deletes screenshots an earlier build kept for its form.
pub fn clear_shots() {
    let Ok(entries) = std::fs::read_dir(shots_dir()) else { return };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().starts_with("shot-") { let _ = std::fs::remove_file(e.path()); }
    }
}

/// Never: this build sends no feedback.
pub fn available() -> bool { false }

/// Sends nothing, ever: always `NOT_SUPPORTED`.
pub async fn send(_body: Value, _shots: Vec<String>) -> Result<(), String> {
    Err(NOT_SUPPORTED.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_draft_stays_text_only_and_hides_custom_layouts() {
        let body = draft("  broken  ", "  ", 2, "agent", "private-layout");
        assert_eq!(body["message"], "broken");
        assert_eq!(body["email"], Value::Null);
        assert_eq!(body["from"], "agent");
        assert_eq!(body["layout"], "other");
        assert!(body.get("install").is_none());
    }

    /// Even with `HERDR_FEEDBACK_URL` pointing at a listening server, nothing
    /// is sent: every entry point answers `NOT_SUPPORTED` and no connection is
    /// made. Runs in a process of its own (the variable is the child's).
    #[test]
    fn feedback_is_never_sent() {
        const NAME: &str = "feedback_is_never_sent";
        if std::env::var("HERDR_TEST_FEEDBACK").as_deref() == Ok(NAME) {
            assert!(!available());
            let body = draft("it broke", "a@b.c", 0, "person", "main");
            // Ready at once: nothing to wait for.
            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
            let std::task::Poll::Ready(sent) = std::pin::pin!(send(body, Vec::new())).as_mut().poll(&mut cx) else { panic!("send waited on something") };
            assert_eq!(sent, Err(NOT_SUPPORTED.to_owned()));
            assert_eq!(attach(b"\x89PNG\r\n\x1a\nrest"), Err(NOT_SUPPORTED.to_owned()));
            assert_eq!(attach_files(&[PathBuf::from("shot.png")]), vec![json!({ "error": NOT_SUPPORTED })]);
            std::thread::sleep(std::time::Duration::from_millis(300));
            return;
        }
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        server.set_nonblocking(true).unwrap();
        let url = format!("http://{}/v1/feedback", server.local_addr().unwrap());
        let home = std::env::temp_dir().join(format!("herdr-feedback-off-{}", std::process::id()));
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &format!("feedback::tests::{NAME}"), "--nocapture", "--test-threads=1"])
            .env("HERDR_APP_HOME", &home)
            .env("HERDR_TEST_FEEDBACK", NAME)
            .env("HERDR_FEEDBACK_URL", &url)
            .output()
            .unwrap();
        let _ = std::fs::remove_dir_all(&home);
        let log = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        assert!(out.status.success() && log.contains("1 passed"), "{log}");
        assert!(server.accept().is_err(), "something reached the feedback server");
    }
}
