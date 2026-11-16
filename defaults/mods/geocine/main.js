// Geocine: the fork's own panels, as one mod so they share their git, icons, diff and preview
// code and look the same. Each block names a view in its props:
//   { "mod": "geocine", "props": { "view": "files" } }     the explorer (default)
//   { "view": "changes" }                                   uncommitted changes and their diffs
//   { "view": "graph" }                                     the commit graph and commit details
//   { "view": "tabs" }                                      the tab bar with the panel buttons
//   { "view": "full", "tab": "files"|"changes"|"graph" }    full mode as an overlay (layouts
//                                                           without the geocine panel)
// A view is a View class drawn inline (not a nested entity): the router hands it its own
// init/render/close, so Herdr's live updates (focus, spaces, theme) redraw it like any mod.
//
// A panel view (files, changes, graph) in full mode: the panel grown over the terminals
// (lib/nav.js). This router tells the view (props wide and full) and gives it the keyboard.
import { View, div } from "gpui-kit";
import { props, theme, nextCommand } from "herdr";
import { VIEWS } from "./views/index.js";
import { inline } from "./lib/inline.js";
import { grownView, closeFull } from "./lib/nav.js";

const PANEL_VIEWS = ["files", "changes", "graph"];

export default class Geocine extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.name = VIEWS[p.view] ? p.view : "files";
    this.base = p;
    this.panel = PANEL_VIEWS.includes(this.name) && !p.wide;
    this.grown = false;
    this.view = inline(VIEWS[this.name], p, cx);
    if (!this.panel) return;
    // Keys for the geocine mod reach every copy on screen; the tab bar does most of them.
    cx?.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "goto") this.view.goto?.(cx);
        else if (c === "focus") this.view.handle?.focus?.();
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    if (this.panel) {
      const grown = grownView(this.name);
      if (grown !== this.grown) {
        this.grown = grown;
        this.view.update?.({ ...this.base, wide: grown, full: grown }, cx);
        // The terminals went away under the keyboard: the grown view takes it.
        if (grown) cx.timer.after(0, () => this.view.handle?.focus?.());
      }
    }
    return div().size_full().min_w(0).min_h(0).flex().flex_col().bg(t.background)
      // Esc with nothing left to close (the list has the keyboard, not a field) leaves full mode.
      .when(this.grown, (el) => el.on_key_down((e, cx) => {
        if (e.key === "escape" && !e.modifiers?.control && this.view.handle?.is_focused?.()) { closeFull(); cx.stop_propagation(); }
      }))
      .child(this.view.render(cx));
  }

  close(cx) {
    return this.view?.close?.(cx);
  }
}
