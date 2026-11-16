// Tabs for showing (the code view, diffs): see expandTabs.
export const TAB = 4;        // tab stops in the read-only views (VS Code's default)

/**
 * Tabs as spaces to the next tab stop, for showing: the Editor draws a tab as one narrow glyph,
 * so tab-indented code (and tab-aligned columns) came out squashed. Only the shown copy changes:
 * the file, the marks, blame and the edit view keep the real text. Untouched without a tab.
 */
export function expandTabs(text, tab = TAB) {
  if (!text || text.indexOf("\t") < 0) return text;
  let out = "", col = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 9) {
      const n = tab - (col % tab);
      out += text.slice(from, i) + " ".repeat(n);
      col += n; from = i + 1;
    } else if (ch === 10) col = 0;
    else if ((ch & 0xfc00) !== 0xdc00) col++;   // a surrogate pair is one column
  }
  return out + text.slice(from);
}
