# Herdr (geocine fork)

A fork of [herdrdev/herdr-app](https://github.com/herdrdev/herdr-app), the
desktop app for terminals and coding agents. For what Herdr is and how to use
it, read **[the original README](https://github.com/herdrdev/herdr-app/blob/master/README.md)**.

This fork runs on Windows with its own herdr-core fork,
[geocine/herdr-core](https://github.com/geocine/herdr-core/tree/geocine). The
`geocine` branch is rebased on upstream `master`.

## Install (Windows)

In PowerShell:

```powershell
powershell -c "irm https://raw.githubusercontent.com/geocine/herdr-app/geocine/distribution/install-geocine.ps1 | iex"
```

This installs the app and the fork's herdr-core together, both from the latest
[fork release](https://github.com/geocine/herdr-app/releases). An herdr-core
that is already installed is replaced in place, so running terminals keep
running. If Git Bash is installed and the core has no shell set yet, the
installer makes Git Bash its shell and adds the folder report to `~/.bashrc`;
set `HERDR_NO_GIT_BASH=1` first to skip that.

The fork never updates itself or the core from upstream. To update, run the
same line again. Read [the installer](distribution/install-geocine.ps1) first
if you prefer.

## What's new in this fork

- **Terminals come back after a reboot.** Kept terminals come back with their
  screen and folder, and the coding agent that was running comes back to that
  tab's own conversation: Claude Code, Codex, pi, OpenCode and Grok. With
  several tabs running one agent in one folder, each tab gets its own
  conversation back (this needs the fork's herdr-core).
- **herdr-core starts at login** on Windows (`start_core_at_login` in
  settings), so lost terminals are back before Herdr opens.
- **Git Bash:** folders are tracked in Git Bash, and agents use the core's
  Git Bash.
- **Spaces have folders:** each space keeps its own folder, and the spaces
  `+` button and the New menu open a folder as a space.
- **Versions against upstream:** Settings → Updates shows, for Herdr and
  herdr-core, the upstream commit each build is based on and how far the
  fork is ahead of it.
- **No usage data, no feedback:** nothing is collected, kept or sent, whatever
  settings.json says. Feedback is not supported in this forked build.
- **One-line install and fork releases** (see above). A build from source
  never updates the core after an app update.

## Make a release

```powershell
scripts/fork-release.ps1 -Publish
```

It builds the app and herdr-core (the checkout in `..\herdr-core`, so have
both on `geocine`) and publishes a GitHub release on `geocine/herdr-app`
(needs `gh`). See the script's header for its options. To build from source, see
[the original README](https://github.com/herdrdev/herdr-app/blob/master/README.md#build-from-source).
