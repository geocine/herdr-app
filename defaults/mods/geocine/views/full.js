// Full mode: one Geocine view almost as big as the window, its list and its detail side by
// side. A switch on top moves between Files, Changes and Graph without closing.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, theme } from "herdr";
import { SIZE, segmented, iconButton } from "../lib/ui.js";
import { FULL_TABS, closeFull } from "../lib/nav.js";
import { inline } from "../lib/inline.js";
// A cycle (index.js imports this file), fine: VIEWS is only read once a view mounts.
import { VIEWS } from "./index.js";

export default class Full extends View {
  init(_p, cx) {
    const p = props() ?? {};
    this.tab = FULL_TABS.some(x => x.id === p.tab) ? p.tab : "files";
    // The views visited, kept for the overlay's life: switching back is instant (no reload),
    // and a view starts once, in this copy, with its own tasks.
    this.views = new Map([[this.tab, inline(VIEWS[this.tab], { wide: true, full: true, start: p.start ?? null }, cx)]]);
  }

  get view() { return this.views.get(this.tab); }

  async close(cx) {
    await Promise.all([...this.views.values()].map(v => Promise.resolve(v?.close?.(cx)).catch(() => {})));
  }

  // Another view, in this same overlay. The first visit starts it; it stays for later visits.
  switchTo(id, cx) {
    if (id === this.tab || !VIEWS[id]) return;
    if (!this.views.has(id)) this.views.set(id, inline(VIEWS[id], { wide: true, full: true, start: null }, cx));
    this.tab = id;
    this.view?.handle?.focus?.();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(h_flex().h(40).flex_none().px(12).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(svg("mods/geocine/icons/ui/expand.svg").size(SIZE.icon).text_color(t.accent))
        .child(div().text_size(13).font_semibold().child("Geocine"))
        .child(segmented(t, "full-tabs", FULL_TABS, this.tab, (id, cx) => this.switchTo(id, cx)))
        .child(div().flex_1())
        .child(div().text_size(SIZE.small).text_color(t.dim).child("Esc closes"))
        .child(iconButton(t, "full-close", "close", () => closeFull())))
      .child(div().flex_1().min_h(0).min_w(0).flex().flex_col().child(this.view.render(cx)));
  }
}
