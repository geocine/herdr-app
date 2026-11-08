// What the Diff's virtual list shows, as plain data (no gpui). Ported from JinJieBeWater/herdr-t3
// `extras/mods/review/rows.js` (Apache-2.0): runs of lines per item, split pairs, one height scale.
// See NOTICE.md.

// Heights: a code line, a hunk header, a note under a header, a file header.
export const ROW = 20, HUNK = 22, NOTE = 28, FILE = 32;
// A 12px mono column (JetBrains Mono, Geist Mono and most terminal fonts are close to it).
export const CHAR = 7.2;
// Past this many columns a line is cut, not scrolled to.
export const MAX_COLUMNS = 600;
// Lines per list item: the list takes at most 10,000 items.
export const RUN = 32;
// A file with more changed lines than this starts folded (a click shows it).
export const LARGE = 1500;

export const expandTabs = (s) => s.replaceAll("\t", "    ");

/** Context on both sides; a run of deletions faces the additions that follow it. */
export function pairRows(lines) {
  const pairs = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (l.kind === "ctx" || l.kind === "meta") { pairs.push({ left: l, right: l }); i++; continue; }
    const dels = [], adds = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    if (!dels.length && !adds.length) { i++; continue; }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) pairs.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return pairs;
}

/**
 * Word-level changes, cheaply: a run of deletions and the additions after it are paired line by
 * line; each pair's common start and end are the same, the middle is what changed. Sets
 * `line.range = [start, end]` (in tab-expanded text) when the pair is alike enough to be worth it.
 */
export function markWords(lines) {
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind !== "del") { i++; continue; }
    const dels = [], adds = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    if (dels.length !== adds.length || dels.length > 64) continue;
    for (let k = 0; k < dels.length; k++) {
      const a = expandTabs(dels[k].text), b = expandTabs(adds[k].text);
      if (a.length > 1000 || b.length > 1000) continue;
      let p = 0;
      while (p < a.length && p < b.length && a[p] === b[p]) p++;
      let s = 0;
      while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
      // Grow to word edges, so a changed word lights as a whole.
      const w = (c) => c !== undefined && /\w/.test(c);
      if (w(a[p]) || w(b[p])) while (p > 0 && w(a[p - 1])) p--;
      if (w(a[a.length - s - 1]) || w(b[b.length - s - 1])) while (s > 0 && w(a[a.length - s])) s--;
      const same = p + s, longest = Math.max(a.length, b.length);
      if (!longest || same < longest * 0.3 || same === longest) continue;
      if (a.length - s > p) dels[k].range = [p, a.length - s];
      if (b.length - s > p) adds[k].range = [p, b.length - s];
    }
  }
}

// A line's width in columns, tabs expanded, cut at MAX_COLUMNS (kept on the line).
function columns(line) {
  if (line.cols === undefined) {
    const text = line.text;
    line.cols = Math.min(MAX_COLUMNS, text.indexOf("\t") < 0 ? text.length : expandTabs(text).length);
  }
  return line.cols;
}

/**
 * The list's items for files: a header each and, unless folded, its hunks: a header row per hunk
 * and its lines in runs of RUN. Notes stand for what has no lines (binary, renamed, too large).
 * open(file) says whether a file is unfolded; ready(file, index) false leaves a "Loading…" note
 * in place of its lines. → { items, most: [unified, left, right], digits }
 * A file's own items are built once per layout (kept on the file), so folding one file or
 * marking it viewed costs a walk over the files, not over every line again.
 */
export function buildItems(files, { open, split, ready = () => true }) {
  const items = [], most = [0, 0, 0];
  let digits = 1;
  for (let index = 0; index < files.length; index++) {
    const file = files[index], key = fileKey(file, index);
    items.push({ key: `f:${key}`, kind: "file", file, index, size: FILE });
    if (!open(file)) continue;
    // ready(file, index) false: its lines aren't worked out yet; a note holds the place.
    if (!ready(file, index)) { items.push({ key: `w:${key}`, kind: "note", file, text: "Loading…", size: NOTE }); continue; }
    const body = fileItems(file, key, split);
    for (const item of body.items) items.push(item);
    for (let k = 0; k < 3; k++) if (body.most[k] > most[k]) most[k] = body.most[k];
    if (body.digits > digits) digits = body.digits;
  }
  return { items, most, digits };
}

/** True when the file's open body is built already for this layout (no line work left). */
export const isBuilt = (file, index, split) => file.built?.tag === bodyTag(file, fileKey(file, index), split);
const bodyTag = (file, key, split) => `${split ? 1 : 0}:${file.large && !file.shown ? 1 : 0}:${key}`;

// One unfolded file's items after its header, with its widest line and its longest number.
export function fileItems(file, key, split) {
  const tag = bodyTag(file, key, split);
  if (file.built?.tag === tag) return file.built;
  const items = [], most = [0, 0, 0];
  let digits = 1;
  const done = () => (file.built = { tag, items, most, digits });
  const lines = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  if (file.large && !file.shown) { items.push({ key: `l:${key}`, kind: "note", file, text: `Large diff · ${lines.toLocaleString("en-US")} lines · click to show`, action: "show", size: NOTE }); return done(); }
  if (file.binary) { items.push({ key: `n:${key}`, kind: "note", file, text: "Binary file · no text diff", size: NOTE }); return done(); }
  if (!file.hunks.length) {
    const text = file.status === "R" ? "Renamed without changes" : file.status === "C" ? "Copied without changes" : file.status === "T" ? "File type changed" : file.oldMode && file.newMode && file.oldMode !== file.newMode ? `Mode ${file.oldMode} → ${file.newMode}` : "No content changes";
    items.push({ key: `n:${key}`, kind: "note", file, text, size: NOTE });
    return done();
  }
  const solo = split && (file.status === "A" || file.status === "D");
  const kind = !split ? "rows" : solo ? "solo" : "pairs";
  for (let h = 0; h < file.hunks.length; h++) {
    const hunk = file.hunks[h];
    items.push({ key: `h:${key}:${h}`, kind: "hunk", file, hunk, size: HUNK });
    if (!hunk.marked) { markWords(hunk.lines); hunk.marked = true; }
    const last = hunk.lines[hunk.lines.length - 1];
    digits = Math.max(digits, String(Math.max(hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines, last?.old ?? 0, last?.new ?? 0)).length);
    const rows = kind === "pairs" ? pairRows(hunk.lines) : hunk.lines;
    for (let r = 0; r < rows.length; r += RUN) {
      const run = rows.slice(r, r + RUN);
      items.push({ key: `r:${key}:${h}:${r}`, kind, file, lines: run, size: run.length * ROW });
      if (kind === "pairs") {
        for (const row of run) {
          if (row.left && columns(row.left) > most[1]) most[1] = row.left.cols;
          if (row.right && columns(row.right) > most[2]) most[2] = row.right.cols;
        }
      } else for (const row of run) if (columns(row) > most[0]) most[0] = row.cols;
    }
  }
  if (file.truncated) items.push({ key: `t:${key}`, kind: "note", file, text: "Diff cut here: too many lines", size: NOTE });
  return done();
}

// A file's identity in the list: its path (and its place, should a diff name a path twice).
export const fileKey = (file, index) => `${index}:${file.path ?? file.oldPath}`;
