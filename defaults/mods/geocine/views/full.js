// Full mode: one Geocine view almost as big as the window, its list and its detail side by
// side. A switch on top moves between Files, Changes and Graph without closing.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, theme } from "herdr";
import { SIZE, segmented, iconButton } from "../lib/ui.js";
import { FULL_TABS, closeFull, openFull } from "../lib/nav.js";
import { inline } from "../lib/inline.js";
// A cycle (index.js imports this file), fine: VIEWS is only read once a view mounts.
import { VIEWS } from "./index.js";

export default class Full extends View {
  init(_p, cx) {
    const p = props() ?? {};
    this.tab = FULL_TABS.some(x => x.id === p.tab) ? p.tab : "files";
    this.view = inline(VIEWS[this.tab], { wide: true, full: true, start: p.start ?? null }, cx);
  }

  close(cx) {
    return this.view?.close?.(cx);
  }

  // Another view: full mode opens again on it (a view starts in init, with its own tasks).
  switchTo(id) {
    if (id === this.tab) return;
    closeFull();
    openFull(id);
  }

  render(cx) {
    const t = theme();
    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(h_flex().h(40).flex_none().px(12).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(svg("mods/geocine/icons/ui/expand.svg").size(SIZE.icon).text_color(t.accent))
        .child(div().text_size(13).font_semibold().child("Geocine"))
        .child(segmented(t, "full-tabs", FULL_TABS, this.tab, (id) => this.switchTo(id)))
        .child(div().flex_1())
        .child(div().text_size(SIZE.small).text_color(t.dim).child("Esc closes"))
        .child(iconButton(t, "full-close", "close", () => closeFull())))
      .child(div().flex_1().min_h(0).min_w(0).flex().flex_col().child(this.view.render(cx)));
  }
}
