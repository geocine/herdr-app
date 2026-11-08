// Fuzzy path matching for search: the query's characters in order, anywhere in the path
// ("fvidx" finds files/views/index.js). Spaces split the query into words that must all match.
// A match inside the file name, at word starts, in a run or as a plain substring ranks higher;
// long paths and gaps rank lower. Positions come back for drawing the matched characters.

const BOUNDARY = /[\/\\_\-. ]/;
const isUpper = (c) => c >= "A" && c <= "Z";

// The tightest window [start, end] where `q` matches `low` from `from`, fzf v1 style: forward to
// the first full match, then backward from its end. Null when it doesn't match.
function window(low, q, from) {
  let i = from, j = 0;
  for (; i < low.length && j < q.length; i++) if (low[i] === q[j]) j++;
  if (j < q.length) return null;
  const end = i - 1;
  let k = end;
  j = q.length - 1;
  for (; k >= from; k--) if (low[k] === q[j] && --j < 0) break;
  return [k, end];
}

// Scores `q` (lower case, no spaces) against `text`/`low` from `from`: { score, pos } or null.
function scoreWord(text, low, q, from) {
  const w = window(low, q, from);
  if (!w) return null;
  const pos = [];
  let score = 0, prev = -2;
  for (let i = w[0], j = 0; i <= w[1] && j < q.length; i++) {
    if (low[i] !== q[j]) continue;
    let s = 1;
    const before = i > 0 ? text[i - 1] : "/";
    if (BOUNDARY.test(before)) s += 8;
    else if (isUpper(text[i]) && !isUpper(before)) s += 6;
    if (prev === i - 1) s += 5;
    else if (prev >= 0) s -= Math.min(3, (i - prev - 1) * 0.2);
    score += s; pos.push(i); prev = i; j++;
  }
  return { score, pos };
}

// One path: { score, pos } or null. `name` starts at `nameAt` (after the last "/").
export function fuzzy(rel, words) {
  const low = rel.toLowerCase(), nameAt = rel.lastIndexOf("/") + 1;
  let total = 0;
  const pos = [];
  for (const q of words) {
    // In the name alone first: worth more.
    let best = scoreWord(rel, low, q, nameAt);
    if (best) best.score += 12 + (low.startsWith(q, nameAt) ? 10 : 0) + (low.length - nameAt === q.length ? 12 : 0);
    const full = scoreWord(rel, low, q, 0);
    if (!best || (full && full.score > best.score)) best = full;
    if (!best) return null;
    const sub = low.indexOf(q);
    if (sub >= 0) best.score += 6;
    total += best.score;
    pos.push(...best.pos);
  }
  total -= rel.length * 0.05 + (rel.split("/").length - 1) * 0.4;
  return { score: total, pos };
}

export const words = (query) => query.toLowerCase().split(/\s+/).filter(Boolean);

// The best `limit` of `all` for the query, best first: [{ rel, score, pos }].
export function search(all, lower, query, limit = 200) {
  const ws = words(query);
  if (!ws.length) return [];
  const first = ws.map((w) => w[0]);
  const hits = [];
  for (let i = 0; i < all.length; i++) {
    const low = lower[i];
    // Quick reject: every word's first character must be there.
    let ok = true;
    for (const c of first) if (low.indexOf(c) < 0) { ok = false; break; }
    if (!ok) continue;
    const m = fuzzy(all[i], ws);
    if (m) hits.push({ rel: all[i], score: m.score, pos: m.pos });
  }
  hits.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : 1));
  return hits.slice(0, limit);
}
