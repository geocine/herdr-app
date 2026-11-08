// Where the Geocine views look: the focused terminal's folder (as Herdr's own Files panel does),
// on the machine that runs it (`on`: null for this computer).
import { spaces, panes, focused } from "herdr";

export function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on, space: space?.id ?? null };
}

// A stable key for "the same place", to notice when the focus moved somewhere else.
export const locationKey = (l = location()) => JSON.stringify([l.cwd, l.on]);

// Paths are shown and joined with "/" everywhere; Windows accepts them.
export const slash = (p) => String(p ?? "").replace(/\\/g, "/");
export const join = (...parts) => parts.filter(Boolean).map(slash).join("/").replace(/\/+/g, "/");
export const baseName = (p) => slash(p).replace(/\/+$/, "").split("/").pop() ?? "";
export function dirName(p) {
  const s = slash(p).replace(/\/+$/, ""), i = s.lastIndexOf("/");
  return i <= 0 ? s.slice(0, i + 1) : s.slice(0, i);
}
