// The Changes view's git: what is uncommitted (sections Conflicts / Staged / Unstaged /
// Untracked, with line counts) and what can be done to it (stage, unstage, discard, commit).
// Reads go through gitRead (no locks), writes through gitWrite.
// A refresh is three git processes run side by side (status with the branch, and the staged and
// unstaged numstat); untracked files' line counts are read without git and cached.
import { readTextFile } from "herdr";
import { gitRead, gitWrite } from "../../lib/git.js";
import { parseNumstat } from "../../lib/diff/parse.js";

export const MAX_ENTRIES = 2000;   // status entries read (a huge untracked folder stays usable)
const COUNT_UNTRACKED = 200;       // untracked files whose lines are counted

export const SECTIONS = [
  { id: "conflicts", label: "Conflicts" },
  { id: "staged", label: "Staged" },
  { id: "unstaged", label: "Unstaged" },
  { id: "untracked", label: "Untracked" },
];

// A path from watchFolder as git writes them: "/"-separated, lower case, without Windows'
// extended-length prefix (the watch reports `\\?\C:\repo\file`, `\\?\UNC\server\share\file`).
export const watchedPath = (p) => String(p ?? "").replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// Lines in an untracked file, by path, until a watch says it changed. Shared by every copy.
const lineCache = new Map();
export function forgetLines(paths) {
  if (!paths) { lineCache.clear(); return; }
  const changed = new Set(paths.map(watchedPath));
  for (const k of [...lineCache.keys()]) if (changed.has(k.slice(k.indexOf("|") + 1).toLowerCase())) lineCache.delete(k);
}
const lineKey = (top, on, path) => `${on ?? ""}|${top}/${path}`;

async function lines(top, on, path) {
  const key = lineKey(top, on, path);
  if (lineCache.has(key)) return lineCache.get(key);
  let r = { adds: 0, dels: 0, binary: false };
  try {
    const text = await readTextFile(`${top}/${path}`, { on });
    if (text === null) r = { adds: 0, dels: 0, binary: true };
    else if (text.includes("\0")) r.binary = true;
    else r.adds = text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
  } catch { r.binary = true; }
  lineCache.set(key, r);
  return r;
}

// A path's sort key: "n2" before "n10", case-insensitive. Worked out once per entry, not per
// comparison (a sort of 2000 paths compares ~22,000 times).
const sortKey = (p) => p.toLowerCase().match(/\d+|\D+/g) ?? [];
function compareKeys(x, y, a, b) {
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const n = /^\d/.test(x[i]) && /^\d/.test(y[i]) ? Number(x[i]) - Number(y[i]) : 0;
    if (n) return n;
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length || (a < b ? -1 : a > b ? 1 : 0);
}

// "n2" before "n10", folders' files together, case after case-insensitive order.
export function natural(a, b) { return compareKeys(sortKey(a), sortKey(b), a, b); }

// Sorts entries by path in place (each entry keeps its key, as `nk`, for byNatural).
export function sortEntries(list) {
  for (const e of list) e.nk ??= sortKey(e.path);
  return list.sort(byNatural);
}
export const byNatural = (a, b) => compareKeys(a.nk ?? sortKey(a.path), b.nk ?? sortKey(b.path), a.path, b.path);

// Two sorted lists as one sorted list (edited and untracked files shown together).
export function mergeSorted(a, b) {
  if (!a.length) return b.slice();
  if (!b.length) return a.slice();
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) out.push(byNatural(a[i], b[j]) <= 0 ? a[i++] : b[j++]);
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

async function read(args, cwd, on) {
  const r = await gitRead(args, cwd, { on, timeout: 30000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `git ${args[0]} failed`).trim().split("\n")[0]);
  return r.stdout;
}

// The text after the nth space: a porcelain v2 record's path, past its fixed fields.
function after(e, n) {
  let at = -1;
  for (let k = 0; k < n && at < e.length; k++) { at = e.indexOf(" ", at + 1); if (at < 0) return ""; }
  return e.slice(at + 1);
}

/**
 * The uncommitted changes of a repo: { head: boolean, sha, branch, sections: { conflicts, staged,
 * unstaged, untracked }, total, cut, uncounted } with entries { path, oldPath, status, section,
 * adds, dels, binary }. Paths are relative to the repo's top, so `cwd` may be any folder in it.
 * `top` (when known) lets cached untracked line counts fill in at once; `uncounted` lists the
 * untracked entries still to count (countLines).
 */
export async function loadStatus(cwd, on, top = null) {
  const [status, staged, unstaged] = await Promise.all([
    read(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], cwd, on),
    // Without a commit yet, --cached shows everything staged (git diff's own rule).
    read(["diff", "--cached", "--numstat", "-z", "-M"], cwd, on).catch(() => ""),
    read(["diff", "--numstat", "-z"], cwd, on).catch(() => ""),
  ]);
  const stagedCounts = parseNumstat(staged), unstagedCounts = parseNumstat(unstaged);
  const sections = { conflicts: [], staged: [], unstaged: [], untracked: [] };
  const parts = status.split("\0");
  let total = 0, sha = null, branch = null, hasHead = true;
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 3) continue;
    const type = e[0];
    if (type === "#") {
      if (e.startsWith("# branch.oid ")) { const v = e.slice(13).trim(); hasHead = v !== "(initial)"; sha = hasHead ? v : null; }
      else if (e.startsWith("# branch.head ")) { const v = e.slice(14).trim(); branch = v === "(detached)" ? null : v; }
      continue;
    }
    if (type === "!") continue;
    if (type === "?") {
      if (++total > MAX_ENTRIES) continue;
      sections.untracked.push({ path: e.slice(2), oldPath: null, status: "?", section: "untracked", adds: 0, dels: 0, binary: false });
      continue;
    }
    const xy = e.slice(2, 4).replace(/\./g, " "), x = xy[0], y = xy[1];
    let path, oldPath = null;
    if (type === "1") path = after(e, 8);
    else if (type === "2") { path = after(e, 9); oldPath = parts[++i] ?? null; }
    else if (type === "u") path = after(e, 10);
    else continue;
    if (++total > MAX_ENTRIES) continue;
    if (type === "u") { sections.conflicts.push({ path, oldPath: null, status: "U", section: "conflicts", adds: 0, dels: 0, binary: false, xy }); continue; }
    if (x !== " ") {
      const c = stagedCounts.get(path) ?? { adds: 0, dels: 0, binary: false };
      sections.staged.push({ path, oldPath: x === "R" || x === "C" ? oldPath : null, status: x, section: "staged", ...c });
    }
    if (y !== " ") {
      const c = unstagedCounts.get(path) ?? { adds: 0, dels: 0, binary: false };
      sections.unstaged.push({ path, oldPath: null, status: y, section: "unstaged", ...c });
    }
  }
  // Counts already known come in now; the rest are read after the list is shown.
  const uncounted = [];
  sections.untracked.forEach((e, i) => {
    const hit = top ? lineCache.get(lineKey(top, on, e.path)) : null;
    if (hit) Object.assign(e, hit);
    else if (i < COUNT_UNTRACKED) uncounted.push(e);
  });
  for (const list of Object.values(sections)) sortEntries(list);
  return { head: hasHead, sha, branch, sections, total: Math.min(total, MAX_ENTRIES), cut: total > MAX_ENTRIES, uncounted };
}

// Counts the lines of untracked entries (from loadStatus' `uncounted`), 32 files at a time.
export async function countLines(entries, top, on) {
  for (let i = 0; i < entries.length; i += 32) {
    await Promise.all(entries.slice(i, i + 32).map(async (e) => Object.assign(e, await lines(top, on, e.path))));
  }
}

// The folders and files git ignores (folders end in "/"), to tell a watch event that matters from
// a build writing into target/ or node_modules/. → { dirs: Set, files: Set } (lower case).
export async function ignoredPaths(top, on) {
  const out = await read(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], top, on);
  const dirs = new Set(), files = new Set();
  for (const p of out.split("\0")) if (p) (p.endsWith("/") ? dirs : files).add(p.toLowerCase());
  return { dirs, files };
}

async function write(args, top, on) {
  const r = await gitWrite(args, top, { on, timeout: 120000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `git ${args[0]} failed`).trim());
  return r.stdout;
}

const lit = (p) => `:(top,literal)${p}`;
// Long path lists go in chunks, under Windows' command line limit.
async function chunked(args, paths, top, on) {
  for (let i = 0; i < paths.length; i += 100) await write([...args, "--", ...paths.slice(i, i + 100).map(lit)], top, on);
}

export async function stage(entries, top, on) {
  await chunked(["add", "-A"], entries.flatMap(e => [e.path, ...(e.oldPath ? [e.oldPath] : [])]), top, on);
}

export async function unstage(entries, top, on, head) {
  const paths = entries.flatMap(e => [e.path, ...(e.oldPath ? [e.oldPath] : [])]);
  if (head) await chunked(["reset", "-q", "HEAD"], paths, top, on);
  else await chunked(["rm", "--cached", "-r", "-q"], paths, top, on);
}

export const stageAll = (top, on) => write(["add", "-A"], top, on);
export const unstageAll = (top, on, head) => (head ? write(["reset", "-q"], top, on) : write(["rm", "--cached", "-r", "-q", "."], top, on));

/**
 * Throws the changes away. unstaged: the worktree goes back to the index. untracked: the files are
 * deleted. staged: index and worktree go back to HEAD (a staged new file is deleted).
 */
export async function discard(entries, top, on, head) {
  const unstaged = entries.filter(e => e.section === "unstaged").map(e => e.path);
  const untracked = entries.filter(e => e.section === "untracked").map(e => e.path);
  const staged = entries.filter(e => e.section === "staged");
  if (unstaged.length) await chunked(["checkout", "-q"], unstaged, top, on);
  if (untracked.length) await chunked(["clean", "-f", "-q"], untracked, top, on);
  const fresh = staged.filter(e => !head || e.status === "A" || e.status === "R" || e.status === "C").map(e => e.path);
  const known = staged.filter(e => head && e.status !== "A" && e.status !== "C").map(e => e.status === "R" ? e.oldPath : e.path).filter(Boolean);
  if (fresh.length) await chunked(["rm", "-f", "-q", "-r"], fresh, top, on);
  if (known.length) await chunked(["checkout", "-q", "HEAD"], known, top, on);
}

export async function commit(message, top, on, { all = false } = {}) {
  if (all) await write(["add", "-A"], top, on);
  return write(["commit", "-q", "-m", message], top, on);
}
