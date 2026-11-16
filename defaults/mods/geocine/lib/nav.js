// Full mode: a Geocine view as big as the work area, list and detail side by side.
//
// In the geocine layout it is the side panel itself, grown over the terminals (they keep
// running, hidden): the same copy, so nothing reloads, the selection and the open file stay,
// and going back is instant. Each space remembers it (views/tabs.js). Other layouts, which
// have no panel beside the terminals, get the old overlay.
import { openOverlay, closeOverlay, props, layout, run, shared, setShared } from "herdr";

export const FULL_TABS = [
  { id: "files", label: "Files" },
  { id: "changes", label: "Changes" },
  { id: "graph", label: "Graph" },
];

export function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const PANEL_W = 440;          // the panel's width when the layout never said
const WIDTH_KEY = "geocine.panel.px";

// The layout can grow its panel: it has the terminals ("main") and the panel stack beside them.
function growable(l = layout()) {
  return Boolean(find(l, "main") && find(l, "panel") && find(l, "panel-body"));
}

// Whether the panel is grown over the terminals now.
export function expanded(l = layout()) {
  const main = find(l, "main"), panel = find(l, "panel");
  return Boolean(main?.hidden && panel && !panel.hidden && find(l, "panel-body"));
}

// Grows the panel over the terminals, showing view (or the one it shows).
export function expand(view = null) {
  const l = layout(), panel = find(l, "panel");
  if (!expanded(l) && panel?.size?.px) setShared(WIDTH_KEY, panel.size.px);
  if (view) run("layout.select", { stack: "panel-body", child: view });
  run("layout.show", { id: "panel" });
  run("layout.hide", { id: "main" });
  run("layout.resize", { id: "panel", weight: 1 });
}

// Back to the terminals: the panel to its width before, open (keep) or closed.
export function collapse(keep = true) {
  if (!expanded()) { if (!keep) run("layout.hide", { id: "panel" }); return; }
  run("layout.show", { id: "main" });
  run("layout.resize", { id: "panel", px: shared(WIDTH_KEY) ?? PANEL_W });
  if (!keep) run("layout.hide", { id: "panel" });
}

// Opens full mode on a view ("files", "changes", "graph"). state: what to show first, for the
// overlay copy (props.start: { path } or { rev }); the grown panel already shows it.
export function openFull(tab = "files", state = null) {
  if (growable()) return expand(tab);
  return openOverlay({ mod: "geocine", kind: "dialog", width: 0.96, height: 0.94, props: { view: "full", tab, start: state } });
}

// Leaves full mode: the overlay closes, the grown panel goes back to its side.
export function closeFull() {
  const id = props()?.view === "full" ? props()?.overlay : null;
  if (id) closeOverlay(id);
  else collapse();
}

// Full mode on or off, from the tab bar and Ctrl+Shift+Enter.
export function toggleFull(view = null) {
  if (expanded()) collapse();
  else openFull(view ?? find(layout(), "panel-body")?.active ?? "files");
}

// This copy is the full mode overlay. (A grown panel's view gets props.full from main.js,
// worked out once a frame: views read `full` often, and layout() is a whole tree.)
export const inFull = () => props()?.view === "full";

// A panel view's place now, for main.js: grown over the terminals and shown, or not.
export function grownView(view, l = layout()) {
  return expanded(l) && find(l, "panel-body")?.active === view;
}
