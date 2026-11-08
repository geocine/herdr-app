// Diffs from plain git, for every Geocine view: parseDiff reads unified `git diff` / `git show`
// output, loadDiff runs the right git for a source (worktree, index, untracked, HEAD, a commit).
// No gpui here: plain data, so it can be tested anywhere.
// Hunk numbering follows herdr-file-preview `commits.js` (MIT); the shapes are DESIGN.md's.
import { readTextFile } from "herdr";
import { gitRead } from "../git.js";

// What one diff may hold before it is cut (lines per file, lines in all), so a huge change stays usable.
export const MAX_FILE_LINES = 20000, MAX_LINES = 200000;
// Untracked files read per diff: each is one `git diff --no-index`.
export const MAX_UNTRACKED = 300;
// Empty tree object ids, to diff an unborn repo's index and worktree against "nothing".
const EMPTY_TREE = { sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha256: "6ef19b41225c5369f1c104d45d8d85efa9b1ba5bd0cc3aa3d6e5a6c0d5da8a7b" };
// Every diff we run: no colors, no external or textconv drivers, fixed a/ b/ prefixes whatever
// diff.noprefix / diff.mnemonicPrefix say.
export const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

// UTF-8 bytes → text (the runtime may lack TextDecoder).
function utf8(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    const n = b < 0x80 ? 0 : b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1;
    if (n < 0 || i + n >= bytes.length + (n ? 0 : 1)) { out += String.fromCharCode(b); i++; continue; }
    let cp = n ? b & (0x3f >> n) : b;
    for (let k = 1; k <= n; k++) cp = (cp << 6) | (bytes[i + k] & 0x3f);
    out += String.fromCodePoint(cp); i += n + 1;
  }
  return out;
}

// Git's C-quoted path ("a/t\303\244st" with \t, \n, \", \\ and octal bytes), or a plain one.
function unquote(s) {
  if (!s.startsWith('"')) return s;
  const bytes = [];
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') break;
    if (c !== "\\") {
      const cp = s.codePointAt(i);
      if (cp < 0x80) bytes.push(cp);
      else { const ch = String.fromCodePoint(cp); if (ch.length === 2) i++; for (const b of unescape(encodeURIComponent(ch))) bytes.push(b.charCodeAt(0)); }
      continue;
    }
    const n = s[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(s.slice(i, i + 3), 8)); i += 2; continue; }
    bytes.push(({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 })[n] ?? n.charCodeAt(0));
  }
  return utf8(bytes);
}

// One path out of "a/x" / "b/x" / "/dev/null" (null), quoted or not.
function side(s) {
  const p = unquote(s.replace(/\t$/, ""));
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

// The two paths of "diff --git a/x b/y". Without quotes and with spaces in names the split is
// ambiguous: same names (the usual case) split in the middle; else at " b/".
function gitHeaderPaths(rest) {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    const a = rest.slice(0, end + 1), b = rest.slice(end + 2);
    return [side(a), side(b)];
  }
  if (rest.endsWith('"')) {
    const at = rest.lastIndexOf(' "');
    return [side(rest.slice(0, at)), side(rest.slice(at + 1))];
  }
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2, a = rest.slice(0, half), b = rest.slice(half + 1);
    if (a.slice(2) === b.slice(2)) return [side(a), side(b)];
  }
  const at = rest.indexOf(" b/");
  return at < 0 ? [side(rest), side(rest)] : [side(rest.slice(0, at)), side(rest.slice(at + 1))];
}

const kindOfMode = (m) => (m ? m.slice(0, 2) : null);   // 10 file, 12 symlink, 16 submodule

/**
 * Unified diff text → [{ path, oldPath, status, binary, adds, dels, hunks: [{ header, oldStart,
 * newStart, oldLines, newLines, lines: [{ kind: "add" | "del" | "ctx" | "meta", text, old, new }] }],
 * oldSha, newSha, oldMode, newMode, similarity, truncated }].
 * status: A M D R C T (git's letters). old/new: the line's number on that side, null when absent.
 * Reads `git diff`, `git diff --cached`, `git show`, `git diff --no-index`; also `diff --cc`
 * (combined hunks: a line is removed when any parent column says so, added when one says +).
 */
export function parseDiff(text, { maxFileLines = MAX_FILE_LINES, maxLines = MAX_LINES } = {}) {
  const files = [];
  if (!text) return files;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let file = null, hunk = null, oldLeft = 0, newLeft = 0, oldAt = 0, newAt = 0, total = 0;
  const finish = () => {
    if (!file) return;
    if (!file.status) file.status = !file.oldPath && file.path ? "A" : file.oldPath && !file.path ? "D" : "M";
    if (file.status === "D") file.path = file.oldPath;
    if (file.status === "A") file.oldPath = null;
    if (file.status === "M" && file.oldMode && file.newMode && kindOfMode(file.oldMode) !== kindOfMode(file.newMode)) file.status = "T";
    if (file.oldPath === file.path && file.status !== "R" && file.status !== "C") file.oldPath = null;
    files.push(file);
  };
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (l.endsWith("\r") && !hunk) l = l.slice(0, -1);
    // Inside a hunk, its counts say where it ends (a line may itself start with "diff ").
    // A combined hunk (diff --cc) has a column per parent and ends where its lines do.
    // Read against the first parent: its column says added, removed or kept.
    if (hunk && file.combined && /^[ +\-\\]/.test(l)) {
      if (l[0] === "\\") { hunk.lines.push({ kind: "meta", text: l, old: null, new: null }); continue; }
      const marks = l.slice(0, hunk.parents), text = l.slice(hunk.parents);
      let line;
      if (marks[0] === "-") { line = { kind: "del", text, old: oldAt++, new: null }; file.dels++; }
      else if (marks[0] === "+") { line = { kind: "add", text, old: null, new: newAt++ }; file.adds++; }
      else if (marks.includes("-")) continue;   // only in another parent
      else line = { kind: "ctx", text, old: oldAt++, new: newAt++ };
      if (file.kept >= maxFileLines || total >= maxLines) { file.truncated = true; continue; }
      if (line.text.endsWith("\r")) line.text = line.text.slice(0, -1);
      hunk.lines.push(line); file.kept++; total++;
      continue;
    }
    if (hunk && !file.combined && (oldLeft > 0 || newLeft > 0 || l.startsWith("\\"))) {
      const c = l[0];
      if (c === "\\") { hunk.lines.push({ kind: "meta", text: l, old: null, new: null }); continue; }
      let line;
      if (c === "+") { line = { kind: "add", text: l.slice(1), old: null, new: newAt++ }; newLeft--; file.adds++; }
      else if (c === "-") { line = { kind: "del", text: l.slice(1), old: oldAt++, new: null }; oldLeft--; file.dels++; }
      else { line = { kind: "ctx", text: c === " " ? l.slice(1) : l, old: oldAt++, new: newAt++ }; oldLeft--; newLeft--; }
      if (file.kept >= maxFileLines || total >= maxLines) { file.truncated = true; continue; }
      if (line.text.endsWith("\r")) line.text = line.text.slice(0, -1);
      hunk.lines.push(line); file.kept++; total++;
      continue;
    }
    hunk = null;
    if (l.startsWith("diff --git ") || l.startsWith("diff --cc ") || l.startsWith("diff --combined ")) {
      finish();
      const combined = !l.startsWith("diff --git ");
      const [a, b] = combined ? [side(l.slice(l.indexOf(" ", 7) + 1)), side(l.slice(l.indexOf(" ", 7) + 1))] : gitHeaderPaths(l.slice(11));
      file = { path: b, oldPath: a, status: null, binary: false, adds: 0, dels: 0, hunks: [], oldSha: null, newSha: null, oldMode: null, newMode: null, similarity: null, truncated: false, kept: 0, combined };
      continue;
    }
    if (!file) continue;
    if (l.startsWith("@@")) {
      // @@ -a,b +c,d @@ (or @@@ -a,b -c,d +e,f @@@ for combined: the first parent and the result).
      const m = /^@@+ -(\d+)(?:,(\d+))?(?: -\d+(?:,\d+)?)* \+(\d+)(?:,(\d+))? @@+(.*)$/.exec(l);
      if (!m) continue;
      oldAt = Number(m[1]); newAt = Number(m[3]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]); newLeft = m[4] === undefined ? 1 : Number(m[4]);
      hunk = { header: l, context: m[5].trim(), oldStart: oldAt, newStart: newAt, oldLines: oldLeft, newLines: newLeft, lines: [] };
      file.hunks.push(hunk);
      hunk.parents = Math.max(1, (/^@+/.exec(l)[0].length) - 1);
      continue;
    }
    if (l.startsWith("--- ")) { file.oldPath = side(l.slice(4)); continue; }
    if (l.startsWith("+++ ")) { file.path = side(l.slice(4)); continue; }
    if (l.startsWith("new file mode ")) { file.status = "A"; file.newMode = l.slice(14); file.oldPath = null; continue; }
    if (l.startsWith("deleted file mode ")) { file.status = "D"; file.oldMode = l.slice(18); continue; }
    if (l.startsWith("old mode ")) { file.oldMode = l.slice(9); continue; }
    if (l.startsWith("new mode ")) { file.newMode = l.slice(9); continue; }
    if (l.startsWith("rename from ")) { file.status = "R"; file.oldPath = unquote(l.slice(12)); continue; }
    if (l.startsWith("rename to ")) { file.status = "R"; file.path = unquote(l.slice(10)); continue; }
    if (l.startsWith("copy from ")) { file.status = "C"; file.oldPath = unquote(l.slice(10)); continue; }
    if (l.startsWith("copy to ")) { file.status = "C"; file.path = unquote(l.slice(8)); continue; }
    if (l.startsWith("similarity index ")) { file.similarity = parseInt(l.slice(17), 10); continue; }
    if (l.startsWith("index ")) {
      const m = /^index ([0-9a-f]+)(?:,[0-9a-f]+)*\.\.([0-9a-f]+)(?: (\d+))?/.exec(l);
      if (m) { file.oldSha = m[1]; file.newSha = m[2]; if (m[3]) file.oldMode = file.newMode = m[3]; }
      continue;
    }
    if (/^Binary files .* differ$/.test(l) || l === "GIT binary patch") { file.binary = true; continue; }
  }
  finish();
  for (const f of files) {
    delete f.kept; delete f.combined;
    if (f.newSha && /^0+$/.test(f.newSha)) f.newSha = null;
    if (f.oldSha && /^0+$/.test(f.oldSha)) f.oldSha = null;
  }
  return files;
}

// `--numstat -z` → Map(path → { adds, dels, binary }) (renames under their new path).
export function parseNumstat(text) {
  const out = new Map(), parts = String(text ?? "").split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i].replace(/^\n+/, ""));
    if (!m) continue;
    let path = m[3];
    if (path === "") { path = parts[i + 2]; i += 2; }
    out.set(path, { adds: m[1] === "-" ? 0 : Number(m[1]), dels: m[2] === "-" ? 0 : Number(m[2]), binary: m[1] === "-" });
  }
  return out;
}

const pathspec = (paths) => (paths?.length ? ["--", ...paths.map(p => `:(top,literal)${p}`)] : []);

async function hasHead(top, on) {
  const r = await gitRead(["rev-parse", "-q", "--verify", "HEAD^{commit}"], top, { on });
  return r.code === 0;
}

async function emptyTree(top, on) {
  const r = await gitRead(["rev-parse", "--show-object-format"], top, { on }).catch(() => null);
  return EMPTY_TREE[r?.stdout.trim()] ?? EMPTY_TREE.sha1;
}

async function run(args, top, on) {
  const r = await gitRead(args, top, { on, timeout: 60000 });
  if (r.code !== 0 && !(args.includes("--no-index") && r.code === 1)) throw new Error((r.stderr || r.stdout || `git ${args[0]} failed`).trim().split("\n")[0]);
  return r.stdout;
}

// The untracked files (repo-relative), optionally only those in `paths`.
export async function untrackedFiles(top, on, paths) {
  const out = await run(["ls-files", "--others", "--exclude-standard", "-z", ...pathspec(paths)], top, on);
  return out.split("\0").filter(Boolean);
}

// A text's hash, standing in for a blob id (what a viewed mark is kept against).
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `t${(h >>> 0).toString(16)}${text.length.toString(16)}`;
}

const blank = (p) => ({ path: p, oldPath: null, status: "A", binary: false, adds: 0, dels: 0, hunks: [], oldSha: null, newSha: null, oldMode: null, newMode: null, similarity: null, truncated: false, untracked: true });

// One untracked file as a whole added file: read as text (no process per file), else by git.
async function untrackedDiff(top, on, p) {
  const text = await readTextFile(`${top}/${p}`, { on }).catch(() => undefined);
  if (typeof text === "string" && text.length < 1000000) {
    const f = blank(p);
    f.newSha = hash(text);
    if (text.includes("\0")) { f.binary = true; return f; }
    if (!text) return f;
    const lines = text.replace(/\r?\n$/, "").split(/\r?\n/), kept = lines.slice(0, MAX_FILE_LINES);
    f.adds = lines.length; f.truncated = kept.length < lines.length;
    f.hunks = [{ header: `@@ -0,0 +1,${lines.length} @@`, context: "", oldStart: 0, newStart: 1, oldLines: 0, newLines: lines.length,
      lines: kept.map((l, i) => ({ kind: "add", text: l, old: null, new: i + 1 })) }];
    if (!/\n$/.test(text)) f.hunks[0].lines.push({ kind: "meta", text: "\\ No newline at end of file", old: null, new: null });
    return f;
  }
  const parsed = parseDiff(await run(["diff", ...DIFF_FLAGS, "--no-index", "--", "/dev/null", p], top, on).catch(() => ""));
  // --no-index names the path as given; keep it repo-relative and "/"-separated.
  return Object.assign(parsed[0] ?? blank(p), { path: p, oldPath: null, status: "A", untracked: true });
}

// The diffs of untracked files: each one as a whole added file.
async function untrackedDiffs(top, on, paths) {
  const all = await untrackedFiles(top, on, paths), list = all.slice(0, MAX_UNTRACKED), files = [];
  for (let i = 0; i < list.length; i += 16) files.push(...await Promise.all(list.slice(i, i + 16).map(p => untrackedDiff(top, on, p))));
  if (all.length > list.length) files.more = all.length - list.length;
  return files;
}

/**
 * The diff of a source, parsed: Promise<files> (parseDiff's shape; untracked files have
 * `untracked: true`). Rejects with git's message when git fails.
 *   source.kind: "unstaged" worktree vs index · "staged" index vs HEAD · "untracked" whole files
 *   as added · "head" everything uncommitted vs HEAD, untracked included · "commit" source.rev vs
 *   its first parent (a root commit: everything added).
 * paths: repo-relative files to limit it to; all when absent.
 */
export async function loadDiff({ on = null, top, source, paths } = {}) {
  if (!top || !source) return [];
  const kind = source.kind, spec = pathspec(paths);
  if (kind === "unstaged") return parseDiff(await run(["diff", ...DIFF_FLAGS, ...spec], top, on));
  if (kind === "staged") {
    const base = (await hasHead(top, on)) ? [] : [await emptyTree(top, on)];
    return parseDiff(await run(["diff", ...DIFF_FLAGS, "--cached", "-M", ...base, ...spec], top, on));
  }
  if (kind === "untracked") return untrackedDiffs(top, on, paths);
  if (kind === "head") {
    const base = (await hasHead(top, on)) ? "HEAD" : await emptyTree(top, on);
    const [tracked, fresh] = await Promise.all([run(["diff", ...DIFF_FLAGS, "-M", base, ...spec], top, on), untrackedDiffs(top, on, paths)]);
    const files = parseDiff(tracked), seen = new Set(files.map(f => f.path));
    for (const f of fresh) if (!seen.has(f.path)) files.push(f);
    if (fresh.more) files.more = fresh.more;
    return files;
  }
  if (kind === "commit") {
    const rev = source.rev;
    if (!rev) return [];
    return parseDiff(await run(["show", ...DIFF_FLAGS, "--format=", "-m", "--first-parent", "-M", rev, ...spec], top, on));
  }
  throw new Error(`Unknown diff source: ${kind}`);
}
