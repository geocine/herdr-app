// The Changes view's git: what is uncommitted (sections Conflicts / Staged / Unstaged /
// Untracked, with line counts) and what can be done to it (stage, unstage, discard, commit).
// Reads go through gitRead (no locks), writes through gitWrite.
import { readTextFile } from "herdr";
import { gitRead, gitWrite } from "../../lib/git.js";
import { parseNumstat } from "../../lib/diff/parse.js";

export const MAX_ENTRIES = 2000;   // status entries read (a huge untracked folder stays usable)
const COUNT_UNTRACKED = 200;       // untracked files whose lines are counted
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const CONFLICTS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export const SECTIONS = [
  { id: "conflicts", label: "Conflicts" },
  { id: "staged", label: "Staged" },
  { id: "unstaged", label: "Unstaged" },
  { id: "untracked", label: "Untracked" },
];

// Lines in an untracked file, by path, until a watch says it changed. Shared by every copy.
const lineCache = new Map();
export function forgetLines(paths) {
  if (!paths) { lineCache.clear(); return; }
  const changed = new Set(paths.map(p => String(p).replace(/\\/g, "/").toLowerCase()));
  for (const k of [...lineCache.keys()]) if (changed.has(k.slice(k.indexOf("|") + 1).toLowerCase())) lineCache.delete(k);
}

async function lines(top, on, path) {
  const key = `${on ?? ""}|${top}/${path}`;
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

// "n2" before "n10", folders' files together, case after case-insensitive order.
export function natural(a, b) {
  const x = a.toLowerCase().match(/\d+|\D+/g) ?? [], y = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const n = /^\d/.test(x[i]) && /^\d/.test(y[i]) ? Number(x[i]) - Number(y[i]) : 0;
    if (n) return n;
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length || (a < b ? -1 : a > b ? 1 : 0);
}

async function read(args, top, on) {
  const r = await gitRead(args, top, { on, timeout: 30000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `git ${args[0]} failed`).trim().split("\n")[0]);
  return r.stdout;
}

/**
 * The uncommitted changes of a repo: { head: boolean, sections: { conflicts, staged, unstaged,
 * untracked }, total, cut } with entries { path, oldPath, status, section, adds, dels, binary }.
 */
export async function loadStatus(top, on) {
  const [status, head] = await Promise.all([
    read(["status", "--porcelain=v1", "-z", "--untracked-files=all"], top, on),
    gitRead(["rev-parse", "-q", "--verify", "HEAD^{commit}"], top, { on }),
  ]);
  const hasHead = head.code === 0;
  const [staged, unstaged] = await Promise.all([
    read(["diff", "--cached", "--numstat", "-z", "-M", ...(hasHead ? [] : [EMPTY_TREE])], top, on).catch(() => ""),
    read(["diff", "--numstat", "-z"], top, on).catch(() => ""),
  ]);
  const stagedCounts = parseNumstat(staged), unstagedCounts = parseNumstat(unstaged);
  const sections = { conflicts: [], staged: [], unstaged: [], untracked: [] };
  const parts = status.split("\0");
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2), x = xy[0], y = xy[1], path = e.slice(3);
    let oldPath = null;
    if (x === "R" || x === "C" || y === "R" || y === "C") oldPath = parts[++i] ?? null;
    if (xy === "!!") continue;
    if (++total > MAX_ENTRIES) continue;
    if (xy === "??") { sections.untracked.push({ path, oldPath: null, status: "?", section: "untracked", adds: 0, dels: 0, binary: false }); continue; }
    if (CONFLICTS.has(xy)) { sections.conflicts.push({ path, oldPath: null, status: "U", section: "conflicts", adds: 0, dels: 0, binary: false, xy }); continue; }
    if (x !== " ") {
      const c = stagedCounts.get(path) ?? { adds: 0, dels: 0, binary: false };
      sections.staged.push({ path, oldPath: x === "R" || x === "C" ? oldPath : null, status: x, section: "staged", ...c });
    }
    if (y !== " ") {
      const c = unstagedCounts.get(path) ?? { adds: 0, dels: 0, binary: false };
      sections.unstaged.push({ path, oldPath: null, status: y, section: "unstaged", ...c });
    }
  }
  const counted = sections.untracked.slice(0, COUNT_UNTRACKED);
  for (let i = 0; i < counted.length; i += 16) {
    await Promise.all(counted.slice(i, i + 16).map(async (e) => Object.assign(e, await lines(top, on, e.path))));
  }
  for (const list of Object.values(sections)) list.sort((a, b) => natural(a.path, b.path));
  return { head: hasHead, sections, total: Math.min(total, MAX_ENTRIES), cut: total > MAX_ENTRIES };
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
