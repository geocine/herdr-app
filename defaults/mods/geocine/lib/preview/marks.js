// Changed lines of one file against HEAD (staged and unstaged), for the code view's gutter and
// overview ruler. Plain git through lib/git.js: no shell, so it works the same on Windows.
// The status and the diff run side by side (one round, ~50 ms instead of three in a row), and
// "did HEAD move?" is answered by reading .git files, without starting git.
// Adapted from bohumil/herdr-file-preview `git.js` (MIT). See NOTICE.md.
import { readTextFile } from "herdr";
import { gitRead } from "../git.js";
import { slash } from "../where.js";

const lineCount = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);

/** The file's porcelain status ("" when clean); null outside a repo or without git; undefined when unreachable. */
export async function status(cwd, name, on) {
  const r = await gitRead(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", name], cwd, { on }).catch(() => undefined);
  if (!r) return undefined;
  return r.code === 0 ? r.stdout : null;
}

/** `git diff -U0 HEAD -- name`: { code, stdout } | undefined when unreachable. */
export const diffHead = (cwd, name, on) =>
  gitRead(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", "HEAD", "--", name], cwd, { on }).catch(() => undefined);

/** Status and diff at once: { st, diff } (st as status() gives it). */
export async function both(cwd, name, on) {
  const [st, diff] = await Promise.all([status(cwd, name, on), diffHead(cwd, name, on)]);
  return { st, diff };
}

/**
 * Changed lines of `name` (in folder `cwd`) against HEAD, from its status `st` (and its diff,
 * when already run; else it runs here if needed).
 * -> null (not in a repo, clean, ignored) | undefined (unreachable) | { lines: Map<line, "a" | "m">, dels: Set<n> }
 * Lines from 1; a deletion n sits after line n (0: above the first).
 */
export async function changes(cwd, name, text, on, st, diff = null) {
  if (st === undefined) st = await status(cwd, name, on);
  if (st === undefined) return undefined;
  const xy = st ? st.slice(0, 2) : "";
  if (!xy || xy === "!!") return null;
  if (xy === "??") return added(text);
  const r = diff ?? await diffHead(cwd, name, on);
  if (!r) return undefined;
  if (r.code !== 0) {
    // Nothing committed yet (no HEAD): every line is new.
    const head = await gitRead(["rev-parse", "-q", "--verify", "HEAD"], cwd, { on }).catch(() => undefined);
    if (!head) return undefined;
    return head.code !== 0 ? added(text) : null;
  }
  const lines = new Map(), dels = new Set();
  for (const h of r.stdout.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const old = h[1] === undefined ? 1 : Number(h[1]), at = Number(h[2]), n = h[3] === undefined ? 1 : Number(h[3]);
    if (n === 0) { dels.add(at); continue; }
    for (let i = at; i < at + n; i++) lines.set(i, old === 0 ? "a" : "m");
  }
  return lines.size || dels.size ? { lines, dels } : null;
}

/** Every line of `text` added (an untracked file). */
export function added(text) {
  const lines = new Map();
  for (let i = 1, n = lineCount(text); i <= n; i++) lines.set(i, "a");
  return { lines, dels: new Set() };
}

/** Runs of equal changed lines: [{ from, n, kind }], in order. */
export function runs(marks) {
  const out = [];
  for (const i of [...marks.lines.keys()].sort((a, b) => a - b)) {
    const k = marks.lines.get(i), last = out[out.length - 1];
    if (last && last.kind === k && last.from + last.n === i) last.n++;
    else out.push({ from: i, n: 1, kind: k });
  }
  return out;
}

/** "+3 ~2 −1": counts for the bar. */
export function summary(marks) {
  if (!marks) return null;
  let a = 0, m = 0;
  for (const k of marks.lines.values()) if (k === "a") a++; else m++;
  return { added: a, modified: m, deleted: marks.dels.size };
}

// ---- did HEAD move? ------------------------------------------------------------------------

const read = (path) => readTextFile(path).catch(() => undefined);
const resolve = (p, base) => (/^([a-z]:)?\//i.test(slash(p)) ? slash(p) : `${base}/${slash(p)}`).replace(/\/+$/, "");

/**
 * What HEAD points at, read from the repo's files on this computer (no git process): a string
 * that changes with a commit, checkout or reset; null when it can't be read (then poll git).
 * Handles worktrees and submodules (.git as a file) and packed refs.
 */
export async function headStamp(top) {
  let dir = `${top}/.git`, common = dir;
  let head = await read(`${dir}/HEAD`);
  if (head == null) {
    const link = await read(dir);
    const m = typeof link === "string" ? /^gitdir:\s*(.+?)\s*$/m.exec(link) : null;
    if (!m) return null;
    dir = resolve(m[1], top);
    head = await read(`${dir}/HEAD`);
    if (head == null) return null;
    const c = await read(`${dir}/commondir`);
    common = typeof c === "string" && c.trim() ? resolve(c.trim(), dir) : dir;
  }
  head = head.trim();
  const ref = /^ref:\s*(\S+)/.exec(head)?.[1];
  if (!ref) return head;   // detached: the commit itself
  const loose = await read(`${common}/${ref}`);
  if (loose === undefined) return null;
  if (loose !== null) return `${head} ${loose.trim()}`;
  const packed = await read(`${common}/packed-refs`);
  return packed === undefined ? null : `${head} packed ${packed ?? ""}`;
}
