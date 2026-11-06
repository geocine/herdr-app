//! The shell herdr-core starts plain terminals in (its config.toml `shell`).
//! On Windows the app starts agents in PowerShell unless that shell is a
//! POSIX one (Git Bash, MSYS2, Cygwin): then agents get the same shell as tabs.

use std::path::PathBuf;

/// Core's config file: `XDG_CONFIG_HOME`, else the platform's config folder
/// (`%APPDATA%` on Windows), then `herdr-core/config.toml`, as core finds it.
fn config_path() -> Option<PathBuf> {
    let dir = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| if cfg!(windows) { std::env::var_os("APPDATA").map(PathBuf::from) } else { std::env::home_dir().map(|h| h.join(".config")) })?;
    Some(dir.join("herdr-core").join("config.toml"))
}

#[derive(serde::Deserialize)]
struct Config {
    shell: Option<Vec<String>>,
}

/// The `shell` argv from core's config text, when set and not empty.
fn shell_from(text: &str) -> Option<Vec<String>> {
    toml::from_str::<Config>(text).ok()?.shell.filter(|s| !s.is_empty() && !s[0].trim().is_empty())
}

/// Whether a program is a shell that understands `-lic '"$@"; exec "$0" -li'`.
fn is_posix(program: &str) -> bool {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program).to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    matches!(name, "bash" | "sh" | "zsh" | "fish")
}

/// Core's configured shell when it's a POSIX one: the program to start agents in.
pub fn posix_shell() -> Option<String> {
    let text = std::fs::read_to_string(config_path()?).ok()?;
    shell_from(&text).map(|s| s[0].clone()).filter(|p| is_posix(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_shell_and_knows_posix_ones() {
        let git_bash = shell_from("shell = ['C:\\Program Files\\Git\\bin\\bash.exe', '--login', '-i']\n[keys]\n").unwrap();
        assert!(git_bash[0].ends_with("bash.exe"));
        assert!(is_posix(&git_bash[0]));
        assert!(is_posix("/usr/bin/fish"));
        assert!(!is_posix("pwsh.exe"));
        assert!(!is_posix("nu"));
        assert_eq!(shell_from("shell = []"), None);
        assert_eq!(shell_from("[keys]\n"), None);
        assert_eq!(shell_from("not toml ["), None);
    }
}
