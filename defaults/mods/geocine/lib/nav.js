// Full mode: a Geocine view almost as big as the window, list and detail side by side.
import { openOverlay, closeOverlay, props } from "herdr";

export const FULL_TABS = [
  { id: "files", label: "Files" },
  { id: "changes", label: "Changes" },
  { id: "graph", label: "Graph" },
];

// Opens full mode on a view ("files", "changes", "graph"). state: what to show first, passed
// to the view as props.start (e.g. { path } or { rev }).
export function openFull(tab = "files", state = null) {
  return openOverlay({ mod: "geocine", kind: "dialog", width: 0.96, height: 0.94, props: { view: "full", tab, start: state } });
}

// Closes full mode, when this copy is the full mode overlay.
export function closeFull() {
  const id = props()?.overlay;
  if (id) closeOverlay(id);
}

export const inFull = () => props()?.view === "full";
