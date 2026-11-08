// Splits a Markdown document into prose and fenced code blocks.
// Prose goes to TextView.markdown (GFM is fine there); fences get their own readonly Editor,
// because TextView draws code without colors.
// From bohumil/herdr-file-preview `markdown.js` (MIT). See NOTICE.md.

const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
// Very long prose is cut into chunks at blank lines so one TextView never holds a whole 1 MB file.
const CHUNK = 32000;

/**
 * -> [{ kind: "md", text, start, end } | { kind: "code", info, text, start, end }]
 * start/end: the source lines the block covers, from 1, inclusive (a fence with its fence lines).
 */
export function segment(source) {
  const lines = source.split("\n"), out = [];
  let prose = [], from = 0;
  const flush = () => {
    if (!prose.length) return;
    const text = prose.join("\n");
    prose = [];
    if (!text.trim()) return;
    for (const c of chunks(text)) out.push({ kind: "md", text: c.text, start: from + c.line + 1, end: from + c.line + c.text.split("\n").length });
  };
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]);
    // A backtick fence's info string may not contain backticks (CommonMark).
    if (!m || (m[2][0] === "`" && m[3].includes("`"))) { if (!prose.length) from = i; prose.push(lines[i]); continue; }
    const indent = m[1].length, mark = m[2], info = m[3].trim().split(/\s+/)[0] ?? "";
    const close = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !close.test(lines[j]); j++) body.push(stripIndent(lines[j], indent));
    flush();
    out.push({ kind: "code", info, text: body.join("\n"), start: i + 1, end: Math.min(j, lines.length - 1) + 1 });
    i = j; // an unclosed fence runs to the end of the document
  }
  flush();
  return out;
}

function stripIndent(line, n) {
  let k = 0;
  while (k < n && line[k] === " ") k++;
  return line.slice(k);
}

/** -> [{ text, line }]: line = the chunk's first line within `text`, from 0. */
function chunks(text) {
  if (text.length <= CHUNK) return [{ text, line: 0 }];
  const out = [];
  let start = 0, line = 0;
  while (text.length - start > CHUNK) {
    let cut = text.lastIndexOf("\n\n", start + CHUNK);
    if (cut <= start) cut = text.indexOf("\n\n", start + CHUNK);
    if (cut < 0) break;
    const piece = text.slice(start, cut);
    out.push({ text: piece, line });
    line += piece.split("\n").length + 1;   // the piece, then the blank line it was cut at
    start = cut + 2;
  }
  out.push({ text: text.slice(start), line });
  return out;
}

const QUOTE = /^ {0,3}>/, BLOCK_START = /^\s*([-*+]|\d{1,9}[.)]|#{1,6})(\s|$)|^\s*(```|~~~)/;

/**
 * Splits block quotes out of the prose ({ kind: "quote", text } without their `>`), so the
 * preview draws them with its own accent bar. A quote runs on through lazy continuation lines.
 */
export function splitQuotes(segments) {
  const out = [];
  for (const s of segments) {
    if (s.kind !== "md" || !/^ {0,3}>/m.test(s.text)) { out.push(s); continue; }
    const lines = s.text.split("\n");
    let buf = [], from = 0, quote = false;
    const flush = (end) => {
      if (buf.length) {
        const text = buf.join("\n");
        if (text.trim()) out.push({ kind: quote ? "quote" : "md", text, start: s.start + from, end: s.start + end - 1 });
      }
      buf = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], q = QUOTE.test(l);
      if (q || (quote && l.trim() && !BLOCK_START.test(l))) {
        if (!quote) { flush(i); quote = true; from = i; }
        buf.push(q ? l.replace(/^ {0,3}> ?/, "") : l);
      } else {
        if (quote) { flush(i); quote = false; from = i; }
        buf.push(l);
      }
    }
    flush(lines.length);
  }
  return out;
}

const MD_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMAGE = /<img\b([^>]*)>/gi;
const ATTR = { src: /\bsrc\s*=\s*["']?([^"'\s>]+)/i, alt: /\balt\s*=\s*["']([^"']*)["']/i, width: /\bwidth\s*=\s*["']?(\d+)/i };
const attr = (tag, name) => ATTR[name].exec(tag)?.[1] ?? null;
const WRAPPER = /<\/?(p|a|div|picture|source|center)\b[^>]*>|<br\s*\/?>/gi;
const local = (src) => !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("#") && !src.startsWith("//");

/** The images of a line that holds nothing else (HTML wrappers aside): [{ src, alt, width }], or null. */
function pictureLine(line) {
  if (!/!\[|<img\b/i.test(line)) return null;
  const out = [];
  let rest = line.replace(MD_IMAGE, (_m, alt, src) => { out.push({ src, alt, width: null }); return ""; });
  rest = rest.replace(HTML_IMAGE, (_m, a) => { const src = attr(a, "src"); if (src) out.push({ src, alt: attr(a, "alt") ?? "", width: Number(attr(a, "width")) || null }); return ""; });
  rest = rest.replace(WRAPPER, "");
  return !rest.trim() && out.length && out.every((x) => local(x.src)) ? out : null;
}

/**
 * Splits lines that only show local images out of the prose ({ kind: "pic", pics, center }), as
 * TextView doesn't draw images; the preview draws them from the file's folder.
 */
export function splitPictures(segments) {
  const out = [];
  for (const s of segments) {
    if (s.kind !== "md" || !/!\[|<img\b/i.test(s.text)) { out.push(s); continue; }
    const lines = s.text.split("\n");
    let buf = [], from = 0;
    const flush = (end) => {
      const text = buf.join("\n");
      if (buf.length && text.replace(WRAPPER, "").trim()) out.push({ kind: "md", text, start: s.start + from, end: s.start + end - 1 });
      buf = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const pics = pictureLine(lines[i]);
      if (!pics) { if (!buf.length) from = i; buf.push(lines[i]); continue; }
      flush(i);
      const around = lines.slice(Math.max(0, i - 2), i + 1).join(" ");
      out.push({ kind: "pic", pics, center: /align\s*=\s*["']?center/i.test(around), text: "", start: s.start + i, end: s.start + i });
    }
    flush(lines.length);
  }
  return out;
}
