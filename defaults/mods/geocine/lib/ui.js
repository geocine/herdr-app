// The Geocine look, shared by every view (Files, Changes, Graph, Preview, full mode, the tab bar):
// one set of sizes, one header, one kind of button, one kind of row. Views use these instead of
// their own so the panels read as one tool. Colors come from theme() only, never hex.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

// Sizes (px at zoom 1). Change them here, not in a view.
export const SIZE = {
  header: 34,      // a view's top bar
  subheader: 28,   // a second bar (search field, section switch, back bar)
  row: 24,         // a list row (tree, file list, commit row)
  icon: 14,        // icons in rows and buttons
  button: 24,      // square icon buttons
  radius: 6,       // buttons, pills, inputs
  card: 8,         // cards and popovers
  pad: 8,          // horizontal padding of bars and rows
  indent: 12,      // a tree level
  text: 12.5,      // body text
  small: 11.5,     // secondary text (paths, dates, counts)
  mono: 12,        // code and diffs
};

// The fonts code uses: the person's terminal font, as Herdr's own panels do.
export const monoFont = (settings) => settings?.font_family ?? "JetBrains Mono";

export const ui = (name) => `mods/geocine/icons/ui/${name}.svg`;

const stop = (_e, cx) => cx.stop_propagation();

// A square icon button. on: lit (a toggle that is on); disabled: dimmed, no click.
export function iconButton(t, id, icon, onClick, { on = false, disabled = false, size = SIZE.button } = {}) {
  return div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(SIZE.radius)
    .text_color(disabled ? t.dim : on ? t.foreground : t.muted).when(on, el => el.bg(t.selected))
    .when(!disabled, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); }))
    .child(svg(icon.includes("/") ? icon : ui(icon)).size(SIZE.icon));
}

// A text button, optionally with an icon. primary: the accent fill.
export function textButton(t, id, label, onClick, { icon, primary = false, on = false, disabled = false } = {}) {
  return h_flex().id(id).h(SIZE.button).px(8).gap(5).flex_none().items_center().rounded(SIZE.radius).text_size(SIZE.small)
    .bg(primary ? t.solid ?? t.accent : on ? t.selected : t.surface).text_color(primary ? t.solid_foreground ?? t.accent_foreground : disabled ? t.dim : t.foreground)
    .border_1().border_color(primary ? t.solid ?? t.accent : t.border)
    .when(!disabled, el => el.cursor_pointer().hover(s => s.bg(primary ? t.solid ?? t.accent : t.hover)).on_mouse_down("left", stop).on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); }))
    .when(Boolean(icon), el => el.child(svg(icon.includes("/") ? icon : ui(icon)).size(SIZE.icon)))
    .child(label);
}

// A segmented switch: options [{ id, label }], the chosen id lit.
export function segmented(t, id, options, chosen, onPick) {
  return h_flex().id(id).h(SIZE.button).p(2).gap(2).flex_none().items_center().rounded(SIZE.radius).bg(t.chrome).border_1().border_color(t.border)
    .children(options.map(o => div().id(`${id}-${o.id}`).h_full().px(8).flex().items_center().rounded(SIZE.radius - 2).text_size(SIZE.small).cursor_pointer()
      .when(o.id === chosen, el => el.bg(t.raised)).text_color(o.id === chosen ? t.foreground : t.muted)
      .hover(s => s.text_color(t.foreground)).on_mouse_down("left", stop).on_click((e, cx) => { cx.stop_propagation(); onPick(o.id, cx); })
      .child(o.label)));
}

// A view's top bar: [back] icon title · subtitle ............ actions
// back: a click handler (shows "←" and the label backLabel), or null.
export function header(t, { id = "header", icon, title, subtitle, back, backLabel, actions = [] }) {
  return h_flex().id(id).h(SIZE.header).flex_none().px(SIZE.pad).gap(6).items_center().bg(t.chrome).border_b(1).border_color(t.border)
    .when(Boolean(back), el => el.child(h_flex().id(`${id}-back`).h(SIZE.button).pl(4).pr(8).gap(4).flex_none().items_center().rounded(SIZE.radius).cursor_pointer()
      .text_size(SIZE.small).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click((e, cx) => { cx.stop_propagation(); back(e, cx); })
      .child(svg(ui("chevron-left")).size(SIZE.icon)).child(backLabel ?? "Back")))
    .when(Boolean(icon), el => el.child((icon.endsWith(".png") || icon.includes("/icons/files/")) ? image(icon).size(SIZE.icon).flex_none() : svg(icon.includes("/") ? icon : ui(icon)).size(SIZE.icon).flex_none().text_color(t.muted)))
    .child(div().min_w(0).text_size(SIZE.text).font_semibold().text_color(t.foreground).truncate().child(title ?? ""))
    .when(Boolean(subtitle), el => el.child(div().min_w(0).flex_shrink(1).text_size(SIZE.small).text_color(t.dim).truncate().child(subtitle)))
    .child(div().flex_1())
    .children(actions);
}

// A plain bar below the header (search field, filters, section switch).
export const subbar = (t, id) => h_flex().id(id).h(SIZE.subheader).flex_none().px(SIZE.pad).gap(6).items_center().border_b(1).border_color(t.border);

// A list row: selected rows get `selected`, hover gets `hover`. depth indents tree rows.
export function row(t, id, { selected = false, depth = 0, onClick, onRight, onDouble } = {}) {
  return h_flex().id(id).h(SIZE.row).flex_none().w_full().pl(SIZE.pad + depth * SIZE.indent).pr(SIZE.pad).gap(6).items_center().text_size(SIZE.text)
    .when(selected, el => el.bg(t.selected)).text_color(t.foreground).cursor_pointer().hover(s => s.bg(selected ? t.selected : t.hover))
    .when(Boolean(onClick) || Boolean(onDouble), el => el.on_mouse_down("left", (e, cx) => { cx.stop_propagation(); if (e.click_count === 2 && onDouble) onDouble(e, cx); else onClick?.(e, cx); }))
    .when(Boolean(onRight), el => el.on_mouse_down("right", (e, cx) => { cx.stop_propagation(); onRight(e, cx); }));
}

// A section label in a list ("Staged · 3"), optionally folding.
export function section(t, id, label, { count, open = true, onToggle, actions = [] } = {}) {
  return h_flex().id(id).h(SIZE.row).flex_none().w_full().px(SIZE.pad).gap(4).items_center().text_size(SIZE.small).font_semibold().text_color(t.muted)
    .when(Boolean(onToggle), el => el.cursor_pointer().hover(s => s.text_color(t.foreground)).on_mouse_down("left", (e, cx) => { cx.stop_propagation(); onToggle(e, cx); })
      .child(svg(ui(open ? "chevron-down" : "chevron-right")).size(12)))
    .child(label.toUpperCase())
    .when(count !== undefined, el => el.child(div().px(5).rounded(8).bg(t.surface).text_color(t.dim).child(String(count))))
    .child(div().flex_1()).children(actions);
}

// A git status letter, colored as everywhere else.
export const badge = (t, letter, color) => div().w(14).flex_none().text_size(SIZE.small).font_semibold().text_color(color ?? t.muted).child(letter);

// +12 −3, the line counts of a change.
export const counts = (t, add, del) => h_flex().gap(4).flex_none().text_size(SIZE.small)
  .when(add > 0, el => el.child(div().text_color(t.ansi2).child(`+${add}`)))
  .when(del > 0, el => el.child(div().text_color(t.ansi1).child(`−${del}`)));

// The middle of an empty or failed view: one line, an optional second, an optional button.
export function empty(t, title, detail, action) {
  return v_flex().size_full().p(24).gap(8).items_center().justify_center().text_center()
    .child(div().text_size(SIZE.text).text_color(t.muted).child(title))
    .when(Boolean(detail), el => el.child(div().text_size(SIZE.small).text_color(t.dim).child(detail)))
    .when(Boolean(action), el => el.child(action));
}

// A view's frame: header on top, body filling the rest. Every view returns frame(...).
export const frame = (t, top, body) => v_flex().size_full().min_w(0).min_h(0).bg(t.background).text_color(t.foreground).child(top).child(div().flex_1().min_h(0).min_w(0).flex().flex_col().child(body));

// Short relative time: "now", "5m", "3h", "2d", "4w", then the date.
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 7 * 8) return `${Math.floor(s / 86400 / 7)}w`;
  return new Date(ms).toISOString().slice(0, 10);
}
