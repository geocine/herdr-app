// Reading a repository for the graph: one round of git calls for the table, a cheap checksum of
// the refs for polling, and one commit's details. Every call is a lib/git.js read (no locks, no
// index refresh), so the folder watch never wakes for our own reads.
// After rabeeh-ta/herdr-git-graph `graph.js` (MIT) and file-preview `commits.js` (MIT). See NOTICE.md.
import { gitRead } from "../../lib/git.js";
import { STATUS_ARGS, logArgs, parseLog, parseStatus, nameStatus, numstat, objectId } from "./ops.js";

export const PAGE = 300;

// A short, stable checksum (FNV-1a), so a signature is a few characters however many refs there are.
export function checksum(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${text.length.toString(36)}-${h.toString(36)}`;
}

const REFS = ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags", "refs/remotes"];

/** The refs' checksum: changes with any commit, checkout, branch, tag or fetch. null when unreadable. */
export async function signature(top, on) {
  const [head, sym, refs] = await Promise.all([
    gitRead(["rev-parse", "-q", "--verify", "HEAD"], top, { on }), gitRead(["symbolic-ref", "-q", "HEAD"], top, { on }), gitRead(REFS, top, { on })]);
  if (refs.code !== 0) return null;
  return checksum([head.stdout, sym.stdout, refs.stdout].join("\0"));
}

const lines = (s) => s.split(/\r?\n/).filter(Boolean);

/**
 * Everything the table shows for a folder, in one round of git calls (each answers from any subfolder;
 * status names paths from the repository top). -> { state: "norepo" } | the folder's state.
 */
export async function readFolder(cwd, on, { all, remotes, limit }) {
  const top = await gitRead(["rev-parse", "--show-toplevel"], cwd, { on });
  if (top.code !== 0) return { state: "norepo", cwd, on };
  const root = top.stdout.trim().replace(/\\/g, "/");
  const git = (args) => gitRead(args, root, { on });
  const upstream = all ? null : await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).then((r) => (r.code === 0 ? r.stdout.trim() : null));
  const [log, head, current, branches, remoteNames, status, refs] = await Promise.all([
    // One commit past the page says whether there are more, as Git Graph asks.
    git(logArgs({ all, remotes, upstream, limit: limit + 1 })),
    git(["rev-parse", "--verify", "-q", "HEAD"]), git(["symbolic-ref", "-q", "--short", "HEAD"]),
    git(["for-each-ref", "--format=%(refname)", "refs/heads"]), git(["remote"]), git(STATUS_ARGS), git(REFS)]);
  // A log that fails without a HEAD is a repository with no commits yet.
  if (log.code !== 0 && head.code === 0) throw new Error(log.stderr.trim() || "git log failed");
  const base = log.code === 0 ? parseLog(log.stdout) : [];
  return {
    root, on, cwd, base: base.slice(0, limit), limit, hasMore: base.length > limit,
    head: head.code === 0 ? head.stdout.trim() : null, current: current.code === 0 ? current.stdout.trim() : null,
    branches: lines(branches.stdout).map((r) => r.replace(/^refs\/heads\//, "")),
    remoteNames: lines(remoteNames.stdout), upstream,
    files: status.code === 0 ? parseStatus(status.stdout) : [],
    sig: checksum([head.stdout, current.stdout, refs.stdout].join("\0")),
    signature: [log.stdout, head.stdout, current.stdout, branches.stdout, remoteNames.stdout].join("\0"), scope: `${all} ${remotes}`,
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
