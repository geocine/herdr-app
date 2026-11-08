// The Graph view: the commit graph of the focused terminal's repository (or, in a folder that holds
// repositories, the list of them), and a commit's details: its header, message, files, the diff
// (lib/diff) and a file as of that commit (lib/preview). Side panel: one page at a time. Full mode
// (props.wide): the graph on the left, resizable, the details on the right.
// The graph, its labels, menus and actions are ported from rabeeh-ta/herdr-git-graph (MIT,
// (c) 2026 Rabeeh T A); the history switches, paging and ref checksum from file-preview (MIT).
// Overlays (menu, dialog, settings) are this same view with props.role. See NOTICE.md.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { props, theme, settings, shared, setShared, watchFolder, home, notify, layout, panes, focused } from "herdr";
import { SIZE, ui, monoFont, frame, header, subbar, segmented, iconButton, textButton, empty, row, section } from "../../lib/ui.js";
import { location, baseName, slash } from "../../lib/where.js";
import { gitRead, gitWrite } from "../../lib/git.js";
import { iconFor } from "../../lib/icons.js";
import { openFull, closeFull } from "../../lib/nav.js";
import Diff from "../../lib/diff/index.js";
import Preview from "../../lib/preview/index.js";
import { layoutLanes } from "./lanes.js";
import { UNCOMMITTED, LABEL, withUncommitted, labelsOf, hitLabel } from "./ops.js";
import { PAGE, readFolder, readStatus, readDetails, readUncommitted, readCommit, signature, lastRead, cachedDetails, keepDetails, forgetDetails } from "./load.js";
import { unsearched, depthOf, findRepos, readRepo, readRemotes, webUrl, syncOf, pool } from "./repos.js";
import { perform, openMenu, openSettings, showChanges, CHANGED } from "./act.js";
import { Menu, Dialog, Settings, DEPTH_KEY } from "./overlays.js";
import { LANE, PAD, commitRow, tint } from "./table.js";
import { overview } from "./details.js";

const SEEN = 24, SPLIT = { min: 240, max: 0.7, default: 320 }, OVERVIEW_W = 340, SPLIT_LAYOUT = 760;
const COLS = { date: 44, author: 110, hash: 64 };
const isRefChange = (p) => /\/(HEAD|packed-refs|FETCH_HEAD|ORIG_HEAD)$|\/refs\//.test(p);
const inGitDir = (p) => p.includes("/.git/") || p.endsWith("/.git");
const sameFiles = (a, b) => a.length === b.length && a.every((f, i) => f.path === b[i].path && f.status === b[i].status);
const keep = (map, key, value, max) => { map.delete(key); map.set(key, value); if (map.size > max) map.delete(map.keys().next().value); };
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// Whether a layout shows a graph block: not when the block is hidden, or is a stack's other child
// (the side panel showing Files). -> true, false, or null when the layout has no graph block (a
// graph in a pane, a window: taken as shown).
function graphShown(node, shown = true) {
  if (!node || typeof node !== "object") return null;
  shown = shown && !node.hidden;
  if (node.type === "block") return node.content?.props?.view === "graph" ? shown : null;
  let any = null;
  const active = node.type === "stack" ? node.active ?? node.children?.[0]?.id : null;
  for (const child of node.children ?? []) {
    const r = graphShown(child, shown && (active === null || child.id === active));
    if (r === true) return true;
    if (r === false) any = false;
  }
  for (const child of node.floating ?? []) {
    const r = graphShown(child, shown);
    if (r === true) return true;
    if (r === false) any = false;
  }
  return any;
}

// The folders git ignores (target/, node_modules/), lowercased, relative to the top: a build
// writing there changes nothing the graph shows, so the folder watch skips those paths. Only the
// folders an ignore rule names ("!! target/"): ls-files --directory also lists a folder whose files
// all happen to be ignored (logs/ holding only *.log), and a new file there would go unseen.
async function ignoredDirs(root) {
  const r = await gitRead(["status", "--porcelain=v1", "-z", "--no-renames", "--ignored=matching", "--untracked-files=normal"], root, { timeout: 10000 }).catch(() => null);
  if (!r || r.code !== 0) return new Set();
  return new Set(r.stdout.split("\0").filter((e) => e.startsWith("!! ") && e.endsWith("/")).slice(0, 5000).map((e) => e.slice(3).toLowerCase()));
}

function tilde(path, on) {
  const h = slash(home?.() ?? "");
  return !on && h && slash(path ?? "").toLowerCase().startsWith(h.toLowerCase()) ? "~" + slash(path).slice(h.length) : path;
}

// What belongs to one folder: a new folder starts from this, and leaving one keeps it.
const folderState = () => ({
  state: "loading", root: null, on: null, cwd: null, error: null,
  workspace: null, statuses: new Map(), opened: null, skipped: false,
  base: [], commits: [], rows: [], lanes: 1, labels: new Map(), index: new Map(), hasMore: false, limit: PAGE, files: [], ctx: null,
  head: null, current: null, branches: [], remoteNames: [], upstream: null, signature: null, sig: null, scope: null, moreAsked: null,
  selected: null, shown: null, page: "graph", tab: "overview", file: null,
});

export default class GraphView extends View {
  init(p, cx) {
    // `new GraphView(props)` already runs init (gpui-kit's View constructor, with the running call's
    // context), and lib/inline.js calls it again: a second run would double every timer, task and
    // the first read.
    if (this.started) return;
    this.started = true;
    this.p = p ?? {};
    const role = this.p.role ?? props()?.role;
    if (role) {
      this.part = role === "menu" ? new Menu() : role === "dialog" ? new Dialog() : new Settings();
      this.part.init(cx);
      return;
    }
    this.folder = this.p.folder ?? null;
    const start = this.p.start ?? (props()?.tab === "graph" ? props()?.start : null) ?? null;
    this.startRev = start?.rev ?? null; this.startRepo = start?.repo ?? null;
    // A scrollbar finds its list by name: each copy (panel, full mode) needs its own.
    this.listId = `graph-rows-${Math.random().toString(36).slice(2)}`;
    this.scroll = VirtualListScrollHandle.new();
    this.handle = cx.focus_handle();
    this.all = load("graph.scope") !== "head";
    this.remotes = load("graph.remotes") !== "off";
    this.split = Number(load("graph.split")) || SPLIT.default;
    this.seen = new Map(); this.watchToken = 0; this.seenChange = shared(CHANGED);
    this.find = null; this.ticks = 0;
    this.findState = InputState.new({ placeholder: "Find a commit, author, hash or ref" });
    this.findState.on("change", (_e, cx) => { this.setQuery(this.findState.value(), cx); });
    this.findState.on("submit", (e, cx) => this.findNext(e?.shift ? -1 : 1, cx));
    this.reset();
    // Callbacks the shared components call without a cx (Diff's onOpenFile, Preview's onOpen) post
    // here; this task runs them with its own cx.
    this.inbox = [];
    // The reads, tasks and timers start with the first draw (render reads the place then), so a
    // copy that is made but never drawn costs nothing.
  }

  // The copy's own tasks and timers; render starts them the first time it draws.
  begin(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise((resolve) => { this.wake = resolve; });
        for (const job of this.inbox.splice(0)) { try { job(cx); } catch (e) { console.log(`graph: ${e?.message ?? e}`); } }
        cx.notify();
      }
    });
    // A cheap check of the refs (local and remote): a commit, checkout or fetch from a terminal
    // shows even when the folder watch misses it. Remote spaces can't be watched at all.
    cx.timer.every(5000, (cx) => this.poll(cx));
    // A nested view isn't drawn again when Herdr's live data changes (focus, spaces), so the place
    // is checked here: plain JS reads, no process, and a redraw only when the focus moved folders.
    // A hidden copy skips it: showing it again draws it, and render checks the place.
    cx.timer.every(600, (cx) => { if (!this.folder && this.key() !== this.context && !this.hidden()) { this.refresh(cx); cx.notify(); } });
  }

  // A copy stays alive while its block is hidden (the panel closed, or showing Files): it reads
  // nothing then and notes what it missed; render catches up when it shows again.
  hidden() {
    if (this.folder || this.isFull()) return false;
    let shown = null;
    try {
      shown = graphShown(layout());
      // A mod pane in the shown tab may be a graph too (panes don't say their props): taken as shown.
      if (shown === false) { const tab = focused()?.tab; if (panes().some((p) => p.mod && p.tab === tab)) shown = true; }
    } catch {}
    return shown === false;
  }
  miss(what) {
    const rank = { poll: 1, status: 2, full: 3 };
    if ((rank[what] ?? 0) > (rank[this.missed] ?? 0)) this.missed = what;
  }
  catchUp(cx) {
    const missed = this.missed;
    if (!missed || this.hidden()) return;
    this.missed = null;
    if (missed === "full") this.refresh(cx, true);
    else if (this.state === "workspace") this.rescan(cx);
    else if (missed === "status") this.refresh(cx, false);
    else this.poll(cx, true);
  }

  update(p) { this.p = p ?? {}; }

  post(job) { this.inbox.push(job); this.wake?.(); }

  // ---- where, and loading

  place() {
    if (this.folder) return { cwd: this.folder, on: null };
    const l = location();
    if (!l.cwd && this.lastPlace) return this.lastPlace;
    if (l.cwd) this.lastPlace = { cwd: l.cwd, on: l.on };
    return { cwd: l.cwd, on: l.on };
  }
  key() { const { cwd, on } = this.place(); return JSON.stringify([cwd, on]); }
  isFull() { return Boolean(this.p.full) || props()?.view === "full"; }
  fullOverlay() { return props()?.view === "full" ? props()?.overlay ?? null : null; }

  reset() {
    Object.assign(this, folderState());
    this.watchToken++; this.watching = null;
  }

  // Leaving a folder keeps it as it was; coming back shows that at once, while refresh reads it again.
  enter(context) {
    if (this.context && ["ready", "empty", "norepo", "workspace"].includes(this.state)) {
      keep(this.seen, this.context, Object.fromEntries(Object.keys(folderState()).map((k) => [k, this[k]])), SEEN);
    }
    this.context = context; this.reset(); this.loading = null;
    const kept = this.seen.get(context);
    if (kept && (kept.state !== "ready" && kept.state !== "empty" || kept.scope === `${this.all} ${this.remotes}`)) Object.assign(this, kept);
    // Full mode opened from a repository picked in the Manygit list: that repository.
    if (this.startRepo) { this.opened = this.startRepo; this.startRepo = null; this.root = null; this.state = "loading"; }
  }

  // A load belongs to its folder: a slower load for the old one finds itself stale and drops its result.
  refresh(cx, full = true) {
    const { cwd, on } = this.place(), context = this.key();
    if (context !== this.context) { this.enter(context); full = true; }
    if (!cwd) { this.state = "nofolder"; return; }
    const { all, remotes, limit } = this, opened = this.opened;
    const loadKey = JSON.stringify([context, opened]);
    if (this.loading?.key === loadKey) { this.again = this.again === "full" || full ? "full" : "status"; return; }
    const id = this.loadSeq = (this.loadSeq ?? 0) + 1;
    this.loading = { key: loadKey, id }; this.again = null;
    const stale = () => this.loadSeq !== id || this.key() !== context;
    // Another copy (the panel, for full mode) read this folder already: show that at once, then read again.
    const known = this.state === "loading" && !this.root ? lastRead(opened ?? cwd, on, { all, remotes }) : null;
    let changed = false;
    cx.spawn(async (cx) => {
      try {
        // (A task starts inside the call that spawned it, maybe a render, where the Diff can't be made.)
        if (known) await cx.sleep(0);
        if (known && !stale()) {
          Object.assign(this, known);
          if (!opened) this.workspace = null;
          if (!on) this.watch(known.root, context, cx);
          this.build(cx); changed = true; cx.notify();
        }
        if (full || !this.root || known) {
          const read = await readFolder(opened ?? cwd, on, { all, remotes, limit: known ? this.limit : limit });
          if (stale()) return;
          if (read.state === "norepo") {
            changed = true;
            if (opened) { this.state = "error"; this.error = `${tilde(opened, on)} isn't a git repository any more.`; return; }
            await this.scan(cwd, on, stale, cx); return;
          }
          if (!opened) this.workspace = null;
          if (!on) this.watch(read.root, context, cx);
          // A second look that finds nothing new leaves the table as it is.
          const shown = this.state === "ready" || this.state === "empty";
          if (shown && read.signature === this.signature && read.scope === this.scope && sameFiles(read.files, this.files)) { this.sig = read.sig; return; }
          Object.assign(this, read);
        } else {
          const files = await readStatus(this.root, this.on);
          if (stale() || sameFiles(files, this.files)) return;
          this.files = files;
        }
        this.build(cx); changed = true;
      } catch (e) {
        if (!stale()) { this.state = "error"; this.error = String(e?.message ?? e); changed = true; }
      } finally {
        if (this.loading?.id === id) {
          this.loading = null;
          // A read that found nothing new doesn't redraw (a redraw draws the whole window), unless
          // the table showed that it was loading more.
          if (changed || this.moreShown) { this.moreShown = false; cx.notify(); }
          if (this.again) this.refresh(cx, this.again === "full");
        }
      }
    });
  }

  // Every 5 s: watched folders check their refs every 15 s (the watch sees most changes), the
  // others (remote, unwatchable) every time; the Manygit list every 15 s.
  poll(cx, now = false) {
    if (this.loading || this.checking) return;
    const tick = now || ++this.ticks % 3 === 0;
    if (this.state === "workspace") { if (tick) { if (this.hidden()) this.miss("poll"); else this.rescan(cx); } return; }
    if (!this.root || (this.state !== "ready" && this.state !== "empty")) return;
    if (this.watching && !this.on && !tick) return;
    if (!now && this.hidden()) { this.miss("poll"); return; }
    this.checking = true;
    const context = this.key(), root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      try {
        const sig = await signature(root, on).catch(() => null);
        if (this.key() !== context || this.root !== root) return;
        if (sig && sig !== this.sig) this.refresh(cx, true);
        else if (on || !this.watching) this.refresh(cx, false);   // no watch: the uncommitted row by polling
      } finally { this.checking = false; }
    });
  }

  // Manygit: find the repositories under cwd, then read each one's status.
  async scan(cwd, on, stale, cx) {
    const depth = depthOf(shared(DEPTH_KEY));
    if (unsearched(cwd, on ? null : home())) { this.reset(); Object.assign(this, { state: "norepo", cwd, on, skipped: true }); return; }
    const repos = await findRepos(cwd, on, depth).catch(() => []);
    if (stale()) return;
    if (!repos.length) { this.reset(); Object.assign(this, { state: "norepo", cwd, on }); return; }
    const same = this.workspace?.root === cwd, statuses = same ? this.statuses : new Map();
    if (!same) this.reset();
    this.workspace = { root: cwd, depth, repos }; this.statuses = statuses; this.cwd = cwd; this.on = on; this.state = "workspace";
    cx.notify();
    await pool(repos, 6, (repo) => this.readRepoStatus(repo.path, on, stale, cx));
  }

  rescan(cx) {
    const ws = this.workspace;
    if (!ws) return;
    const root = ws.root, on = this.on;
    cx.spawn((cx) => pool(ws.repos, 6, (r) => this.readRepoStatus(r.path, on, () => this.workspace?.root !== root, cx)));
  }

  async readRepoStatus(path, on, stale, cx) {
    if (stale()) return;
    const st = await readRepo(path, on).catch((e) => ({ error: String(e?.message ?? e) }));
    if (stale() || !this.workspace) return;
    if (JSON.stringify(st) !== JSON.stringify(this.statuses.get(path))) { this.statuses.set(path, st); cx.notify(); }
  }

  openRepo(path, cx) {
    const { workspace, statuses, cwd, on } = this;
    this.reset(); Object.assign(this, { workspace, statuses, cwd, on, opened: path, state: "loading" });
    this.refresh(cx); this.handle.focus(); cx.notify();
  }

  backToRepos(cx) {
    const { workspace, statuses, cwd, on } = this;
    this.reset();
    if (workspace) Object.assign(this, { workspace, statuses, cwd, on, state: "workspace" });
    this.refresh(cx); cx.notify();
  }

  repoMenu(r, cx) {
    const st = this.statuses.get(r.path), on = this.on;
    if (!st || st.error) return;
    cx.spawn(async () => {
      const remotes = await readRemotes(r.path, on).catch(() => []);
      const web = webUrl((remotes.find((x) => x.name === "origin") ?? remotes[0])?.url ?? "");
      const ctx = { root: r.path, on, current: st.detached ? null : st.branch ?? null, head: st.head ?? null, branches: [], remotes: remotes.map((x) => x.name) };
      openMenu({ kind: "repo", path: r.path, status: st, web }, ctx);
    });
  }

  // Fetch every listed repository that has a remote, 6 at a time; no login prompt can stop it.
  fetchEvery(cx) {
    const ws = this.workspace;
    if (!ws || this.fetchAll) return;
    const repos = ws.repos.filter((r) => { const st = this.statuses.get(r.path); return !st || st.error || st.upstream || st.hasRemote; });
    const run = this.fetchAll = { root: ws.root, done: 0, total: repos.length, failed: 0 }, on = this.on;
    cx.spawn(async (cx) => {
      await pool(repos, 6, async (r) => {
        const out = await gitWrite(["-c", "credential.interactive=never", "-c", "core.askPass=", "fetch", "--quiet"], r.path, { on, timeout: 120000 })
          .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
        if (out.code !== 0) run.failed++;
        run.done++;
        await this.readRepoStatus(r.path, on, () => this.workspace?.root !== run.root, cx);
        cx.notify();
      });
      if (this.fetchAll === run) this.fetchAll = null;
      const n = (k) => count(k, "repository").replace("repositorys", "repositories");
      notify(run.failed ? { title: `Fetched ${run.total - run.failed} of ${n(run.total)}`, level: "warning" } : { title: `Fetched ${n(run.total)}`, level: "success", timeout: 3000 });
      cx.notify();
    });
    cx.notify();
  }

  build(cx) {
    const commits = withUncommitted(this.base, this.files.length, this.head);
    const { rows, width } = layoutLanes(commits);
    this.commits = commits; this.rows = rows; this.lanes = width;
    this.labels = new Map(commits.map((c) => [c.hash, labelsOf(c, this.remotes)]));
    this.index = new Map(commits.map((c, i) => [c.hash, i]));
    this.ctx = { root: this.root, on: this.on, current: this.current, head: this.head, branches: this.branches, remotes: this.remoteNames, fullOverlay: this.fullOverlay() };
    this.state = commits.length ? "ready" : "empty"; this.error = null;
    if (this.find) this.setQuery(this.find.query);
    // The selection and the details survive by hash.
    if (this.selected && !this.index.has(this.selected)) this.selected = null;
    if (this.shown) {
      const now = this.commits[this.index.get(this.shown.hash)];
      if (now) { this.shown = now; if (now.uncommitted) { forgetDetails(this.uncommittedKey()); this.loadDetails(now, cx); this.syncDiff(cx, true); } }
      else if (this.shown.uncommitted) this.closeDetails();
    }
    if (this.startRev) {
      const want = this.startRev; this.startRev = null;
      const c = want === UNCOMMITTED ? this.commits[0]?.uncommitted && this.commits[0] : this.commits.find((x) => x.hash.startsWith(want));
      if (c) { this.select(c.hash, cx, { open: true, scroll: true }); return; }
      if (want !== UNCOMMITTED) { this.goTo(want, cx); return; }
    }
    // Full mode shows a commit from the start: HEAD's.
    if (this.p.wide && !this.shown) {
      const c = this.commits[this.index.get(this.head)] ?? this.commits.find((x) => !x.uncommitted) ?? this.commits[0];
      if (c) this.select(c.hash, cx, { open: true, scroll: true });
    }
  }

  // Ref moves reload the history; other edits only the uncommitted row, at most every 1.5 s.
  watch(root, context, cx) {
    if (this.watching === root) return;
    this.watching = root;
    const token = this.watchToken, top = `${root}/`.toLowerCase();
    let ignored = new Set(), ignoredAt = 0;
    const readIgnored = () => { ignoredAt = Date.now(); ignoredDirs(root).then((dirs) => { if (token === this.watchToken) ignored = dirs; }); };
    readIgnored();
    // In a folder git ignores (a build's output)?
    const isIgnored = (p) => {
      if (!ignored.size || !p.toLowerCase().startsWith(top)) return false;
      const rel = p.slice(top.length).toLowerCase();
      for (let i = rel.indexOf("/"); i >= 0; i = rel.indexOf("/", i + 1)) if (ignored.has(rel.slice(0, i + 1))) return true;
      return false;
    };
    const loop = (dir, gitDir) => cx.spawn(async (cx) => {
      try {
        while (token === this.watchToken) {
          // Windows reports backslashes (some with a \\?\ prefix); the checks read plain slashes.
          const paths = (await watchFolder(dir)).map((p) => slash(p).replace(/^\/\/\?\//, ""));
          if (token !== this.watchToken) return;
          const refs = paths.some((p) => (gitDir || inGitDir(p)) && isRefChange(p));
          // In .git, only this checkout's index (staging); not another worktree's (.git/worktrees/*/index).
          const files = !refs && paths.some((p) => !gitDir && (inGitDir(p) ? p.toLowerCase() === `${top}.git/index` : !isIgnored(p)));
          // A folder ignored since (the first build) shows up as plain changes: read the list again now and then.
          if (files && Date.now() - ignoredAt > 60000) readIgnored();
          if (refs) { if (this.hidden()) this.miss("full"); else this.refresh(cx, true); }
          else if (files) { if (this.hidden()) this.miss("status"); else this.statusSoon(cx); }
        }
      } catch { if (token === this.watchToken) this.watching = null; }
    });
    loop(root, false);
    // A linked worktree keeps its refs in the main checkout's .git.
    cx.spawn(async () => {
      const common = slash((await gitRead(["rev-parse", "--git-common-dir"], root)).stdout.trim());
      const dir = /^([a-zA-Z]:)?\//.test(common) ? common : `${root}/${common}`;
      if (common && token === this.watchToken && this.key() === context && !dir.toLowerCase().startsWith(`${root}/`.toLowerCase())) loop(dir, true);
    });
  }

  statusSoon(cx) {
    if (this.statusTimer) return;
    this.statusTimer = true;
    cx.timer.after(Math.max(0, 1500 - (Date.now() - (this.lastStatus ?? 0))), (cx) => {
      this.statusTimer = false; this.lastStatus = Date.now(); this.refresh(cx, false);
    });
  }

  loadMore(cx) { if (!this.hasMore) return; this.limit += PAGE; this.refresh(cx); cx.notify(); }
  setScope(all, cx) { if (this.all !== all) { this.all = all; save("graph.scope", all ? "all" : "head"); this.limit = PAGE; this.refresh(cx); } cx.notify(); }
  setRemotes(cx) { this.remotes = !this.remotes; save("graph.remotes", this.remotes ? "on" : "off"); this.refresh(cx); cx.notify(); }

  fetch(cx) {
    if (this.fetching || !this.ctx) return;
    this.fetching = true;
    const ctx = this.ctx;
    cx.spawn(async (cx) => { await perform({ type: "fetch" }, {}, ctx).catch(() => {}); this.fetching = false; this.refresh(cx); cx.notify(); });
    cx.notify();
  }

  // ---- selection and details

  select(hash, cx, { open = false, scroll = false, settle = false } = {}) {
    const c = this.commits[this.index.get(hash)];
    if (!c) return;
    this.selected = hash;
    if (scroll) this.scroll.scroll_to_item(this.index.get(hash), "center");
    if (this.p.wide || open) this.show(c, cx, settle);
    if (open && !this.p.wide) this.page = "commit";
  }

  // Moves the selection by step rows (the arrows); full mode shows each commit as it goes.
  move(step, cx) {
    if (!this.commits.length) return;
    const i = this.index.get(this.selected) ?? (step > 0 ? -1 : this.commits.length);
    const j = Math.max(0, Math.min(this.commits.length - 1, i + step));
    this.select(this.commits[j].hash, cx, { scroll: true, settle: true });
    if (j >= this.commits.length - 5) this.loadMore(cx);
  }

  // settle: the arrows pass over commits: the header shows at once (it's in the table), the files
  // and the diff once the selection rests a moment, so holding an arrow doesn't start git per row.
  show(commit, cx, settle = false) {
    const changed = this.shown?.hash !== commit.hash;
    this.shown = commit;
    if (changed) { this.file = null; if (this.tab === "file") this.tab = this.p.wide ? "diff" : "overview"; }
    if (settle && changed) {
      const seq = this.settling = this.settleSeq = (this.settleSeq ?? 0) + 1;
      // By hash: a status read meanwhile rebuilds the table and replaces the commit object.
      cx.timer.after(140, (cx) => { if (this.settling === seq && this.shown?.hash === commit.hash) { this.loadDetails(this.shown, cx); this.syncDiff(cx); cx.notify(); } });
      return;
    }
    this.settling = null;
    this.loadDetails(commit, cx);
    this.syncDiff(cx);
  }

  closeDetails() { this.shown = null; this.page = "graph"; this.file = null; this.tab = "overview"; }

  uncommittedKey() { return `${this.on}\0${this.root}\0*${this.files.map((f) => f.status + f.path).join("\0")}`; }
  detailsKey(commit) { return commit.uncommitted ? this.uncommittedKey() : `${this.on}\0${this.root}\0${commit.hash}`; }
  detailsFor(commit) { return cachedDetails(this.detailsKey(commit)); }
  laneOf(hash) { return this.rows[this.index.get(hash)]?.lane ?? 0; }

  loadDetails(commit, cx) {
    const key = this.detailsKey(commit);
    if (cachedDetails(key) || this.loadingDetails === key) return;
    this.loadingDetails = key;
    const root = this.root, on = this.on, files = this.files, head = this.head;
    cx.spawn(async (cx) => {
      await keepDetails(key, () => (commit.uncommitted ? readUncommitted(root, on, files, head) : readDetails(root, on, commit.hash)));
      if (this.loadingDetails === key) this.loadingDetails = null;
      // Only the commit on screen needs a redraw (the arrows pass over many).
      if (this.shown && this.detailsKey(this.shown) === key) cx.notify();
    });
  }

  // A parent: in the table, it's selected there; past the loaded page, read from git.
  goTo(hash, cx) {
    if (this.index.has(hash)) { this.select(hash, cx, { open: true, scroll: true }); cx.notify(); return; }
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      try {
        const c = await readCommit(root, on, hash);
        if (this.root !== root) return;
        this.selected = null; this.show(c, cx);
        if (!this.p.wide) this.page = "commit";
      } catch (e) { notify({ title: "Can't show that commit", body: String(e?.message ?? e), level: "error" }); }
      cx.notify();
    });
  }

  diffVisible() {
    if (!this.shown) return false;
    if (this.tab === "diff") return true;
    return Boolean(this.p.wide) && this.detailWidth() >= SPLIT_LAYOUT && this.tab !== "file";
  }

  // The shared Diff, made the first time it shows and given the shown commit when it's visible.
  syncDiff(cx, force = false) {
    if (!this.shown || !this.diffVisible()) return;
    const c = this.shown, source = c.uncommitted ? { kind: "head" } : { kind: "commit", rev: c.hash };
    const key = JSON.stringify([this.on, this.root, source, c.uncommitted ? this.files.length : 0]);
    if (!force && key === this.diffKey && this.diffView) return;
    this.diffKey = key;
    const p = { on: this.on, top: this.root, source, onOpenFile: (path, rev) => this.post((cx) => this.openPath(path, rev ?? null, cx)) };
    if (this.diffView) this.diffView.set_props(p); else this.diffView = cx.new(Diff, p);
  }

  // A changed file, as of the commit (a deleted one as of its parent; uncommitted: the disk).
  openFile(commit, f, cx) {
    const rev = commit.uncommitted ? (f.status === "D" ? "HEAD" : null) : f.status === "D" ? `${commit.hash}^` : commit.hash;
    this.openPath(f.path, rev, cx);
  }

  openPath(path, rev, cx) {
    if (rev === UNCOMMITTED) rev = null;
    this.file = { path, rev };
    this.tab = "file";
    const p = { on: this.on, root: this.root, path, rev, repoTop: this.root, wide: Boolean(this.p.wide),
      onOpen: (rel, r) => this.post((cx) => this.openPath(rel, r === undefined ? rev : r, cx)),
      // While the preview edits (a file from disk), typed keys are the editor's.
      onEditing: (on) => { this.editing = on; } };
    if (this.previewView) this.previewView.set_props(p); else this.previewView = cx.new(Preview, p);
    this.handle.focus();
    cx.notify();
  }

  setTab(tab, cx) {
    this.tab = tab;
    if (tab !== "file") this.syncDiff(cx);
    cx.notify();
  }

  back(cx) {
    if (this.find) { this.closeFind(cx); return true; }
    if (this.tab === "file") { this.setTab(this.p.wide && this.detailWidth() >= SPLIT_LAYOUT ? "diff" : "overview", cx); return true; }
    if (!this.p.wide && this.page === "commit") { this.page = "graph"; this.tab = "overview"; cx.notify(); return true; }
    if (this.opened) { this.backToRepos(cx); return true; }
    return false;
  }

  copy(text, cx) { cx.write_to_clipboard(text); notify({ title: "Copied", body: text, level: "success", timeout: 2000 }); }
  showChanges() { showChanges(this.fullOverlay()); }
  expand() { openFull("graph", { rev: this.shown?.hash ?? this.selected ?? null, repo: this.opened ?? null }); }

  // ---- find

  openFind(cx) {
    if (this.state !== "ready") return;
    this.find ??= { query: "", matches: [], at: -1 };
    if (!this.p.wide && this.page === "commit") this.page = "graph";
    this.findState.focus();
    cx.notify();
  }
  closeFind(cx) { this.find = null; this.findState.set_value(""); this.handle.focus(); cx.notify(); }

  setQuery(query, cx) {
    if (!this.find) return;
    const q = query.trim().toLowerCase();
    const matches = !q ? [] : this.commits.filter((c) => !c.uncommitted && (c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q)
      || c.hash.startsWith(q) || c.refs.some((r) => r.name.toLowerCase().includes(q)))).map((c) => c.hash);
    const keepAt = matches.indexOf(this.find.matches[this.find.at]);
    this.find = { query, matches, at: keepAt >= 0 ? keepAt : matches.length ? 0 : -1, set: new Set(matches) };
    if (cx && matches.length && keepAt < 0) this.select(matches[0], cx, { scroll: true });
    cx?.notify();
  }

  findNext(step, cx) {
    const f = this.find;
    if (!f?.matches.length) return;
    f.at = (f.at + step + f.matches.length) % f.matches.length;
    this.select(f.matches[f.at], cx, { scroll: true });
    cx.notify();
  }

  // ---- the table's pointer

  // Pointer positions come in window units; layout sizes are these units times the zoom.
  unit() { return this.scale ?? settings().zoom ?? 1; }
  // A row is a whole number of screen pixels (21.6 at zoom 0.9 leaves hairline gaps between rows).
  rowH() { const z = settings().zoom ?? 1; return Math.max(1, Math.round(LANE * 2 * z)) / z; }
  listWidth() { return this.p.wide && this.state === "ready" ? this.splitWidth() : this.width ?? 400; }
  splitWidth() { return Math.round(Math.max(SPLIT.min, Math.min((this.width ?? 1200) * SPLIT.max, this.split))); }
  detailWidth() { return (this.width ?? 1200) - this.splitWidth() - 5; }
  graphWidth() { return Math.min(Math.max(28, PAD * 2 + this.lanes * LANE), Math.max(40, Math.round(this.listWidth() * 0.4))); }
  wideColumns() { return this.listWidth() >= 600; }
  // Where the subject column ends: labels past it are clipped, so not clickable.
  labelLimit() {
    const trailing = COLS.date + LABEL.GAP + (this.wideColumns() ? COLS.author + COLS.hash + LABEL.GAP * 2 : 0);
    return this.listWidth() - SIZE.pad - trailing - LABEL.GAP;
  }

  // A left press, then on release the list names the row: together, a click on it.
  clicked(key, cx) {
    this.press = null;
    this.handle.focus();
    if (key === "more") return this.loadMore(cx);
    const commit = this.commits[this.index.get(key)];
    if (!commit) return;
    // Anywhere on the row, labels too, a click opens the commit. A double-click never checks a
    // branch out: that is the right-click menu's Checkout, on purpose only.
    this.select(commit.hash, cx, { open: true });
    cx.notify();
  }

  contextMenu(key, e) {
    const commit = this.commits[this.index.get(key)];
    if (!commit || !this.ctx) return;
    if (e.bounds?.height) this.scale = e.bounds.height / this.rowH();
    const x = (e.local_position?.x ?? 0) / this.unit();
    const brief = { hash: commit.hash, subject: commit.subject, parents: commit.parents };
    const hit = commit.uncommitted ? null : hitLabel(this.labels.get(key), x, this.graphWidth(), this.labelLimit());
    const target = commit.uncommitted ? { kind: "uncommitted", commit: brief, staged: this.files.some((f) => f.staged) }
      : hit && hit.part.kind !== "head" ? { kind: hit.part.kind, name: hit.part.name, commit: brief }
      : { kind: "commit", commit: brief };
    openMenu(target, { ...this.ctx, fullOverlay: this.fullOverlay() });
  }

  // ---- the split between the graph and the details (full mode)

  startDrag(e, cx) {
    cx.stop_propagation();
    if (e.click_count >= 2) { this.split = SPLIT.default; save("graph.split", String(this.split)); this.syncDiff(cx); cx.notify(); return; }
    this.drag = { x: e.position.x, from: this.splitWidth() };
  }
  moveDrag(e, cx) {
    const d = this.drag;
    if (!d) return;
    const w = Math.round(d.from + (e.position.x - d.x) / (settings().zoom ?? 1));
    if (w !== this.split) { this.split = w; d.moved = true; cx.notify(); }
  }
  endDrag(cx) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.moved) { this.split = this.splitWidth(); save("graph.split", String(this.split)); this.syncDiff(cx); }
    cx.notify();
  }

  // ---- drawing

  onKey(e, cx) {
    if (this.editing) return;
    const k = e.key, ctrl = e.modifiers?.control || e.modifiers?.platform;
    if ((ctrl && k === "f") || (k === "/" && !ctrl)) { this.openFind(cx); cx.stop_propagation(); return; }
    if (this.find && k === "escape") { this.closeFind(cx); cx.stop_propagation(); return; }
    const onGraph = this.p.wide || this.page === "graph";
    if (onGraph && this.state === "ready" && (k === "down" || k === "up")) { this.move(k === "down" ? 1 : -1, cx); cx.stop_propagation(); cx.notify(); return; }
    if (onGraph && this.state === "ready" && (k === "pagedown" || k === "pageup")) { this.move(k === "pagedown" ? 20 : -20, cx); cx.stop_propagation(); cx.notify(); return; }
    if (k === "enter" && this.selected && !this.p.wide && this.page === "graph") { this.select(this.selected, cx, { open: true }); cx.stop_propagation(); cx.notify(); return; }
    if (k === "escape" || k === "backspace") { if (this.back(cx)) cx.stop_propagation(); }
  }

  expandButton(t) {
    return this.isFull() ? iconButton(t, "graph-collapse", "collapse", () => closeFull()) : iconButton(t, "graph-expand", "expand", () => this.expand());
  }

  masterHeader(t) {
    const ready = this.state === "ready" || this.state === "empty", ws = this.workspace;
    const name = this.root ? baseName(this.root) : ws ? baseName(ws.root) : null;
    const actions = [];
    if (this.state === "ready") actions.push(iconButton(t, "graph-find", "search", (_e, cx) => (this.find ? this.closeFind(cx) : this.openFind(cx)), { on: Boolean(this.find) }));
    if (ready && this.remoteNames?.length > 0) actions.push(iconButton(t, "graph-fetch", "fetch", (_e, cx) => this.fetch(cx), { on: Boolean(this.fetching), disabled: Boolean(this.fetching) }));
    if (this.state === "workspace") actions.push(iconButton(t, "graph-fetch-all", "fetch", (_e, cx) => this.fetchEvery(cx), { on: Boolean(this.fetchAll), disabled: Boolean(this.fetchAll) }));
    if (this.state !== "nofolder") actions.push(iconButton(t, "graph-refresh", "rotate-cw", (_e, cx) => { forgetDetails(); this.refresh(cx); if (this.state === "workspace") this.rescan(cx); cx.notify(); }));
    if (this.state === "workspace" || (this.state === "norepo" && !this.skipped)) actions.push(iconButton(t, "graph-settings", "settings", () => openSettings()));
    actions.push(this.expandButton(t));
    const subtitle = this.state === "workspace" ? `${count(ws.repos.length, "repo")}${this.fetchAll ? ` · fetching ${this.fetchAll.done}/${this.fetchAll.total}` : ""}`
      : this.fetching ? `${name} · fetching…` : name;
    return header(t, { id: "graph-header", icon: "git-graph", title: this.state === "workspace" ? "Repositories" : "Graph", subtitle,
      back: this.opened ? (_e, cx) => this.backToRepos(cx) : null, backLabel: "Repos", actions });
  }

  toolbar(t) {
    const where = this.current ?? (this.head ? `detached ${this.head.slice(0, 8)}` : null);
    const n = this.base.length, w = this.listWidth(), roomy = w >= 420;
    return subbar(t, "graph-toolbar")
      .child(segmented(t, "graph-scope", [{ id: "all", label: roomy ? "All branches" : "All" }, { id: "head", label: "Current" }], this.all ? "all" : "head", (id, cx) => this.setScope(id === "all", cx)))
      .child(textButton(t, "graph-remotes", "Remotes", (_e, cx) => this.setRemotes(cx), { icon: this.remotes ? "check" : "cloud", on: this.remotes }))
      .child(div().flex_1())
      .when(n > 0 && roomy, (e) => e.child(div().flex_none().text_size(SIZE.small).text_color(t.dim).child(`${n}${this.hasMore ? "+" : ""}`)))
      .when(Boolean(where), (e) => e.child(h_flex().h(20).px(7).gap(5).flex_shrink_1().min_w(24).max_w(roomy ? 200 : 120).items_center().rounded(SIZE.radius)
        .bg(tint(t.accent, "1f", t.selected)).text_color(t.accent)
        .child(svg(ui(this.current ? "git-branch" : "git-commit")).size(12).flex_none())
        .child(div().min_w(0).truncate().text_size(SIZE.small).font_semibold().child(where))));
  }

  findBar(t) {
    const f = this.find, n = f.matches.length;
    return subbar(t, "graph-findbar")
      .child(svg(ui("search")).size(SIZE.icon).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).child(Input.new(this.findState).w_full().h(22).px(6).rounded(SIZE.radius - 2).border_1().border_color(t.input)
        .bg(t.background).text_size(SIZE.text).text_color(t.foreground)))
      .child(div().flex_none().text_size(SIZE.small).text_color(f.query && !n ? t.ansi1 : t.dim).child(f.query ? (n ? `${f.at + 1}/${n}` : "none") : ""))
      .child(iconButton(t, "graph-find-prev", "chevron-up", (_e, cx) => this.findNext(-1, cx), { disabled: !n, size: 22 }))
      .child(iconButton(t, "graph-find-next", "chevron-down", (_e, cx) => this.findNext(1, cx), { disabled: !n, size: 22 }))
      .child(iconButton(t, "graph-find-close", "close", (_e, cx) => this.closeFind(cx), { size: 22 }));
  }

  columns(t, width) {
    return h_flex().h(22).flex_none().pr(SIZE.pad).gap(LABEL.GAP).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
      .child(div().w(width).flex_none().pl(PAD).overflow_hidden().whitespace_nowrap().child(width >= 40 ? "Graph" : "")).child(div().flex_1().min_w(0).child("Description"))
      .child(div().w(COLS.author).flex_none().child("Author")).child(div().w(COLS.hash).flex_none().child("Commit"))
      .child(div().w(COLS.date).flex_none().text_right().child("Date"));
  }

  list(t, mono) {
    const width = this.graphWidth(), h = this.rowH(), wide = this.wideColumns(), n = this.commits.length + (this.hasMore ? 1 : 0), matches = this.find?.set;
    return v_flex().flex_1().min_h(0).min_w(0)
      .when(wide, (e) => e.child(this.columns(t, width)))
      .child(div().flex_1().min_h(0).relative()
        .on_mouse_down("left", (e) => { this.press = { x: (e.local_position?.x ?? 0) / this.unit(), count: e.click_count }; this.handle.focus(); })
        .child(v_virtual_list(this.listId, n, h, (i) => this.commits[i]?.hash ?? "more", (range, cx) => {
          // Scrolling to the end loads the next page, as Git Graph does; the row also takes a click.
          if (range.end > this.commits.length && this.hasMore && !this.loading && this.moreAsked !== this.limit) {
            this.moreAsked = this.limit;
            cx.spawn(async (cx) => this.loadMore(cx));
          }
          const out = [];
          for (let i = range.start; i < range.end; i++) {
            const c = this.commits[i];
            out.push(c ? commitRow(c, this.rows[i], t, { width, h, mono, labels: this.labels.get(c.hash), selected: this.selected === c.hash,
              match: Boolean(matches?.has(c.hash)), wide, cols: COLS })
              : h_flex().id("graph-more").h(h).flex_none().px(14).gap(6).items_center().text_size(SIZE.small).text_color(t.accent).hover((s) => s.bg(t.hover))
                .child(this.loading ? (this.moreShown = true, "Loading more commits…") : `Load ${PAGE} more commits`));
          }
          return out;
        }).track_scroll(this.scroll)
          // Rows of a virtual list can't hold their own handlers: the list reports the row's key.
          .on_item_click((key, cx) => this.clicked(key, cx))
          .on_item_secondary_click((key, e) => this.contextMenu(key, e))
          .size_full())
        .child(Scrollbar.vertical(this.listId).viewport_from_layout().absolute().inset_0()));
  }

  // Manygit's list: grouped by folder, each row its branch, uncommitted changes and upstream.
  workspaceList(t) {
    const repos = this.workspace.repos, grouped = repos.some((r) => r.group), out = [];
    repos.forEach((r, i) => {
      if (grouped && r.group !== repos[i - 1]?.group) out.push(section(t, `graph-group-${i}`, r.group ? `${r.group}/` : "./"));
      out.push(this.repoRow(r, i, grouped, t));
    });
    return v_flex().id("graph-repos").flex_1().min_h(0).py(4).overflow_y_scrollbar().children(out);
  }

  repoRow(r, i, indent, t) {
    const st = this.statuses.get(r.path), sync = syncOf(st), here = r.path === this.opened;
    const color = { loading: t.dim, error: t.ansi1, unpushed: t.ansi3, gone: t.ansi1, local: t.dim }[sync.kind] ?? t.dim;
    const branch = st && !st.error ? (st.detached ? "detached" : st.branch) : null;
    return row(t, `graph-repo-${i}`, { selected: here, depth: indent ? 1 : 0, onClick: (_e, cx) => this.openRepo(r.path, cx), onRight: (_e, cx) => this.repoMenu(r, cx) })
      .child(image(iconFor(r.name, true)).size(SIZE.icon + 1).flex_none())
      .child(div().min_w(0).truncate().text_color(here ? t.accent : t.foreground).child(r.name))
      .child(h_flex().flex_none().gap(5).items_center().text_size(SIZE.small)
        .when(st?.dirty > 0, (e) => e.child(h_flex().gap(4).items_center().text_color(t.blocked).child(div().size(6).rounded(3).bg(t.blocked)).child(String(st.dirty))))
        .when(sync.kind === "counts" && st.ahead > 0, (e) => e.child(div().text_color(t.ansi2).child(`↑${st.ahead}`)))
        .when(sync.kind === "counts" && st.behind > 0, (e) => e.child(div().text_color(t.ansi1).child(`↓${st.behind}`)))
        .when(Boolean(sync.text), (e) => e.child(div().text_color(color).child(sync.text))))
      .child(div().flex_1())
      .when(Boolean(branch), (e) => e.child(h_flex().flex_none().max_w(160).gap(4).items_center().text_color(t.muted)
        .child(svg(ui("git-branch")).size(12).flex_none()).child(div().min_w(0).truncate().text_size(SIZE.small).child(branch))))
      .when(Boolean(st?.error), (e) => e.child(div().flex_none().max_w(200).truncate().text_size(SIZE.small).text_color(t.ansi1).child(st.error)));
  }

  emptyState(t) {
    const s = this.state, where = tilde(this.cwd, this.on), refresh = textButton(t, "graph-retry", "Refresh", (_e, cx) => this.refresh(cx), { icon: "rotate-cw" });
    if (s === "nofolder") return empty(t, "No folder", "Focus a terminal to see the history of the repository it's in.");
    if (s === "norepo" && this.skipped) return empty(t, "Not a git repository", `${where ?? "This folder"} isn't a repository, and is too big to search for them.`, refresh);
    if (s === "norepo") return empty(t, "Not a git repository", `${where ?? "This folder"} isn't in a repository, and holds none ${count(depthOf(shared(DEPTH_KEY)), "level")} down.`,
      textButton(t, "graph-depth", "Search deeper", () => openSettings(), { icon: "settings" }));
    if (s === "empty") return empty(t, "No commits yet", "Make the first commit and it shows up here.", refresh);
    if (s === "error") return empty(t, "Can't read the history", this.error, refresh);
    return empty(t, "Loading history…");
  }

  // The details of the shown commit: an overview column and the diff side by side when there's
  // room, else one tab at a time (Overview, Diff, the opened file).
  detailPane(t, mono, width) {
    const c = this.shown, split = Boolean(this.p.wide) && width >= SPLIT_LAYOUT;
    const fileTab = this.file ? [{ id: "file", label: baseName(this.file.path) }] : [];
    const tabs = split ? [{ id: "diff", label: "Diff" }, ...fileTab] : [{ id: "overview", label: "Overview" }, { id: "diff", label: "Diff" }, ...fileTab];
    const tab = split && this.tab === "overview" ? "diff" : this.tab;
    const bar = subbar(t, "graph-detail-tabs").child(segmented(t, "graph-tab", tabs, tab, (id, cx) => this.setTab(id, cx)))
      .child(div().flex_1())
      .when(tab === "file" && Boolean(this.file?.rev), (e) => e.child(div().flex_none().font_family(mono).text_size(11).text_color(t.dim).child(`at ${String(this.file.rev).slice(0, 8)}`)))
      .when(tab === "file", (e) => e.child(iconButton(t, "graph-file-close", "close", (_e, cx) => { this.file = null; this.setTab(split ? "diff" : "overview", cx); }, { size: 22 })));
    const content = tab === "file" ? (this.previewView ?? empty(t, "No file"))
      : tab === "diff" ? (this.diffView ?? empty(t, "Loading diff…"))
      : overview(this, t, c, mono);
    const body = v_flex().size_full().min_w(0).min_h(0).child(bar).child(div().flex_1().min_h(0).min_w(0).flex().flex_col().child(content));
    if (!split) return body;
    return h_flex().size_full().min_w(0).min_h(0)
      .child(div().w(OVERVIEW_W).flex_none().h_full().min_h(0).border_r(1).border_color(t.border).bg(t.chrome).child(overview(this, t, c, mono)))
      .child(div().flex_1().min_w(0).h_full().child(body));
  }

  graphBody(t, mono) {
    return v_flex().size_full().min_h(0).min_w(0)
      .child(this.toolbar(t))
      .when(Boolean(this.find), (e) => e.child(this.findBar(t)))
      .child(this.list(t, mono));
  }

  render(cx) {
    if (this.part) return this.part.render(cx);
    if (!this.begun) { this.begun = true; cx.spawn(async (cx) => this.begin(cx)); }
    if (this.key() !== this.context) this.refresh(cx);
    if (this.missed) this.catchUp(cx);
    // After an action (here, a menu or a dialog) every copy reads again.
    const changed = shared(CHANGED);
    if (changed !== this.seenChange) { this.seenChange = changed; if (this.root || this.state === "workspace") this.refresh(cx); }
    const depth = depthOf(shared(DEPTH_KEY));
    if (depth !== this.seenDepth) { const first = this.seenDepth === undefined; this.seenDepth = depth; if (!first && !this.opened && !this.root) this.refresh(cx); }
    const t = theme(), mono = monoFont(settings()), wide = Boolean(this.p.wide), ready = this.state === "ready";
    let view;
    if (!wide && this.page === "commit" && this.shown) {
      const c = this.shown;
      view = frame(t, header(t, { id: "graph-header", back: (_e, cx) => { this.page = "graph"; this.tab = "overview"; this.handle.focus(); cx.notify(); }, backLabel: "Graph",
        icon: "git-commit", title: c.uncommitted ? "Uncommitted" : c.hash.slice(0, 8), subtitle: c.uncommitted ? null : c.subject,
        actions: [this.expandButton(t)] }), this.detailPane(t, mono, this.width ?? 400));
    } else {
      const body = this.state === "workspace" ? this.workspaceList(t)
        : !ready ? this.emptyState(t)
        : !wide ? this.graphBody(t, mono)
        : h_flex().size_full().min_h(0).min_w(0)
          .child(div().w(this.splitWidth()).flex_none().h_full().min_h(0).child(this.graphBody(t, mono)))
          .child(div().id("graph-split").w(5).mx(-2).h_full().flex_none().flex().justify_center().cursor_col_resize()
            .on_mouse_down("left", (e, cx) => this.startDrag(e, cx))
            .child(div().w(1).h_full().bg(this.drag ? t.accent : t.border)).hover((s) => s.bg(t.hover)))
          .child(div().flex_1().min_w(0).h_full().min_h(0)
            .child(this.shown ? this.detailPane(t, mono, this.detailWidth()) : empty(t, "No commit selected", "Pick a commit on the left.")));
      view = frame(t, this.masterHeader(t), body);
    }
    return view.id("graph-root").track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_move((e, cx) => this.moveDrag(e, cx))
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.endDrag(cx); })
      .on_size_change((size, cx) => {
        const width = Math.round(size.width / (settings().zoom ?? 1));
        if (width !== this.width) { this.width = width; this.syncDiff(cx); cx.notify(); }
      });
  }
}
