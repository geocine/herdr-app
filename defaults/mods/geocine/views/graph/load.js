// Reading a repository for the graph: one round of git calls for the table, a cheap checksum of
// the refs for polling, and one commit's details. Every call is a lib/git.js read (no locks, no
// index refresh), so the folder watch never wakes for our own reads.
// Module state is shared by every copy of the mod (the panel, full mode): the folders last seen
// outside a repository, the last table read of each folder, and commits' details: full mode opens on what the
// panel already read. Only finished reads are shared, never a promise: a copy that closes takes
// its unfinished tasks with it, and another copy waiting on one of them would wait forever.
// After rabeeh-ta/herdr-git-graph `graph.js` (MIT) and file-preview `commits.js` (MIT). See NOTICE.md.
import { gitRead } from "../../lib/git.js";
import { slash } from "../../lib/where.js";
import { STATUS_ARGS, logArgs, parseLog, parseStatus, nameStatus, numstat, objectId } from "./ops.js";

export const PAGE = 300;

// A short, stable checksum (FNV-1a), so a signature is a few characters however many refs there are.
export function checksum(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${text.length.toString(36)}-${h.toString(36)}`;
}

const REFS = ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags", "refs/remotes"];
// HEAD and its branch, read the same way by the table and by the checksum: if they differ, the
// checksum never matches the table's and every check reloads the whole table. The table asks for
// the repository's top in the same call as HEAD (TOP_HEAD prints the top, then HEAD's hash), so
// it is read fresh every time at no extra process.
const HEAD = ["rev-parse", "--verify", "-q", "HEAD"], CURRENT = ["symbolic-ref", "-q", "--short", "HEAD"];
const TOP_HEAD = ["rev-parse", "--show-toplevel", "--verify", "-q", "HEAD"];

/** The refs' checksum: changes with any commit, checkout, branch, tag or fetch. null when unreadable. */
export async function signature(top, on) {
  const [head, current, refs] = await Promise.all([gitRead(HEAD, top, { on }), gitRead(CURRENT, top, { on }), gitRead(REFS, top, { on })]);
  if (refs.code !== 0) return null;
  return checksum([head.code === 0 ? head.stdout.trim() : "", current.stdout, refs.stdout].join("\0"));
}

const lines = (s) => s.split(/\r?\n/).filter(Boolean);

// ---- shared by every copy

const outside = new Map();     // "on\0folder" -> true: last seen outside a repository
const reads = new Map();       // "on\0folder\0scope" -> the last table read, shown at once by a new copy
const details = new Map();     // "on\0root\0hash" -> a commit's details
const bounded = (map, key, value, max) => { map.delete(key); map.set(key, value); if (map.size > max) map.delete(map.keys().next().value); };
const readKey = (cwd, on, all, remotes) => `${on ?? ""}\0${cwd}\0${all} ${remotes}`;

/** The last table read of a folder in this scope, by any copy, or null. */
export const lastRead = (cwd, on, { all, remotes }) => reads.get(readKey(cwd, on, all, remotes)) ?? null;

/** A commit's details if any copy has read them. */
export const cachedDetails = (key) => details.get(key);
/** Reads a commit's details and keeps them for every copy; errors become { error }. */
export async function keepDetails(key, read) {
  const d = await read().catch((e) => ({ error: String(e?.message ?? e), files: [], more: 0 }));
  bounded(details, key, d, 200);
  return d;
}
/** Drops one commit's details, or all of them (the refresh button). */
export function forgetDetails(key) { if (key === undefined) details.clear(); else details.delete(key); }

/**
 * Everything the table shows for a folder, in one round of git calls (each answers from any subfolder;
 * status names paths from the repository top). -> { state: "norepo" } | the folder's state.
 * The result is kept for new copies (lastRead).
 */
export async function readFolder(cwd, on, { all, remotes, limit }) {
  const read = await readFolderNow(cwd, on, { all, remotes, limit });
  if (read.state !== "norepo") bounded(reads, readKey(cwd, on, all, remotes), read, 16);
  return read;
}

async function readFolderNow(cwd, on, { all, remotes, limit }) {
  const where = `${on ?? ""}\0${cwd}`, git = (args) => gitRead(args, cwd, { on });
  const topOf = (r) => slash(r.stdout.split(/\r?\n/)[0].trim());
  // A folder last seen outside a repository is asked that first: one call, not a round of failures.
  if (outside.has(where)) {
    if (!topOf(await git(TOP_HEAD))) return { state: "norepo", cwd, on };
    outside.delete(where);
  }
  // All at once, run from the folder itself (git finds the repository from any subfolder; status
  // names paths from its top): the top comes with HEAD, so a folder that became (or stopped
  // being) a repository of its own is seen on the next read.
  const upstreamRead = all ? Promise.resolve(null)
    : git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).then((r) => (r.code === 0 ? r.stdout.trim() : null));
  const [topHead, upstream, log, current, remoteNames, status, refs] = await Promise.all([
    git(TOP_HEAD), upstreamRead,
    // One commit past the page says whether there are more, as Git Graph asks.
    upstreamRead.then((upstream) => git(logArgs({ all, remotes, upstream, limit: limit + 1 }))),
    git(CURRENT), git(["remote"]), git(STATUS_ARGS), git(REFS)]);
  // Not a repository: no top (a repository with no commits yet has a top and no HEAD).
  const root = topOf(topHead);
  if (!root) { bounded(outside, where, true, 256); return { state: "norepo", cwd, on }; }
  const headId = topHead.code === 0 ? (topHead.stdout.split(/\r?\n/)[1] ?? "").trim() || null : null;
  // A log that fails without a HEAD is a repository with no commits yet.
  if (log.code !== 0 && headId) throw new Error(log.stderr.trim() || "git log failed");
  const base = log.code === 0 ? parseLog(log.stdout) : [];
  // The local branches, from the refs already read (by name, as for-each-ref lists them).
  const branches = lines(refs.stdout).map((l) => l.slice(l.indexOf(" ") + 1)).filter((r) => r.startsWith("refs/heads/"));
  return {
    root, on, cwd, base: base.slice(0, limit), limit, hasMore: base.length > limit,
    head: headId, current: current.code === 0 ? current.stdout.trim() : null,
    branches: branches.map((r) => r.slice("refs/heads/".length)),
    remoteNames: lines(remoteNames.stdout), upstream,
    files: status.code === 0 ? parseStatus(status.stdout) : [],
    sig: checksum([headId ?? "", current.stdout, refs.stdout].join("\0")),
    signature: [log.stdout, headId ?? "", current.stdout, branches.join("\n"), remoteNames.stdout].join("\0"), scope: `${all} ${remotes}`,
  };
}

export async function readStatus(root, on) {
  const r = await gitRead(STATUS_ARGS, root, { on });
  return r.code === 0 ? parseStatus(r.stdout) : [];
}

const DIFFOPTS = ["--format=", "--diff-merges=first-parent", "-M", "--no-color", "--no-ext-diff", "--no-textconv"];

/** A commit's header from git (for one the table hasn't loaded, a parent past the page). */
export async function readCommit(root, on, rev) {
  const r = await gitRead(["show", "-s", "--no-color", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s", rev], root, { on });
  if (r.code !== 0) throw new Error((r.stderr || "Cannot read this commit").trim());
  const [hash, parents, author, email, time, , subject] = r.stdout.replace(/\r?\n$/, "").split("\x1f");
  if (!objectId(hash)) throw new Error("Cannot read this commit");
  return { hash, parents: parents ? parents.split(" ") : [], author, email, time: Number(time), refs: [], subject: subject ?? "", head: false };
}

/**
 * What git adds to a commit's header: body, committer, files (against the first parent, renames
 * found) with their line counts. -> { body, committer, committerEmail, committed, files, more }
 */
export async function readDetails(root, on, hash, max = 1000) {
  const git = (args) => gitRead(args, root, { on, timeout: 60000 });
  const [body, names, nums] = await Promise.all([
    git(["show", "-s", "--no-color", "--format=%cn%x1f%ce%x1f%ct%x1f%B", hash]),
    git(["show", ...DIFFOPTS, "--name-status", "-z", hash]), git(["show", ...DIFFOPTS, "--numstat", "-z", hash])]);
  if (body.code !== 0) throw new Error((body.stderr || "Cannot read this commit").trim());
  const [committer, committerEmail, committed, message = ""] = body.stdout.split("\x1f");
  const counts = numstat(nums.stdout), byPath = new Map(counts.map((c) => [c.path, c]));
  const files = nameStatus(names.stdout).map((f, i) => {
    const c = byPath.get(f.path) ?? counts[i] ?? {};
    return { ...f, add: c.add ?? 0, del: c.del ?? 0, binary: Boolean(c.binary) };
  });
  const text = message.replace(/\s+$/, ""), nl = text.indexOf("\n");
  return { body: nl < 0 ? "" : text.slice(nl + 1).replace(/^\s*\n/, ""), committer, committerEmail, committed: Number(committed),
    files: files.slice(0, max), more: Math.max(0, files.length - max) };
}

/** The uncommitted row's files, with their line counts against HEAD. */
export async function readUncommitted(root, on, files, head) {
  const nums = head ? await gitRead(["diff", "--no-renames", "--no-ext-diff", "--numstat", "-z", "HEAD"], root, { on }) : { stdout: "" };
  const byPath = new Map(numstat(nums.stdout).map((c) => [c.path, c]));
  return { body: "", files: files.map((f) => ({ path: f.path, status: f.status, from: null, untracked: f.untracked, staged: f.staged,
    add: byPath.get(f.path)?.add ?? 0, del: byPath.get(f.path)?.del ?? 0, binary: Boolean(byPath.get(f.path)?.binary) })), more: 0 };
}
