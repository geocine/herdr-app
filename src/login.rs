//! Windows: herdr-core at login (settings `start_core_at_login`), so terminals
//! lost to a reboot come back (in their folders, agents resumed) before the
//! window opens. The app is a window program, so `herdr-app start-core` starts
//! the core without flashing a console, and is what the login entry runs.

/// The per-user login list, and Herdr's entry in it.
#[cfg(windows)]
const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const NAME: &str = "Herdr Core";

/// `herdr-app start-core`: start the core people use (settings `core`, else
/// where Herdr finds one) if it isn't running. Exit code: the core's answer.
pub fn start_core() -> i32 {
    let configured = crate::settings::load_person().ok().and_then(|p| p.core);
    let Some(bin) = crate::core_bin::find(configured.as_deref()) else {
        eprintln!("herdr-app: no herdr-core found");
        return 1;
    };
    match crate::spawn::command(bin).args(["server", "start"]).status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            eprintln!("herdr-app: cannot start herdr-core: {e}");
            1
        }
    }
}

/// Adds or removes the login entry to match the setting, in the background.
/// A window on another home (`HERDR_APP_HOME`: tests, experiments) leaves it alone.
pub fn sync(on: bool) {
    #[cfg(windows)]
    {
        if std::env::var_os("HERDR_APP_HOME").is_some() {
            return;
        }
        let Ok(exe) = std::env::current_exe() else { return };
        std::thread::spawn(move || {
            let want = entry(&exe.to_string_lossy());
            let now = registered();
            if on && now.as_deref() != Some(want.as_str()) {
                let _ = crate::spawn::command("reg.exe").args(["add", KEY, "/v", NAME, "/t", "REG_SZ", "/d", &want, "/f"]).output();
            } else if !on && now.is_some() {
                let _ = crate::spawn::command("reg.exe").args(["delete", KEY, "/v", NAME, "/f"]).output();
            }
        });
    }
    #[cfg(not(windows))]
    let _ = on;
}

/// What the login entry runs.
#[cfg(windows)]
fn entry(exe: &str) -> String {
    format!("\"{exe}\" start-core")
}

/// The login entry as Windows has it now.
#[cfg(windows)]
fn registered() -> Option<String> {
    let out = crate::spawn::command("reg.exe").args(["query", KEY, "/v", NAME]).output().ok()?;
    out.status.success().then(|| value(&String::from_utf8_lossy(&out.stdout))).flatten()
}

/// The value from `reg query` output (`    Herdr Core    REG_SZ    "C:\..." start-core`).
#[cfg(windows)]
fn value(query: &str) -> Option<String> {
    query.lines().find_map(|l| l.split_once("REG_SZ").map(|(_, v)| v.trim().to_owned()))
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn reads_the_entry_reg_prints() {
        let out = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    Herdr Core    REG_SZ    \"C:\\Apps\\herdr-app.exe\" start-core\r\n\r\n";
        assert_eq!(super::value(out).as_deref(), Some(super::entry(r"C:\Apps\herdr-app.exe").as_str()));
        assert_eq!(super::value("ERROR: not found"), None);
    }
}
