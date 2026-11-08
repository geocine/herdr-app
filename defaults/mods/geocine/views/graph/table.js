// Drawing the graph's table: the lane cell, ref labels and one commit row. Pure: no handlers, so it
// runs inside a virtual list's item renderer (the list takes the clicks).
// Ported from rabeeh-ta/herdr-git-graph `graph.js` (MIT, (c) 2026 Rabeeh T A). See NOTICE.md.
import { div, svg, PathBuilder } from "gpui-kit";
import { h_flex } from "gpui-base";
import { SIZE, ui } from "../../lib/ui.js";
import { LABEL, shortDate } from "./ops.js";

export const LANE = 12, PAD = 6, ROW = SIZE.row;

// Lane colors: the theme's ANSI slots, green (the Geocine accent's slot) first for the first lane.
export const laneColors = (t) => [t.ansi2, t.ansi4, t.ansi5, t.ansi3, t.ansi6, t.ansi1, t.ansi10, t.ansi12, t.ansi13, t.ansi11, t.ansi14, t.ansi9];

// A theme color with an alpha, for tints (only on plain #rrggbb tokens; else the fallback).
export const tint = (c, aa, fallback) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c + aa : fallback ?? c);

/** The lanes of one row: one stroked path per color, then the commit's dot (HEAD a ring). */
export function graphCell(row, commit, t, width, h) {
  const colors = laneColors(t), x = (lane) => PAD + lane * LANE + LANE / 2, y = (v) => v * h, paths = new Map();
  for (const [a, ya, b, yb, c, dashed] of row.segments) {
    const color = dashed ? t.dim : colors[c % colors.length], key = `${color}${dashed ? "-" : ""}`;
    let p = paths.get(key)?.p ?? (dashed ? PathBuilder.stroke(1.5).dash_array([3, 3]) : PathBuilder.stroke(1.5));
    p = p.move_to(x(a), y(ya));
    if (a === b) p = p.line_to(x(b), y(yb));
    else { const mid = (y(ya) + y(yb)) / 2; p = p.cubic_bezier_to(x(b), y(yb), x(a), mid, x(b), mid); }
    paths.set(key, { p, color });
  }
  const color = commit.uncommitted ? t.dim : colors[row.lane % colors.length];
  const ring = commit.head || commit.uncommitted, size = ring ? 10 : 8;
  const dot = div().absolute().left(x(row.lane) - size / 2).top(h / 2 - size / 2).size(size).rounded(size / 2);
  return div().relative().flex_none().w(width).h(h).overflow_hidden()
    .children([...paths.values()].map(({ p, color }) => window.paint_path(p.build(), color).absolute().top(0).left(0).size_full()))
    .child(ring ? dot.bg(t.background).border(2).border_color(color) : dot.bg(color).border(1).border_color(t.background));
}

/** A ref label: a local branch (and its remote riding on it), a remote branch, a tag or a detached HEAD. */
export function label(l, color, t, mono, { fixed = true } = {}) {
  const current = l.kind === "branch" && l.head;
  const edge = l.kind === "tag" ? t.ansi3 : l.kind === "head" ? t.accent : l.kind === "remote" ? t.muted : color;
  return h_flex().flex_none().when(fixed, (e) => e.w(l.width)).h(LABEL.H).rounded(5).border_1().border_color(edge).overflow_hidden()
    .bg(current ? color : l.kind === "head" ? t.accent : tint(edge, "14", t.surface))
    .children(l.parts.map((part, i) => {
      const fg = current || part.kind === "head" ? t.background : part.kind === "tag" ? t.ansi3 : i > 0 || part.kind === "remote" ? t.muted : t.foreground;
      const glyph = part.kind === "branch" ? (part.head ? "check" : "git-branch") : part.kind === "tag" ? "tag" : "cloud";
      return h_flex().when(fixed, (e) => e.w(part.width)).h_full().flex_none().px(LABEL.PAD).gap(3).items_center().overflow_hidden()
        .when(i > 0, (e) => e.border_l(1).border_color(edge).bg(current ? tint(t.background, "40", t.surface) : tint(edge, "1f", t.surface)))
        .when(Boolean(part.icon), (e) => e.child(svg(ui(glyph)).size(10).flex_none().text_color(fg)))
        .child(div().font_family(mono).text_size(LABEL.FONT).when(current, (e) => e.font_semibold()).text_color(fg).child(part.text));
    }));
}

/**
 * One commit row. o: { width (graph column), h, mono, labels, selected, match, wide (author and
 * hash columns), cols: { date, author, hash } }.
 */
export function commitRow(commit, row, t, o) {
  const color = laneColors(t)[row.lane % 12];
  // Merge commits are muted, as Git Graph does; HEAD's subject is semibold.
  const fg = commit.uncommitted ? t.muted : o.match ? t.accent : commit.parents.length > 1 ? t.dim : t.foreground;
  return h_flex().id(`c-${commit.hash}`).w_full().h(o.h).flex_none().pr(SIZE.pad).gap(LABEL.GAP).items_center().overflow_hidden().text_size(SIZE.text)
    .when(Boolean(commit.head), (e) => e.bg(tint(color, "12", t.surface)))
    .when(o.selected, (e) => e.bg(t.selected)).hover((s) => s.bg(o.selected ? t.selected : t.hover))
    .child(graphCell(row, commit, t, o.width, o.h))
    // Labels and the subject clip together, so many labels never push the fixed columns out.
    .child(h_flex().flex_1().min_w(0).h_full().gap(LABEL.GAP).items_center().overflow_hidden()
      .children((o.labels ?? []).map((l) => label(l, color, t, o.mono)))
      .child(div().flex_1().min_w(0).truncate().text_color(fg).when(Boolean(commit.head) || Boolean(o.match), (e) => e.font_semibold()).child(commit.subject)))
    .when(o.wide, (e) => e
      .child(div().w(o.cols.author).flex_none().truncate().text_size(SIZE.small).text_color(t.muted).child(commit.uncommitted ? "" : commit.author))
      .child(div().w(o.cols.hash).flex_none().font_family(o.mono).text_size(11).text_color(t.dim).child(commit.uncommitted ? "" : commit.hash.slice(0, 8))))
    .child(div().w(o.cols.date).flex_none().text_right().truncate().text_size(SIZE.small).text_color(t.dim).child(commit.uncommitted ? "" : shortDate(commit.time)));
}
