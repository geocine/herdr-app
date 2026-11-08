// Running the graph's git actions, and the overlays that ask first. Every action checks that HEAD
// and the branch are still what the menu showed, then runs its commands in order and stops at the
// first failure. After any action every graph copy reloads (shared "graph.changed").
// Ported from rabeeh-ta/herdr-git-graph `act.js` and `execute.js` (MIT, (c) 2026 Rabeeh T A).
import { notify, setShared, openOverlay, closeOverlay, run } from "herdr";
import { gitRead, gitWrite } from "../../lib/git.js";
import { commandsFor, dialogFor, dialogHeight, doneText, gitError, menuFor, menuHeight, MENU, NETWORK } from "./ops.js";

export const CHANGED = "geocine.graph.changed";

// No login prompt can be answered from here (no terminal): fail fast rather than wait for one.
const QUIET = ["-c", "credential.interactive=never", "-c", "core.askPass="];

export async function executeAction(action, values, ctx) {
  const commands = commandsFor(action, values, ctx);
  // A dialog/menu describes this snapshot, not whatever HEAD happens to be when it's confirmed.
  if (action.type !== "fetch") {
    const [head, branch] = await Promise.all([
      gitRead(["rev-parse", "--verify", "-q", "HEAD"], ctx.root, { on: ctx.on }), gitRead(["symbolic-ref", "-q", "--short", "HEAD"], ctx.root, { on: ctx.on })]);
    // Exit 1 means an unborn or a detached HEAD. Other failures must not authorize a change.
    if (![0, 1].includes(head.code) || ![0, 1].includes(branch.code)) return { ok: false, message: "Can't verify the repository's state. Close this and refresh the graph." };
    const actualHead = head.code === 0 ? head.stdout.trim() : null, actualBranch = branch.code === 0 ? branch.stdout.trim() : null;
    if (actualHead !== (ctx.head ?? null) || actualBranch !== (ctx.current ?? null)) {
      return { ok: false, stale: true, message: "The branch or HEAD changed meanwhile. Close this, refresh the graph and look again." };
    }
  }
  // Staging everything would mark unresolved conflicts resolved and commit their markers.
  if (action.type === "commit" && values.all) {
    const unmerged = await gitRead(["ls-files", "--unmerged"], ctx.root, { on: ctx.on });
    if (unmerged.code !== 0 || unmerged.stdout.trim()) return { ok: false, message: "There are unresolved merge conflicts. Resolve them first, or untick \"Stage every change\"." };
  }
  const network = NETWORK.has(action.type);
  for (const args of commands) {
    const r = await gitWrite(network ? [...QUIET, ...args] : args, ctx.root, { on: ctx.on, timeout: network ? 180000 : 60000 });
    if (r.code !== 0) return { ok: false, message: gitError(r) };
  }
  return { ok: true };
}

export async function perform(action, values, ctx, { toast = true } = {}) {
  try {
    const result = await executeAction(action, values, ctx);
    if (!result.ok) {
      if (toast) notify({ title: "Couldn't do that", body: result.message, level: "error" });
      return result;
    }
    notify({ title: doneText(action, values), level: "success", timeout: 3000 });
    return { ok: true };
  } catch (e) {
    const message = String(e?.message ?? e);
    if (toast) notify({ title: "Git didn't run", body: message, level: "error" });
    return { ok: false, message };
  } finally {
    setShared(CHANGED, Date.now());
  }
}

// Overlays are this same view with a role: the router mounts views/graph for them too.
export function openMenu(target, ctx, extra = {}) {
  const items = menuFor(target, ctx);
  if (!items.length) return;
  openOverlay({ mod: "geocine", kind: "popup", at: "pointer", width: MENU.W, height: menuHeight(items), props: { view: "graph", role: "menu", target, ctx, ...extra } });
}

// Opens the action's dialog; false when it has none and should run at once.
export function openDialog(action, ctx) {
  const spec = dialogFor(action, ctx);
  if (!spec) return false;
  openOverlay({ mod: "geocine", kind: "dialog", width: 440, height: dialogHeight(spec), props: { view: "graph", role: "dialog", action, ctx } });
  return true;
}

export function openSettings() {
  openOverlay({ mod: "geocine", kind: "popup", at: "pointer", width: 240, height: 84, props: { view: "graph", role: "settings" } });
}

// Herdr's Changes view: the geocine panel's Changes tab. fullOverlay: full mode's overlay, closed first.
export function showChanges(fullOverlay) {
  if (fullOverlay) closeOverlay(fullOverlay);
  run("layout.select", { stack: "panel-body", child: "changes" });
  run("layout.show", { id: "panel" });
}
