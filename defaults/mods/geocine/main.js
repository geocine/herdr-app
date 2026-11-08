// Geocine: the fork's own panels, as one mod so they share their git, icons, diff and preview
// code and look the same. Each block names a view in its props:
//   { "mod": "geocine", "props": { "view": "files" } }     the explorer (default)
//   { "view": "changes" }                                   uncommitted changes and their diffs
//   { "view": "graph" }                                     the commit graph and commit details
//   { "view": "tabs" }                                      the tab bar with the panel buttons
//   { "view": "full", "tab": "files"|"changes"|"graph" }    full mode: an overlay over the window
// A view is a View class drawn inline (not a nested entity): the router hands it its own
// init/render/close, so Herdr's live updates (focus, spaces, theme) redraw it like any mod.
import { View, div } from "gpui-kit";
import { props, theme } from "herdr";
import { VIEWS } from "./views/index.js";
import { inline } from "./lib/inline.js";

export default class Geocine extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.name = VIEWS[p.view] ? p.view : "files";
    this.view = inline(VIEWS[this.name], p, cx);
  }

  render(cx) {
    return div().size_full().min_w(0).min_h(0).flex().flex_col().bg(theme().background).child(this.view.render(cx));
  }

  close(cx) {
    return this.view?.close?.(cx);
  }
}
