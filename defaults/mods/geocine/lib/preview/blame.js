// Who last changed each line (git blame), for the code view: the cursor line's note (as GitLens
// shows it) and, in full mode, a blame column. It runs in the background after the file is on
// screen and never holds the view up; one `git blame --porcelain` per file version.
import { gitRead } from "../git.js";

const ZERO = /^0{40}$/;
/** Files longer than this aren't blamed (git takes seconds, the notes would be little help). */
export const BLAME_MAX_LINES = 20000;

const me = new Map();   // machine ("" = here) -> git's user.name, or "" (asked once)

async function userName(cwd, on) {
  const key = on ?? "";
  if (!me.has(key)) {
    const r = await gitRead(["config", "user.name"], cwd, { on }).catch(() => null);
    me.set(key, r?.code === 0 ? r.stdout.trim() : "");
  }
  return me.get(key);
}

/**
 * Blame of `name` (in folder `cwd`), as it is on disk.
 * -> null (not committed / not in a repo / failed) | { rows: Int32Array (row -> commit index, -1 none), commits: [{ hash, author, time, summary, mine, uncommitted }] }
 */
export async function blame(cwd, name, on) {
  const [r, user] = await Promise.all([
    gitRead(["blame", "--porcelain", "--", name], cwd, { on, timeout: 60000 }).catch(() => null),
    userName(cwd, on),
  ]);
  if (!r || r.code !== 0) return null;
  return parse(r.stdout, user);
}

/** `git blame --porcelain` output -> { rows, commits }. Linear, no regex per line but the header's. */
export function parse(out, user = "") {
  const commits = [], index = new Map(), lines = [];
  let cur = null, row = 0;
  let at = 0;
  while (at < out.length) {
    let end = out.indexOf("\n", at);
    if (end < 0) end = out.length;
    const line = out.slice(at, end);
    at = end + 1;
    if (line.charCodeAt(0) === 9) { lines[row] = cur; continue; }   // "\t<content>": the line itself
    const sp = line.indexOf(" ");
    const head = sp === 40 ? line.slice(0, 40) : null;
    if (head && /^[0-9a-f]{40}$/.test(head)) {
      let c = index.get(head);
      if (c === undefined) {
        c = commits.length;
        index.set(head, c);
        const zero = ZERO.test(head);
        commits.push({ hash: head, author: "", time: 0, summary: "", mine: zero, uncommitted: zero });
      }
      cur = c;
      // "<hash> <orig> <final> [<n>]": final is the 1-based line in the file.
      const parts = line.split(" ");
      row = Number(parts[2]) - 1;
      continue;
    }
    if (cur === null) continue;
    const c = commits[cur];
    if (line.startsWith("author ")) { c.author = line.slice(7); if (user && c.author === user) c.mine = true; }
    else if (line.startsWith("author-time ")) c.time = Number(line.slice(12)) * 1000;
    else if (line.startsWith("summary ")) c.summary = line.slice(8);
  }
  const rows = new Int32Array(lines.length).fill(-1);
  for (let i = 0; i < lines.length; i++) if (lines[i] !== undefined && lines[i] !== null) rows[i] = lines[i];
  return { rows, commits };
}

/** "3 hours ago": a GitLens-like age. */
export function age(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  const unit = (n, w) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (s < 60) return "just now";
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 86400) return unit(Math.floor(s / 3600), "hour");
  if (s < 86400 * 30) return unit(Math.floor(s / 86400), "day");
  if (s < 86400 * 365) return unit(Math.floor(s / 86400 / 30), "month");
  return unit(Math.floor(s / 86400 / 365), "year");
}

/** "You, 3 hours ago • fix: the thing": the note of one commit. */
export function note(c, now = Date.now()) {
  if (c.uncommitted) return "You, Uncommitted changes";
  const who = c.mine ? "You" : c.author || "Unknown";
  return `${who}, ${age(c.time, now)}${c.summary ? ` • ${c.summary}` : ""}`;
}

/** One note per row (the editor's line hints); notes are shared per commit. */
export function hints(b, now = Date.now()) {
  const byCommit = b.commits.map((c) => note(c, now));
  const out = new Array(b.rows.length);
  for (let i = 0; i < b.rows.length; i++) out[i] = b.rows[i] >= 0 ? byCommit[b.rows[i]] : "";
  return out;
}

/** Runs of rows with the same commit, for the blame column: [{ from (row from 0), n, c }]. */
export function runs(b) {
  const out = [];
  for (let i = 0; i < b.rows.length; i++) {
    const c = b.rows[i];
    const last = out[out.length - 1];
    if (last && last.c === c && last.from + last.n === i) last.n++;
    else out.push({ from: i, n: 1, c });
  }
  return out;
}
