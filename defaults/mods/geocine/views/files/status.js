// Git, read-only, for the explorer: each path's status, folders' strongest status and counts,
// +/− lines, the branch and its upstream, the ignored paths, and git's file list for search.
// Paths are "/"-separated and relative to the shown folder.
//
// Adapted from carstenlucke/herdr-roundup `roundup-files/git.js` (Apache-2.0), whose parsing
// follows cybertron288/herdr-mods `filetree` (MIT), itself a port of claude-code-filetree (MIT).
// See NOTICE.md.
import { gitRead } from "../../lib/git.js";
import { kinds } from "./disk.js";

// Which status a folder shows when its files differ: the most urgent.
const RANK = { "?": 1, A: 2, C: 2, R: 3, T: 3, M: 3, D: 4, U: 5 };
const IGNORED = 5000;
// change: 0 new (untracked or added), 1 modified, 2 deleted.
export const NEW = 0, MODIFIED = 1, DELETED = 2;
const UNSURE = 2000, MAYBE_DIRS = 2000;

export const dirOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
export const baseOf = (rel) => rel.slice(rel.lastIndexOf("/") + 1);
export function ancestors(rel) {
  const out = [];
  for (let d = dirOf(rel); d; d = dirOf(d)) out.push(d);
  return out;
}
const stronger = (a, b) => (!a ? b : (RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);
// Whether rel or one of its folders is in set.
export function within(set, rel) {
  if (!set.size) return false;
  for (let r = rel; r; r = dirOf(r)) if (set.has(r)) return true;
  return false;
}

// repo: inside a work tree; known: git has answered (or there is none); missing: no git started;
// failed: in a repo, but status failed.
export const emptyGit = (known = false) => ({
  repo: false, known, missing: false, failed: false, top: "", prefix: "", branch: null,
  status: new Map(),   // rel (file or folder) → letter: ? A M R T D U
  files: new Map(),    // rel → change, for every path git status lists
  untracked: new Set(),// untracked folders git lists as a whole ("dir/")
  links: new Set(),    // submodules and links to folders
  maybeDirs: new Set(),
  gone: new Set(),     // listed paths not in the working tree
  unsure: new Set(),
  rootUntracked: false,
  ignored: new Set(),  // ignored files and folders (at most IGNORED)
  rootIgnored: false,
  forced: new Set(),   // tracked files an ignore rule matches, and their folders
  diff: new Map(),     // rel (file or folder, "" the whole) → [added, deleted] lines against HEAD
  counts: new Map(),   // folder ("" the whole) → [new, modified, deleted]
  records: 0,
});

// git status --porcelain=v2 --branch headers (not translated, unlike v1's).
function parseHeader(rec, git) {
  const [, key, value = ""] = /^# (\S+) ?(.*)$/s.exec(rec) ?? [];
  const b = (git.branch ??= { head: "", oid: "", detached: false, upstream: "", ahead: 0, behind: 0, gone: false });
  if (key === "branch.oid") b.oid = value === "(initial)" ? "" : value;
  else if (key === "branch.head") { b.detached = value === "(detached)"; b.head = b.detached ? "HEAD" : value; }
  else if (key === "branch.upstream") { b.upstream = value; b.gone = true; }
  else if (key === "branch.ab") { const m = /^\+(\d+) -(\d+)$/.exec(value); b.ahead = Number(m?.[1] ?? 0); b.behind = Number(m?.[2] ?? 0); b.gone = false; }
}

function parseIgnored(stdout, git) {
  for (const rec of stdout.split("\0")) {
    const rel = rec.replace(/\/$/, "");
    if (!rel || within(git.ignored, dirOf(rel))) continue;
    if (git.ignored.size >= IGNORED) break;
    git.ignored.add(rel);
  }
}

function parseForced(stdout, git) {
  for (const rel of stdout.split("\0")) {
    if (!rel) continue;
    git.forced.add(rel);
    for (const a of ancestors(rel)) { if (git.forced.has(a)) break; git.forced.add(a); }
  }
}

// git status --porcelain=v2 -z --branch --no-renames. Answers how many paths lay outside
// git.prefix (a wrong prefix: read again without the cached one).
function parseStatus(stdout, git) {
  const map = (p) => (p.startsWith(git.prefix) ? p.slice(git.prefix.length).replace(/\/$/, "") : null);
  const up = (rel, fn) => { for (const d of [...ancestors(rel), ""]) fn(d); };
  const absent = new Set(), present = new Set();
  let outside = 0;
  for (const rec of stdout.split("\0")) {
    if (rec.startsWith("# ")) { parseHeader(rec, git); continue; }
    const kind = rec[0];
    let xy, raw, sub = "", worktree = "";
    if (kind === "?") { xy = "??"; raw = rec.slice(2); }
    else if (kind === "1" || kind === "u") {
      const fields = rec.split(" "), n = kind === "1" ? 8 : 10;
      if (fields.length <= n) continue;
      xy = fields[1].replace(/\./g, " "); raw = fields.slice(n).join(" ");
      sub = fields[2]; worktree = fields[kind === "1" ? 5 : 6];
    } else continue;
    const rel = map(raw);
    if (rel === null) { outside++; continue; }
    if (rel === "" && xy === "??") { git.rootUntracked = true; git.records++; git.counts.set("", [1, 0, 0]); continue; }
    if (!rel) continue;
    if (xy === "??") present.add(rel);
    if (sub.startsWith("S")) git.links.add(rel);
    else if (worktree === "120000" || (xy === "??" && !raw.endsWith("/"))) git.maybeDirs.add(rel);
    if (worktree === "000000") absent.add(rel);
    git.records++;
    const conflict = kind === "u" || /U/.test(xy) || xy === "AA" || xy === "DD";
    const change = conflict ? MODIFIED : xy === "??" || (xy.includes("A") && !xy.includes("D")) ? NEW : xy.includes("D") ? DELETED : MODIFIED;
    const letter = xy === "??" ? "?" : conflict ? "U" : ["D", "M", "R", "C", "A", "T"].filter((c) => xy.includes(c)).reduce(stronger, "") || "M";
    if (xy === "??" && raw.endsWith("/")) git.untracked.add(rel);
    git.files.set(rel, git.files.has(rel) ? Math.max(git.files.get(rel), change) : change);
    up(rel, (d) => { const c = git.counts.get(d) ?? [0, 0, 0]; c[change]++; git.counts.set(d, c); });
    git.status.set(rel, stronger(git.status.get(rel), letter));
    up(rel, (d) => git.status.set(d, stronger(git.status.get(d), letter)));
  }
  for (const rel of absent) {
    if (present.has(rel)) continue;
    if (git.rootUntracked || git.rootIgnored || within(git.untracked, rel) || within(git.ignored, rel)) git.unsure.add(rel);
    else git.gone.add(rel);
  }
  return outside;
}

function parseNumstat(stdout, git) {
  for (const rec of stdout.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
    if (!m || !m[3].startsWith(git.prefix)) continue;
    const rel = m[3].slice(git.prefix.length), add = Number(m[1]) || 0, del = Number(m[2]) || 0;
    for (const d of [rel, ...ancestors(rel), ""]) { const v = git.diff.get(d) ?? [0, 0]; git.diff.set(d, [v[0] + add, v[1] + del]); }
  }
}

// Whether git ignores root (or a folder above it). Null when git can't tell.
export async function ignoresRoot(root, on) {
  const r = await gitRead(["check-ignore", "-q", "--no-index", "--", "./"], root, { on }).catch(() => null);
  return r?.code === 0 ? true : r?.code === 1 ? false : null;
}

// Everything git says about root. Outside a repo: { repo: false, known: true }. `base`: { top,
// prefix } from an earlier read, which skips rev-parse.
export async function readGit(root, on, base) {
  const g = (args) => gitRead(args, root, { on });
  const out = emptyGit(true);
  let where = base, failed = false;
  if (!where) {
    const top = await g(["rev-parse", "--show-toplevel", "--show-prefix"]).catch(() => { out.missing = true; return null; });
    if (top?.code !== 0) return out;
    const [dir, prefix = ""] = top.stdout.split(/\r?\n/);
    where = { top: dir.replace(/\\/g, "/"), prefix };
  }
  out.repo = true; out.top = where.top; out.prefix = where.prefix;
  const status = Promise.all([
    g(["status", "--porcelain=v2", "-z", "--branch", "--no-renames", "--untracked-files=normal", "--ignored=no", "--", "."]).catch(() => null),
    g(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--", "."]).catch(() => null),
    g(["ls-files", "-z", "--cached", "--ignored", "--exclude-standard", "--", "."]).catch(() => null),
    ignoresRoot(root, on),
  ]).then(async ([r, ignoredList, forcedList, ignored]) => {
    if (ignored) out.rootIgnored = true;
    else if (ignoredList?.code === 0) parseIgnored(ignoredList.stdout, out);
    if (forcedList?.code === 0) parseForced(forcedList.stdout, out);
    if (r?.code !== 0) { failed = true; return; }
    if (parseStatus(r.stdout, out) && base) { failed = true; return; }
    const unsure = [...out.unsure].slice(0, UNSURE);
    const maybe = [...out.maybeDirs].slice(0, MAYBE_DIRS);
    const look = [...new Set([...unsure, ...maybe])];
    if (!look.length) return;
    const found = await kinds(root, look, on).catch(() => null);
    if (!found) return;
    for (const rel of unsure) { const k = found.get(rel); if (!k) out.gone.add(rel); else if (k === "d") out.links.add(rel); }
    for (const rel of maybe) if (found.get(rel) === "d") out.links.add(rel);
  });
  const [, numstat] = await Promise.all([status, g(["diff", "HEAD", "--numstat", "-z", "--no-renames", "--", "."]).catch(() => null)]);
  if (failed && base) return readGit(root, on);
  if (failed) { out.failed = true; return out; }
  if (numstat?.code === 0) parseNumstat(numstat.stdout, out);
  return out;
}

// The files git counts as the project below root (tracked and new, without ignored ones) and
// the folders that hold them: { dirs, all, full, cut }. At most `limit` files. Null outside a
// repo, without git, or when git ignores root.
export async function gitIndex(root, on, limit, ignored) {
  let r, skip;
  try {
    [r, skip] = await Promise.all([
      gitRead(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "-s", "--abbrev=4", "--", "."], root, { on, timeout: 60000 }),
      ignored !== undefined ? ignored : ignoresRoot(root, on),
    ]);
  } catch { return null; }
  if (r.code !== 0 || skip) return null;
  const dirs = new Set(), files = new Set();
  let full = true;
  const addDirs = (rel) => { for (const a of ancestors(rel)) { if (dirs.has(a)) break; dirs.add(a); } };
  const addDir = (d) => { if (d && !dirs.has(d)) { dirs.add(d); addDirs(d); } };
  for (const rec of r.stdout.split("\0")) {
    const staged = /^(\d{6}) [0-9a-f]+ \d\t(.*)$/s.exec(rec), entry = staged ? staged[2] : rec;
    if (staged?.[1] === "160000") { addDir(entry); continue; }
    if (entry.endsWith("/")) { addDir(entry.replace(/\/+$/, "")); continue; }
    if (!entry || files.has(entry)) continue;
    if (files.size >= limit) { full = false; break; }
    files.add(entry);
    addDirs(entry);
  }
  return { dirs, all: [...dirs, ...files], full, cut: full ? [] : ["files"] };
}
