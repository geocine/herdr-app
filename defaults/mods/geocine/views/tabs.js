// The Geocine tab bar: Herdr's own tab pills (from the shipped `tabs` mod), then the side
// panel's buttons (Files, Changes, Graph, whichever the layout's "panel-body" stack has and
// Settings leaves on) and full mode. The open panel, and full mode, are remembered per space.
//
// Keys (keys.json, "geocine.<command>"): sidebar (Ctrl+Shift+B; Ctrl+B outside terminals), full (Ctrl+Shift+Enter: the panel
// grown over the terminals, or back), changes (Ctrl+Shift+D), graph (Ctrl+Shift+G), goto
// (Ctrl+Shift+R: the Files view's search), open (a file or change from the command
// palette, in full mode: shared "geocine.open"). A view's key opens it, in full
// mode when that is on; pressed again on the view shown, it closes the panel.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, nextCommand } from "herdr";
import { ui } from "../lib/ui.js";
import { find, expanded, expand, collapse, toggleFull } from "../lib/nav.js";

const PANELS = [
  { id: "files", label: "Files", icon: ui("files"), key: "Ctrl+Shift+R" },
  { id: "changes", label: "Changes", icon: ui("changes"), key: "Ctrl+Shift+D" },
  { id: "graph", label: "Graph", icon: ui("git-graph"), key: "Ctrl+Shift+G" },
];

// Folds the sidebar to its rail (icons only) or back to the width it had, as the sidebar's own
// fold button does (workspace-chrome); a hidden sidebar comes back. Ctrl+Shift+B (Ctrl+B outside terminals): "geocine.sidebar".
function foldSidebar() {
  const sidebar = find(layout(), "sidebar");
  if (!sidebar) return;
  if (sidebar.hidden) { run("layout.show", { id: "sidebar" }); return; }
  const width = sidebar.size?.px ?? Infinity, narrow = width < 160;
  if (!narrow) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow);
  run("layout.resize", { id: "sidebar", px: narrow ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    // Per space: the panel shown (or null) and whether it is grown (full mode). Older
    // records are the panel's name alone.
    this.panels = {};
    try {
      for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem("tabs.panels") ?? "{}"))) this.panels[k] = typeof v === "object" && v ? v : { panel: v ?? null, full: false };
    } catch {}
    // Key commands for the geocine mod ("geocine.<command>" in keys.json) land here.
    cx?.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "sidebar") foldSidebar();
        else if (c === "full") toggleFull();
        // A file or change picked in the command palette: full mode on its view; the view's copy
        // opens it (main.js reads "geocine.open").
        else if (c === "open") { const want = shared("geocine.open"); if (want?.view) expand(want.view); }
        else if (c === "changes" || c === "graph") this.showView(c);
        // goto: the Files copy on screen answers it. Not on screen, Files shows, and once its
        // copy is there (a frame later) goto goes again, for it (this copy lets that one by).
        else if (c === "goto") {
          if (this.resent) this.resent = false;
          else if (this.showView("files", { keep: true })) { await cx.sleep(80); this.resent = true; run("geocine.goto"); }
        }
        cx.notify();
      }
    });
  }

  // A view's key: shows it (grown when full mode is on); on the view shown, closes the panel,
  // unless keep. Returns whether it showed the view just now.
  showView(view, { keep = false } = {}) {
    const l = layout(), panel = find(l, "panel"), body = find(l, "panel-body");
    if (!body?.children?.some(c => c.id === view)) return false;
    const open = panel && !panel.hidden ? body.active : null;
    if (open === view) { if (!keep) collapse(false); return false; }
    run("layout.select", { stack: "panel-body", child: view });
    run("layout.show", { id: "panel" });
    return true;
  }

  // The side panel and full mode are remembered per space: switching shows that space's
  // choice (closed if it never had one), and opening, closing or growing it records it.
  syncPanel(space, root, panel, body, enabled) {
    if (!space || !panel) return;
    const now = { panel: panel.hidden ? null : body?.active ?? null, full: expanded(root) };
    const same = (a, b) => (a?.panel ?? null) === b.panel && Boolean(a?.full) === b.full;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, shown = enabled.includes(stored?.panel) ? stored.panel : null;
        const want = { panel: shown, full: Boolean(shown && stored?.full) };
        if (!same(want, now)) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want.full) expand(want.panel);
          else {
            collapse(Boolean(want.panel));
            if (want.panel) { run("layout.select", { stack: "panel-body", child: want.panel }); run("layout.show", { id: "panel" }); }
          }
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (!same(this.pending.want, now) && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (same(this.panels[space.id], now)) return;
    this.panels[space.id] = now;
    try { localStorage.setItem("tabs.panels", JSON.stringify(this.panels)); } catch {}
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    // One panes() read per render, grouped by tab (each tab pill wants its agent, else its first program).
    const first = new Map(), agent = new Map();
    for (const p of panes()) {
      if (!first.has(p.tab)) first.set(p.tab, p.program);
      if (p.program?.agent && !agent.has(p.tab)) agent.set(p.tab, p.program);
    }
    const root = layout(), grown = expanded(root);
    const item = (c, i) => {
      const program = agent.get(c.id) ?? first.get(c.id);
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // In full mode no terminal is on screen: the active pill doesn't look shown.
        .border(1).border_color(c.active && !grown ? t.border : t.chrome).bg(c.active && !grown ? t.raised : t.chrome).text_color(c.active && !grown ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          // In full mode a tab's pill brings the terminals back, showing it.
          else { if (grown) collapse(); run("tab.select", { id: c.id }); }
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // The panels this layout has, minus the ones turned off in Settings → Look.
    const offered = new Set((body?.children ?? []).map(c => c.id));
    // A panel Settings never offered (Graph, for a list picked before it existed) shows.
    const picked = shared("workspace.panels"), known = shared("workspace.panels.known") ?? ["files", "changes"];
    const enabled = PANELS.map(p => p.id).filter(id => offered.has(id) && (!Array.isArray(picked) || picked.includes(id) || !known.includes(id)));
    this.syncPanel(space, root, panel, body, enabled);
    const open = panel && !panel.hidden ? body?.active : null;
    const panelButton = (p) => {
      const on = open === p.id;
      return h_flex().id(`panel-${p.id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) collapse(false);
          else { run("layout.select", { stack: "panel-body", child: p.id }); run("layout.show", { id: "panel" }); }
        }).tooltip(`${p.label}  ${p.key}`).child(svg(p.icon).size(14)).child(p.label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.length > 0, el => el.child(div().w(1).h(16).mx(4).bg(t.border)))
      .children(PANELS.filter(p => enabled.includes(p.id)).map(panelButton))
      .when(enabled.length > 0, el => el.child(button("full-mode", svg(ui(grown ? "collapse" : "expand")).size(13), () => toggleFull(open ?? enabled[0]))
        .when(grown, b => b.bg(t.selected).text_color(t.foreground))
        .tooltip(grown ? "Back to the terminals  Ctrl+Shift+Enter" : "Full view  Ctrl+Shift+Enter")))
      .when(w?.buttons, el => el.child(div().w(1).h(16).mx(4).bg(t.border))
        .child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
