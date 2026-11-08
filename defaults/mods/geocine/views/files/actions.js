// What the context menu and the keys do with a path: open it in its app, show it in Explorer
// (Finder, the file manager), copy it, type it into the focused agent or terminal, or open a
// terminal there.
//
// Adapted from carstenlucke/herdr-roundup `roundup-files/actions.js` (Apache-2.0), which follows
// cybertron288/herdr-mods `filetree` (MIT). See NOTICE.md.
import { agents, exec, focused, notify, panes, run, window } from "herdr";
import { psQuote } from "./disk.js";

export const platform = () => window()?.platform ?? "linux";
export const revealLabel = () => (platform() === "macos" ? "Reveal in Finder" : platform() === "windows" ? "Reveal in Explorer" : "Show in folder");

// The path as the system writes it: backslashes on Windows (this computer).
export const native = (abs, on) => (!on && platform() === "windows" ? abs.replace(/\//g, "\\") : abs);

export function relTo(root, abs) {
  if (!root || !abs) return null;
  const a = abs.replace(/\\/g, "/"), r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (a.toLowerCase() === r.toLowerCase()) return "";
  return a.toLowerCase().startsWith(r.toLowerCase() + "/") ? a.slice(r.length + 1) : null;
}

// This computer only.
export async function openExternal(abs) {
  const p = platform();
  const r = p === "macos" ? await exec("open", ["--", abs])
    : p === "windows" ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Invoke-Item -LiteralPath ${psQuote(native(abs))}`])
    : await exec("xdg-open", [abs]);
  if (r.code !== 0) throw new Error((r.stderr || "").trim().split(/\r?\n/)[0] || "No app opens this file");
}

// This computer only.
export async function revealExternal(abs, dir = false) {
  const p = platform();
  if (p === "windows") {
    const path = native(abs);
    const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `if (-not (Test-Path -LiteralPath ${psQuote(path)})) { exit 1 }`]);
    if (r.code !== 0) throw new Error("It is gone from the disk");
    // "/select," and the path as two arguments: as one, exec's quotes around a path with a
    // space would enclose the switch too. Explorer exits 1 even when it worked.
    await exec("explorer.exe", dir ? [path] : ["/select,", path]);
    return;
  }
  const r = p === "macos" ? await exec("open", dir ? ["--", abs] : ["-R", "--", abs]) : await exec("xdg-open", [dir ? abs : abs.replace(/\/[^/]*$/, "") || "/"]);
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || "Cannot show this file");
}

export function copy(cx, text) {
  cx.write_to_clipboard(text);
  notify({ title: "Copied", body: text, level: "info", timeout: 2000 });
}

// Where "send" types: the focused pane's agent, else the tab's focused or first agent, else the
// focused terminal. { address, agent, cwd } or null.
export function sendTarget() {
  const f = focused(), fp = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const inTab = agents().filter((a) => a.tab === f?.tab);
  const agent = (fp?.status && fp.terminal) || (inTab.find((a) => a.focused) ?? inTab[0])?.address;
  const address = agent || fp?.terminal || f?.terminal || null;
  if (!address) return null;
  return { address, agent: Boolean(agent), cwd: panes().find((p) => p.terminal === address)?.cwd ?? null };
}

// Types the path into the target: "@path " for an agent, the quoted path for a shell. Through
// the clipboard (terminal.paste is how text gets typed without Enter), which is put back a moment
// later when it still holds the path. The path is relative to the target's folder when inside it.
export function sendPath(cx, abs, on) {
  const target = sendTarget();
  if (!target) { notify({ title: "No terminal to send to", body: "Focus an agent or a terminal, then send the path again", level: "warning", timeout: 3000 }); return; }
  const rel = relTo(target.cwd, abs);
  const path = rel || native(abs, on);
  const quoted = /[\s'"&()]/.test(path) ? `"${path}"` : path;
  const text = target.agent ? `@${quoted} ` : `${quoted} `;
  const before = cx.read_from_clipboard();
  cx.write_to_clipboard(text);
  run("pane.focus", { terminal: target.address });
  run("terminal.paste");
  cx.timer.after(600, (cx) => { if (cx.read_from_clipboard() === text) cx.write_to_clipboard(before ?? ""); });
}

// A new terminal tab in a folder (on the space's machine).
export function terminalHere(folder) {
  run("terminal.open", { folder, place: "tab" });
}
