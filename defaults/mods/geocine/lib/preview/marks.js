// Changed lines of one file against HEAD (staged and unstaged), for the code view's gutter and
// overview ruler. Plain git through lib/git.js: no shell, so it works the same on Windows.
// Adapted from bohumil/herdr-file-preview `git.js` (MIT). See NOTICE.md.
import { gitRead } from "../git.js";

const lineCount = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);

/** The file's porcelain status ("" when clean); null outside a repo or without git; undefined when unreachable. */
export async function status(cwd, name, on) {
  const r = await gitRead(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", name], cwd, { on }).catch(() => undefined);
  if (!r) return undefined;
  return r.code === 0 ? r.stdout : null;
}

/**
 * Changed lines of `name` (in folder `cwd`) against HEAD.
 * -> null (not in a repo, clean, ignored) | undefined (unreachable) | { lines: Map<line, "a" | "m">, dels: Set<n> }
 * Lines from 1; a deletion n sits after line n (0: above the first).
 */
export async function changes(cwd, name, text, on, st) {
  st ??= await status(cwd, name, on);
  if (st === undefined) return undefined;
  const xy = st ? st.slice(0, 2) : "";
  if (!xy || xy === "!!") return null;
  if (xy === "??") return added(text);
  const head = await gitRead(["rev-parse", "-q", "--verify", "HEAD"], cwd, { on }).catch(() => undefined);
  if (!head) return undefined;
  if (head.code !== 0) return added(text);   // nothing committed yet: every line is new
  const r = await gitRead(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", "HEAD", "--", name], cwd, { on }).catch(() => undefined);
  if (!r) return undefined;
  if (r.code !== 0) return null;
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
