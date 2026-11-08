// Git for every Geocine view. Reads never write under .git (no index refresh, no lock, no
// fsmonitor), so a folder watch doesn't see our own reads. On Windows, git is found even when the
// app's PATH lacks it (Git for Windows installed after the app started).
// The resolution follows carstenlucke/herdr-roundup `roundup-files/git.js` (Apache-2.0). See NOTICE.md.
import { exec, home, window } from "herdr";

const PLAIN = ["-c", "core.quotepath=false", "-c", "color.ui=false"];
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "diff.relative=false", ...PLAIN];
const WINDOWS_GITS = () => ["C:\\Program Files\\Git\\cmd\\git.exe", `${home()}\\AppData\\Local\\Programs\\Git\\cmd\\git.exe`];
const gits = new Map();

async function start(args, cwd, on, timeout) {
  const key = on ?? "";
  const known = gits.get(key);
  if (known) return exec(known, args, { cwd, on, timeout });
  const tries = ["git", ...(!on && window()?.platform === "windows" ? WINDOWS_GITS() : [])];
  let error;
  for (const cmd of tries) {
    try { const r = await exec(cmd, args, { cwd, on, timeout }); gits.set(key, cmd); return r; }
    catch (e) { error ??= e; }
  }
  throw error;
}

// A read: never takes locks. Resolves to { code, stdout, stderr }; rejects only when no git starts.
export const gitRead = (args, cwd, { on = null, timeout } = {}) => start([...READ, ...args], cwd, on, timeout);

// A write (checkout, merge, stage, ...): normal git, so it may lock and refresh the index.
export const gitWrite = (args, cwd, { on = null, timeout } = {}) => start([...PLAIN, ...args], cwd, on, timeout);

// Like gitRead, but throws git's message on a non-zero exit; returns stdout.
export async function git(args, cwd, opts) {
  const r = await gitRead(args, cwd, opts);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `git ${args[0]} failed`).trim());
  return r.stdout;
}

// The repository around a folder: { top, prefix, branch, head } (top "/"-separated; branch null
// when detached or unborn; head null in an empty repo), or null outside one or without git.
export async function repoOf(cwd, opts) {
  if (!cwd) return null;
  try {
    const top = await gitRead(["rev-parse", "--show-toplevel", "--show-prefix"], cwd, opts);
    if (top.code !== 0) return null;
    const [root, prefix = ""] = top.stdout.split(/\r?\n/);
    const head = await gitRead(["rev-parse", "--abbrev-ref", "HEAD", "HEAD"], cwd, opts);
    const [branch, sha] = head.code === 0 ? head.stdout.split(/\r?\n/) : [null, null];
    return { top: root.replace(/\\/g, "/"), prefix, branch: branch && branch !== "HEAD" ? branch : null, head: sha || null };
  } catch { return null; }
}

// Git's status letters, drawn the same everywhere (theme ansi slots).
export const STATUS = {
  M: { label: "Modified", color: "ansi3" },
  A: { label: "Added", color: "ansi2" },
  "?": { label: "Untracked", color: "ansi2", letter: "U" },
  D: { label: "Deleted", color: "ansi1" },
  R: { label: "Renamed", color: "ansi4" },
  C: { label: "Copied", color: "ansi4" },
  T: { label: "Type changed", color: "ansi3" },
  U: { label: "Conflict", color: "ansi1", letter: "!" },
};
export const statusLetter = (s) => STATUS[s]?.letter ?? s;
export const statusColor = (t, s) => t[STATUS[s]?.color ?? "muted"] ?? t.muted;
