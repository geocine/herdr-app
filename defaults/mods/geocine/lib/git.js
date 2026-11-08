// Git for every Geocine view. Reads never write under .git (no index refresh, no lock, no
// fsmonitor), so a folder watch doesn't see our own reads. On Windows, git is found even when the
// app's PATH lacks it (Git for Windows installed after the app started).
// The resolution follows carstenlucke/herdr-roundup `roundup-files/git.js` (Apache-2.0). See NOTICE.md.
// Module state is shared by every copy of the mod (tab bar, panels, full mode): which git starts
// on each machine, and a short cache of repoOf. Plain data only; no host call at module load.
import { exec, home, window } from "herdr";

const PLAIN = ["-c", "core.quotepath=false", "-c", "color.ui=false"];
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "diff.relative=false", ...PLAIN];
const WINDOWS_GITS = () => ["C:\\Program Files\\Git\\cmd\\git.exe", `${home()}\\AppData\\Local\\Programs\\Git\\cmd\\git.exe`];
const gits = new Map();      // machine ("" = here) -> the git command that started
const finding = new Map();   // machine -> the first call's search; calls made meanwhile wait for it

async function start(args, cwd, on, timeout) {
  const key = on ?? "";
  if (!gits.has(key) && finding.has(key)) await finding.get(key).catch(() => {});
  const known = gits.get(key);
  if (known) return exec(known, args, { cwd, on, timeout });
  const search = (async () => {
    const tries = ["git", ...(!on && window()?.platform === "windows" ? WINDOWS_GITS() : [])];
    let error;
    for (const cmd of tries) {
      try { const r = await exec(cmd, args, { cwd, on, timeout }); gits.set(key, cmd); return r; }
      catch (e) { error ??= e; }
    }
    throw error;
  })();
  finding.set(key, search);
  try { return await search; } finally { if (finding.get(key) === search) finding.delete(key); }
}

// A read: never takes locks. Resolves to { code, stdout, stderr }; rejects only when no git starts.
export const gitRead = (args, cwd, { on = null, timeout } = {}) => start([...READ, ...args], cwd, on, timeout);

// A write (checkout, merge, stage, ...): normal git, so it may lock and refresh the index.
// It may move HEAD, so repoOf's cache is dropped before and after it.
export const gitWrite = (args, cwd, { on = null, timeout } = {}) => {
  forgetRepos();
  return start([...PLAIN, ...args], cwd, on, timeout).finally(forgetRepos);
};

// Like gitRead, but throws git's message on a non-zero exit; returns stdout.
export async function git(args, cwd, opts) {
  const r = await gitRead(args, cwd, opts);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `git ${args[0]} failed`).trim());
  return r.stdout;
}

// repoOf runs one git process, and calls for the same folder within REPO_TTL share it (the
// views and copies that follow the focus all ask when it moves, within a few ms). Kept short on
// purpose: a checkout or commit run in a terminal moves HEAD, and the Changes view refreshes 250 ms
// after the folder watch reports it; a longer window would hand that refresh the answer read just
// before HEAD moved, and nothing would ask again for up to 30 s.
const REPO_TTL = 150;
const repos = new Map();     // JSON [on, cwd] -> { at, promise }
export function forgetRepos() { repos.clear(); }

// The repository around a folder: { top, prefix, branch, head } (top "/"-separated; branch null
// when detached or unborn; head the commit, null in an empty repo), or null outside one or
// without git.
export function repoOf(cwd, opts) {
  if (!cwd) return Promise.resolve(null);
  const key = JSON.stringify([opts?.on ?? null, cwd]), now = Date.now(), hit = repos.get(key);
  if (hit && now - hit.at < REPO_TTL) return hit.promise;
  if (repos.size > 32) repos.clear();
  const promise = readRepo(cwd, opts);
  repos.set(key, { at: now, promise });
  return promise;
}

async function readRepo(cwd, opts) {
  try {
    // Prints top, prefix, the commit, then the branch ("HEAD" when detached). In a repo without
    // commits it fails after top and prefix. "--": a file named HEAD isn't taken for a path.
    const r = await gitRead(["rev-parse", "--show-toplevel", "--show-prefix", "HEAD", "--abbrev-ref", "HEAD", "--"], cwd, opts);
    const [root = "", prefix = "", sha = "", branch = ""] = r.stdout.split(/\r?\n/);
    if (!root.trim()) return null;
    const ok = r.code === 0;
    return { top: root.replace(/\\/g, "/"), prefix, branch: ok && branch && branch !== "HEAD" ? branch : null, head: (ok && sha) || null };
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
