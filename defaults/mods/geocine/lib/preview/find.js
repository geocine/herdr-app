// Find in the shown document: case-insensitive matches in a code file (by line) or in Markdown
// (by block, each match wrapped in a <mark> where that can't change how the text parses), and
// the headings a match sits under.
// Adapted from bohumil/herdr-file-preview `find.js` (MIT). See NOTICE.md.

/** Occurrences of q (lowered) in text: [{ line, n }] by line (from 0), and the total. */
export function occurrences(text, q) {
  const out = [];
  if (!q) return { lines: out, total: 0 };
  const s = text.toLowerCase();
  let total = 0, line = 0, pos = 0;
  for (let i = s.indexOf(q); i >= 0; i = s.indexOf(q, i + q.length)) {
    for (let k = s.indexOf("\n", pos); k >= 0 && k < i; k = s.indexOf("\n", pos)) { line++; pos = k + 1; }
    total++;
    const last = out[out.length - 1];
    if (last && last.line === line) last.n++;
    else out.push({ line, n: 1 });
  }
  return { lines: out, total };
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** ATX headings of the prose blocks: [{ line (from 1), text }], in order. */
export function headings(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.kind !== "md" || !b.start) continue;
    b.text.split("\n").forEach((l, k) => {
      const m = HEADING.exec(l);
      if (m && m[2]) out.push({ line: b.start + k, text: m[2].replace(/[`*_]/g, "") });
    });
  }
  return out;
}

/** The heading a line sits under, or null. */
export function section(heads, line) {
  let h = null;
  for (const x of heads) { if (x.line > line) break; h = x; }
  return h;
}

/** toLowerCase that keeps every index in place (a char whose lower case is longer stays as is). */
function lowerSame(text) {
  const s = text.toLowerCase();
  if (s.length === text.length) return s;
  let out = "";
  for (const ch of text) { const l = ch.toLowerCase(); out += l.length === ch.length ? l : ch; }
  return out;
}

/** Every occurrence of q (lowered) in text: [{ at, line }] (line from 0), in order. */
export function positions(text, q) {
  const out = [];
  if (!q) return out;
  const s = lowerSame(text);
  let line = 0, pos = 0;
  for (let i = s.indexOf(q); i >= 0; i = s.indexOf(q, i + q.length)) {
    for (let k = s.indexOf("\n", pos); k >= 0 && k < i; k = s.indexOf("\n", pos)) { line++; pos = k + 1; }
    out.push({ at: i, line });
  }
  return out;
}

// ---- Match highlights in Markdown prose -------------------------------------------------
// TextView's Markdown draws inline <mark color="…">. Wrapping a match must never change how
// the rest parses, so a match is wrapped only when every char of it is plain prose (the mask
// below) and it holds no Markdown-special char. Everything else keeps just the block bar.

// Line-start containers: blockquote `>`, list markers (with a task box), one per step.
const LEAD = /^[ \t]*(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?(?=[ \t]|$))/;
const ATX = /^[ \t]*#{1,6}(?=[ \t]|$)/, ATX_END = /[ \t]+#+[ \t]*$/;
const ITEM = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/;
// Lines that are syntax as a whole: thematic breaks, setext underlines, link reference and
// footnote definitions (and table delimiter rows, below).
const WHOLE = [
  /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  /^ {0,3}(?:=+|-+)[ \t]*$/,
  /^ {0,3}\[[^\]]+\]:/,
];
const TABLE = /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)?\|?[ \t]*$|^[ \t]*\|?[ \t]*:?-+:?[ \t]*\|[ \t]*$/;

/** [from, to) of each cell of a table row (offsets in the line), split at unescaped pipes. */
function cells(line) {
  const out = [];
  let from = 0;
  for (let i = 0; i <= line.length; i++) {
    if (line[i] === "\\") { i++; continue; }
    if (i < line.length && line[i] !== "|") continue;
    if (i > from || out.length || line.slice(0, i).trim()) out.push([from, i]);
    from = i + 1;
  }
  if (out.length && !line.slice(out[out.length - 1][0]).trim()) out.pop();   // after a closing pipe
  return out;
}
const ENTITY = /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/y;
const TAG = /<(?:\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?|![^<>]*|\?[^<>]*\?)>/y;
const RAW = /^<(pre|script|style|textarea)\b/i;   // HTML whose content is not Markdown
const BARE = /(?:https?:\/\/|ftp:\/\/|www\.)\S+|[\w.+-]+@[\w-]+\.[\w.-]+/y;   // GFM bare links
const SPECIAL = /[\\`*_~[\]<>&|\n]/;
const DELIM = "*_~", WORD = /[\p{L}\p{N}]/u;

/** The text a sticky regex matches at `i`, or null. */
function stick(re, text, i) {
  re.lastIndex = i;
  const m = re.exec(text);
  return m ? m[0] : null;
}

/** The index of the bracket closing the one at `i` (`[`→`]`, `(`→`)`), or -1; never past a blank line. */
function closing(text, i) {
  const open = text[i], close = open === "[" ? "]" : ")";
  for (let j = i + 1, depth = 0; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") { j++; continue; }
    if (c === "\n" && text[j + 1] === "\n") return -1;
    if (c === open) depth++;
    else if (c === close) { if (!depth) return j; depth--; }
  }
  return -1;
}

/** Uint8Array over a prose chunk: 1 where a char is Markdown syntax, code, a link target or HTML. */
export function syntaxMask(text) {
  const n = text.length, bad = new Uint8Array(n);
  const set = (a, b) => bad.fill(1, a, Math.min(b, n));
  // TextView misplaces a mark in a centered or right-aligned table cell: those cells get none.
  // aligned: true per column that isn't left-aligned, while in a table.
  let aligned = null;
  const skipCells = (s, line) => { for (const [k, [a, b]] of cells(line).entries()) if (aligned[k] ?? true) set(s + a, s + b); };
  // Line starts: containers, heading marks, whole syntax lines, indented code.
  let prevBlank = true, list = false, prev = null;
  for (let s = 0; s < n; ) {
    let e = text.indexOf("\n", s);
    if (e < 0) e = n;
    const line = text.slice(s, e);
    if (aligned && (!line.trim() || !line.includes("|"))) aligned = null;
    if (line.trim()) {
      if (prev && TABLE.test(line)) {   // the delimiter row: its header row is the line before
        aligned = cells(line).map(([a, b]) => /-[ \t]*:[ \t]*$/.test(line.slice(a, b)));
        set(s, e);
        skipCells(prev.s, prev.line);
      } else if (aligned) skipCells(s, line);
      if (prevBlank && !list && /^(?: {4}|\t)/.test(line)) set(s, e);
      else if (WHOLE.some((r) => r.test(line))) set(s, e);
      else {
        let k = 0;
        for (let m = LEAD.exec(line); m && m[0].length; m = LEAD.exec(line.slice(k))) k += m[0].length;
        const h = ATX.exec(line.slice(k));
        if (h) { k += h[0].length; const t = ATX_END.exec(line); if (t) set(s + t.index, e); }
        set(s, s + k);
      }
      list = ITEM.test(line) || (list && /^[ \t]/.test(line));
    }
    prevBlank = !line.trim();
    prev = prevBlank ? null : { s, line };
    s = e + 1;
  }
  // Inline syntax, left to right (code spans and comments may run over lines).
  for (let i = 0; i < n; i++) {
    if (bad[i]) continue;
    const c = text[i];
    if (c === "\\") { set(i, i + 2); i++; continue; }
    if (c === "`") {
      let r = 1;
      while (text[i + r] === "`") r++;
      const run = "`".repeat(r);
      let j = text.indexOf(run, i + r);
      while (j >= 0 && text[j + r] === "`") { let k = j; while (text[k] === "`") k++; j = text.indexOf(run, k); }
      set(i, j >= 0 ? j + r : i + r);   // no closing run: the backticks are literal, still skipped
      i = (j >= 0 ? j + r : i + r) - 1;
      continue;
    }
    if (c === "&") { const m = stick(ENTITY, text, i); if (m) set(i, i + m.length); continue; }
    if (c === "<") {
      let end = i + 1, m;
      if (text.startsWith("<!--", i)) { const k = text.indexOf("-->", i + 4); end = k < 0 ? n : k + 3; }
      else if ((m = RAW.exec(text.slice(i, i + 12)))) { const k = lowerSame(text).indexOf(`</${m[1].toLowerCase()}`, i); end = k < 0 ? n : text.indexOf(">", k) + 1 || n; }
      else if ((m = stick(AUTOLINK, text, i) ?? stick(TAG, text, i))) end = i + m.length;
      set(i, end);
      i = end - 1;
      continue;
    }
    if (c === "[" || (c === "!" && text[i + 1] === "[")) {
      const o = c === "!" ? i + 1 : i, j = closing(text, o);
      if (j < 0) { set(i, o + 1); continue; }
      const next = text[j + 1];
      // An image is all syntax to us (its alt text is no place for a mark).
      if (c === "!") { const k = next === "(" || next === "[" ? closing(text, j + 1) : -1; set(i, (k < 0 ? j : k) + 1); i = k < 0 ? j : k; continue; }
      if (next === "(") { const k = closing(text, j + 1); set(i, i + 1); set(j, (k < 0 ? j + 1 : k) + 1); continue; }   // [text](dest "title")
      if (next === "[" && text[j + 2] !== "]") { const k = closing(text, j + 1); set(i, i + 1); set(j, (k < 0 ? j + 1 : k) + 1); continue; }   // [text][label]
      set(i, j + (next === "[" ? 3 : 1));   // [label], [label][], [^note], [ ]: the label is the link
      i = j;
      continue;
    }
    if (/\w/.test(c) && (i === 0 || !/[\w.+-]/.test(text[i - 1]))) {
      const m = stick(BARE, text, i);
      if (m) { set(i, i + m.length); i += m.length - 1; }
    }
  }
  return bad;
}

/** Whether the match [at, at + len) may be wrapped in a <mark> (see syntaxMask). */
function markable(text, bad, at, len) {
  if (SPECIAL.test(text.slice(at, at + len))) return false;
  for (let k = at; k < at + len; k++) if (bad[k]) return false;
  // `a**b**c`: emphasis inside a word only parses while touching its letters. Leave those.
  let p = at;
  while (p > 0 && DELIM.includes(text[p - 1])) p--;
  if (p < at && p > 0 && WORD.test(text[p - 1])) return false;
  p = at + len;
  while (p < text.length && DELIM.includes(text[p])) p++;
  if (p > at + len && p < text.length && WORD.test(text[p])) return false;
  return true;
}

/**
 * A prose chunk with matches wrapped in <mark>: `hits` [{ at }] of length `len`; `color(k)`
 * is the background of hit k. Hits that touch syntax stay unwrapped. -> { text, marked }
 */
export function markMatches(text, hits, len, color, bad = syntaxMask(text)) {
  let out = "", from = 0, marked = 0;
  hits.forEach((h, k) => {
    if (!markable(text, bad, h.at, len)) return;
    out += text.slice(from, h.at) + `<mark color="${color(k)}">` + text.slice(h.at, h.at + len) + "</mark>";
    from = h.at + len;
    marked++;
  });
  return { text: out + text.slice(from), marked };
}
