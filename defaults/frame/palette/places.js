// Files and changes for the palette (the geocine fork): while you type, the focused terminal's
// files and uncommitted changes show under the commands, and picking one opens it in the Geocine
// panel's full mode (Files, or Changes for a change). Read once per palette, in the background:
// the commands are there at once, the places join when git answers.
import { exec, spaces, panes, focused, layout, home, window as win, run, setShared } from "herdr";

const MAX_FILES = 100000;   // a bigger tree is cut here (still searchable up to it)
const SHOWN_FILES = 7, SHOWN_CHANGES = 5;
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "color.ui=false"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}

// The layout has the Geocine panel with these views (else: no places).
export function panelViews() {
  const body = find(layout(), "panel-body");
  return new Set((body?.children ?? []).map((c) => c.id));
}

// The focused terminal's folder and machine, as the Geocine views find it.
function place() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd || space?.folder || null;
  return { cwd: cwd ? String(cwd).replace(/\\/g, "/").replace(/(.)\/+$/, "$1") : null, on };
}

let gitCmd = null;
async function git(args, cwd, on) {
  const tries = gitCmd ? [gitCmd] : ["git", ...(!on && win()?.platform === "windows" ? ["C:\\Program Files\\Git\\cmd\\git.exe", `${home()}\\AppData\\Local\\Programs\\Git\\cmd\\git.exe`] : [])];
  let error;
  for (const cmd of tries) {
    try { const r = await exec(cmd, [...READ, ...args], { cwd, on, timeout: 8000 }); gitCmd = cmd; return r; }
    catch (e) { error ??= e; }
  }
  throw error;
}

const SECTION = (x, y) => {
  if (x === "?" && y === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicts";
  return y !== " " ? "unstaged" : "staged";
};

// { root, top, on, files: [{ path, low, base }], changes: [{ path, low, base, status, section }] }
export async function loadPlaces() {
  const { cwd, on } = place();
  if (!cwd) return null;
  const [top, listed, status] = await Promise.all([
    git(["rev-parse", "--show-toplevel"], cwd, on),
    git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd, on),
    git(["status", "--porcelain=v1", "-z", "-uall"], cwd, on),
  ]);
  if (top.code !== 0) return null;
  const item = (path) => { const i = path.lastIndexOf("/"); return { path, low: path.toLowerCase(), base: path.slice(i + 1), dir: i > 0 ? path.slice(0, i) : "" }; };
  const seen = new Set(), files = [];
  for (const p of (listed.stdout ?? "").split("\0")) {
    if (!p || seen.has(p)) continue;
    seen.add(p); files.push(item(p));
    if (files.length >= MAX_FILES) break;
  }
  const changes = [], parts = (status.stdout ?? "").split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const x = e[0], y = e[1];
    if (x === "R" || x === "C") i++;   // the old name follows a rename
    changes.push({ ...item(e.slice(3)), status: x === "?" ? "?" : y !== " " ? y : x, section: SECTION(x, y) });
  }
  return { root: cwd, top: String(top.stdout).trim().replace(/\\/g, "/"), on, files, changes };
}

// The best few of list for q (lower case, no spaces), with the matched positions in the name.
// Within a narrowing query (q extends the last one), only the last matches are looked at.
export function bestOf(list, q, fuzzy, max, memo) {
  const pool = memo && memo.q && q.startsWith(memo.q) && memo.list === list ? memo.hits : list;
  const hits = [], top = [];
  for (const f of pool) {
    // A cheap test first: every letter of q, in order, somewhere in the path.
    let at = 0;
    for (const ch of q) { at = f.low.indexOf(ch, at); if (at < 0) break; at++; }
    if (at < 0) continue;
    hits.push(f);
    const name = fuzzy(q, f.base), whole = name ? null : fuzzy(q, f.path);
    const score = name ? name.score + 8 : whole.score;
    if (top.length < max || score > top[top.length - 1].score) {
      top.push({ f, score, hits: name?.hits ?? [] });
      top.sort((a, b) => b.score - a.score);
      if (top.length > max) top.pop();
    }
  }
  if (memo) { memo.q = q; memo.list = list; memo.hits = hits; }
  return top;
}

// Opens a place in full mode: a file in Files, a change in Changes (Geocine does the rest).
export function openPlace(kind, f, places) {
  setShared("geocine.open", { view: kind === "change" ? "changes" : "files", path: f.path, root: kind === "change" ? places.top : places.root, on: places.on, at: Date.now() });
  run("geocine.open");
}
