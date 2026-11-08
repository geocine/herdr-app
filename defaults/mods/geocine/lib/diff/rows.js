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

const columns = (text) => Math.min(MAX_COLUMNS, expandTabs(text).length);

/**
 * The list's items for files: a header each and, unless folded, its hunks: a header row per hunk
 * and its lines in runs of RUN. Notes stand for what has no lines (binary, renamed, too large).
 * open(file) says whether a file is unfolded. → { items, width: [unified, left, right], digits }
 */
export function buildItems(files, { open, split }) {
  const items = [];
  let most = [0, 0, 0], digits = 1;
  for (const [index, file] of files.entries()) {
    const key = fileKey(file, index);
    items.push({ key: `f:${key}`, kind: "file", file, index, size: FILE });
    if (!open(file)) continue;
    const lines = file.hunks.reduce((n, h) => n + h.lines.length, 0);
    if (file.large && !file.shown) { items.push({ key: `l:${key}`, kind: "note", file, text: `Large diff · ${lines.toLocaleString("en-US")} lines · click to show`, action: "show", size: NOTE }); continue; }
    if (file.binary) { items.push({ key: `n:${key}`, kind: "note", file, text: "Binary file · no text diff", size: NOTE }); continue; }
    if (!file.hunks.length) {
      const text = file.status === "R" ? "Renamed without changes" : file.status === "C" ? "Copied without changes" : file.status === "T" ? "File type changed" : file.oldMode && file.newMode && file.oldMode !== file.newMode ? `Mode ${file.oldMode} → ${file.newMode}` : "No content changes";
      items.push({ key: `n:${key}`, kind: "note", file, text, size: NOTE });
      continue;
    }
    const solo = split && (file.status === "A" || file.status === "D");
    const kind = !split ? "rows" : solo ? "solo" : "pairs";
    for (const [h, hunk] of file.hunks.entries()) {
      items.push({ key: `h:${key}:${h}`, kind: "hunk", file, hunk, size: HUNK });
      if (!hunk.marked) { markWords(hunk.lines); hunk.marked = true; }
      const last = hunk.lines[hunk.lines.length - 1];
      digits = Math.max(digits, String(Math.max(hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines, last?.old ?? 0, last?.new ?? 0)).length);
      const rows = kind === "pairs" ? pairRows(hunk.lines) : hunk.lines;
      for (let r = 0; r < rows.length; r += RUN) {
        const run = rows.slice(r, r + RUN);
        items.push({ key: `r:${key}:${h}:${r}`, kind, file, lines: run, size: run.length * ROW });
        for (const row of run) {
          if (kind === "pairs") {
            if (row.left) most[1] = Math.max(most[1], columns(row.left.text));
            if (row.right) most[2] = Math.max(most[2], columns(row.right.text));
          } else most[0] = Math.max(most[0], columns(row.text));
        }
      }
    }
    if (file.truncated) items.push({ key: `t:${key}`, kind: "note", file, text: "Diff cut here: too many lines", size: NOTE });
  }
  return { items, most, digits };
}

// A file's identity in the list: its path (and its place, should a diff name a path twice).
export const fileKey = (file, index) => `${index}:${file.path ?? file.oldPath}`;
