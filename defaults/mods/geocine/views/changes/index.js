// Changes: the uncommitted changes of the focused terminal's repo, in sections (Conflicts,
// Staged, Unstaged, Untracked), with stage / unstage / discard and a commit box. A file opens its
// Diff: on its own page in the side panel ("← Changes"), beside the list in full mode, where the
// list's first row shows every change at once. "Open file" in a diff shows the shared Preview.
// Herdr's own Changes panel (defaults/mods/changes) is where this started.
//
// Speed: the list is a virtual list (only the rows on screen are drawn, however many changes);
// a refresh is three git processes side by side; a folder watch ignores what git ignores
// (target/, node_modules/) and git's own object writes; a copy that isn't shown only notes that
// it is out of date and refreshes when it shows again; an open diff reloads only when its file
// changed.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Popup, h_resizable, resizable_panel, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { theme, settings, watchFolder, layout } from "herdr";
import { SIZE, ui, frame, header, subbar, iconButton, textButton, counts, badge, empty } from "../../lib/ui.js";
import { repoOf, statusColor, statusLetter } from "../../lib/git.js";
import { location, locationKey, baseName, dirName } from "../../lib/where.js";
import { iconFor } from "../../lib/icons.js";
import { openFull, closeFull, inFull } from "../../lib/nav.js";
import Diff from "../../lib/diff/index.js";
import Preview from "../../lib/preview/index.js";
import { SECTIONS, loadStatus, countLines, ignoredPaths, forgetLines, watchedPath, mergeSorted, stage, unstage, unstageAll, discard, commit } from "./status.js";

const SPLIT = { min: 220, max: 720, default: 320 };
const MENU_W = 236, ITEM_H = 28;
const GAP = 4;                       // space above a section header and the "All changes" row
const BADGE = 14, BUTTON = 20;       // a row's status letter and its small buttons (ui.js badge, iconButton size 20)
const SETTLE = 250;                  // a burst of file writes is one refresh
const zoom = () => Number(settings()?.zoom) || 1;
const stop = (_e, cx) => cx.stop_propagation();
const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? c + a : c);
const pref = (key, fallback) => { try { const v = localStorage.getItem(`changes.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } };
const setPref = (key, value) => { try { localStorage.setItem(`changes.${key}`, JSON.stringify(value)); } catch {} };
const message = (e) => String(e?.message ?? e).replace(/^error: /, "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const label = (id) => SECTIONS.find(s => s.id === id)?.label ?? id;
// What the list shows, as VS Code's Source Control: merge conflicts, then what is staged, then
// every other change (edited and untracked files together, by path). Git's own sections stay
// on each entry (e.section), so stage, unstage and discard know what they act on.
const GROUPS = [
  { id: "conflicts", label: "Merge Changes", from: ["conflicts"] },
  { id: "staged", label: "Staged Changes", from: ["staged"] },
  { id: "changes", label: "Changes", from: ["unstaged", "untracked"] },
];
// Writes under .git that never change what `git status` says.
const GIT_NOISE = /^\.git\/(objects|logs|hooks|lfs|fsmonitor--daemon|worktrees)(\/|$)|^\.git\/(fetch_head|orig_head|commit_editmsg|gc\.log|description)$|\.lock$/;

// Whether a Changes block is drawn in the shown layout: no hidden node above it, and the shown
// child of every stack on the way. null when the layout has none (full mode, a pane).
function shownIn(root) {
  let found = null;
  const walk = (n, shown) => {
    if (!n || typeof n !== "object") return;
    shown = shown && !n.hidden;
    if (n.content?.props?.view === "changes") found = found === true || shown;
    const kids = Array.isArray(n.children) ? n.children : [];
    const active = n.type === "stack" ? (n.active ?? kids[0]?.id) : null;
    for (const k of kids) walk(k, shown && (active === null || k?.id === active));
    for (const f of Array.isArray(n.floating) ? n.floating : []) walk(f, shown);
  };
  walk(root, true);
  return found;
}

export default class ChangesView extends View {
  init(p, cx) {
    // Run as an inline view, init can be called twice on one instance (the host, then
    // lib/inline.js): a second set of timers and watches would double every refresh.
    if (this.inited) return;
    this.inited = true;
    this.p = p ?? {};
    this.handle = cx.focus_handle();
    this.repo = null; this.on = null; this.ctx = null; this.cwd = null;
    this.data = null; this.error = null; this.loading = false; this.again = false;
    this.sel = null;            // "all" | { section, path }
    this.page = "list";         // side panel: "list" | "diff" | "preview"
    this.previewAt = null;      // { path, rev }
    this.diff = null; this.preview = null; this.diffKey = null; this.previewKey = null;
    this.folded = new Set(pref("folded", []));
    this.split = Math.max(SPLIT.min, Math.min(SPLIT.max, Number(pref("split", SPLIT.default)) || SPLIT.default));
    this.menu = null; this.menuFor = null; this.confirm = null;
    this.message = ""; this.typing = false; this.busy = null; this.note = null;
    this.want = this.p.start?.path ? { path: this.p.start.path, section: this.p.start.section ?? null } : null;
    // What makes an open diff reload: epoch (everything: a refresh click, our own git writes),
    // a version per path (that file changed), allStamp (anything changed, for "All changes").
    this.epoch = 0; this.versions = new Map(); this.counter = 0; this.allStamp = 0; this.sigs = null;
    this.touched = new Set(); this.touchAll = false;
    this.ignore = null; this.ignoreAt = 0;
    this.started = false; this.stale = false;
    this.dataVersion = 0; this.model = null;
    this.scroll = VirtualListScrollHandle.new();
    this.listW = 300; this.pressX = 0;
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    // The Diff calls back with its own cx: a poke wakes this loop, which redraws this view.
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise(r => { this.wake = r; });
        this.syncDetail(cx); cx.notify();
      }
    });
    // A remote repo (no watch) is polled; a local one rests on its watch, with a slow check
    // behind it. A copy that isn't shown only notes that it is out of date.
    cx.timer.every(4000, (cx) => { if (this.on || !this.watched || this.stale) this.tick(cx); });
    cx.timer.every(30000, (cx) => this.tick(cx));
  }

  update(p) { this.p = p ?? {}; }
  poke() { const w = this.wake; this.wake = null; w?.(); }
  // The copy goes (full mode closed): its timers and watch stop working.
  close() { this.closed = true; this.watched = null; }

  get wide() { return Boolean(this.p.wide); }
  get full() { return Boolean(this.p.full) || inFull(); }

  // ---- data ----------------------------------------------------------------

  // Whether this copy is on screen. A spare copy (one never drawn) and a hidden stack child do
  // no git work.
  isShown() {
    if (this.p.hidden) return false;
    if (this.full) return true;
    try { return shownIn(layout()) ?? true; } catch { return true; }
  }

  tick(cx) {
    if (!this.started || this.closed) return;
    if (!this.isShown()) { this.stale = true; return; }
    this.stale = false;
    this.refresh(cx);
  }

  refresh(cx, { changed = false } = {}) {
    if (this.loading) { this.again = true; this.againChanged ||= changed; return; }
    const loc = location();
    if (!loc.cwd) return;   // focus somewhere without a folder (our own panel): keep the last place
    const ctx = locationKey(loc);
    if (ctx !== this.ctx) {
      this.ctx = ctx; this.cwd = loc.cwd; this.repo = null; this.data = null; this.error = null; this.sel = null; this.page = "list";
      this.previewAt = null; this.note = null; this.watched = null; this.menu = null; this.confirm = null;
      this.sigs = null; this.versions.clear(); this.touched = new Set(); this.touchAll = false; this.ignore = null; this.recheck = false;
      this.dataVersion++;
    }
    this.loading = true;
    const touched = this.touched, touchAll = this.touchAll || changed;
    this.touched = new Set(); this.touchAll = false;
    cx.spawn(async (cx) => {
      let counting = null;
      try {
        // The repo's top is looked up once per place; later refreshes are the status alone
        // (which also brings the branch and the commit).
        let repo = this.recheck ? null : this.repo, data;
        if (repo) data = await loadStatus(repo.top, loc.on, repo.top);
        else if (this.error === "not-repo") {
          // Still outside a repo, most likely: one quick look before reading any status.
          repo = await repoOf(loc.cwd, { on: loc.on });
          if (ctx !== this.ctx || !repo) return;
          data = await loadStatus(repo.top, loc.on, repo.top);
        } else {
          const [found, read] = await Promise.all([repoOf(loc.cwd, { on: loc.on }), loadStatus(loc.cwd, loc.on).catch(e => ({ failed: e }))]);
          if (ctx !== this.ctx) return;
          if (!found) { this.repo = null; this.data = null; this.error = "not-repo"; this.recheck = false; this.dataVersion++; return; }
          if ("failed" in read) throw read.failed;
          repo = found; data = read;
        }
        if (ctx !== this.ctx) return;
        repo = { ...repo, branch: data.branch, head: data.sha };
        this.noteChanges(data, repo, touched, touchAll, cx);
        this.repo = repo; this.on = loc.on; this.data = data; this.error = null; this.recheck = false; this.dataVersion++;
        this.fixSelection();
        this.syncDetail(cx);
        this.watch(repo.top, cx);
        if (data.uncounted.length) counting = { data, top: repo.top, on: loc.on };
      } catch (e) {
        // The repo stays (its list and actions with it); the next refresh looks it up again.
        if (ctx === this.ctx) { this.error = message(e); this.recheck = true; }
      } finally {
        this.loading = false;
        if (this.again) { const c = this.againChanged; this.again = false; this.againChanged = false; this.refresh(cx, { changed: c }); }
        cx.notify();
      }
      // Untracked files' line counts fill in after the list is up.
      if (counting) {
        await countLines(counting.data.uncounted, counting.top, counting.on);
        if (this.data === counting.data) { this.dataVersion++; cx.notify(); }
      }
    });
  }

  // Works out which files changed since the last refresh, for the open diff to reload only then.
  noteChanges(data, repo, touched, touchAll, cx) {
    const sigs = new Map();
    for (const list of Object.values(data.sections)) {
      for (const e of list) {
        const k = e.path.toLowerCase();
        // An untracked file's count fills in later; its writes reach `touched` instead.
        const s = e.section === "untracked" ? "u" : `${e.section}:${e.status}:${e.adds}:${e.dels}:${e.binary}:${e.oldPath ?? ""}`;
        sigs.set(k, sigs.has(k) ? `${sigs.get(k)}|${s}` : s);
      }
    }
    const old = this.sigs ?? new Map();
    // "All changes" is the worktree against HEAD: staging and unstaging leave it as it is. It
    // reloads when files were written, a path came or went, or HEAD moved.
    let all = !this.sigs || touched.size > 0, stray = false;
    const bump = (k) => this.versions.set(k, ++this.counter);
    for (const [k, s] of sigs) {
      if (old.get(k) !== s || touched.has(k)) bump(k);
      if (!old.has(k)) all = true;
    }
    for (const k of old.keys()) if (!sigs.has(k)) { bump(k); all = true; }
    for (const k of touched) if (!sigs.has(k) && !old.has(k)) stray = true;
    if (touchAll || (this.repo && (this.repo.head !== repo.head || this.repo.branch !== repo.branch))) { this.epoch++; all = true; }
    if (all) this.allStamp++;
    this.sigs = sigs;
    // Writes that changed nothing git shows may be a folder git ignores that is new since the
    // ignore list was read (a first `npm install`): read it again, at most every 5 s.
    if (stray && Date.now() - this.ignoreAt > 5000) this.loadIgnored(repo.top, cx);
  }

  loadIgnored(top, cx) {
    if (this.on) return;
    this.ignoreAt = Date.now();
    cx.spawn(async () => {
      try { const ig = await ignoredPaths(top, null); if (this.watched === top) this.ignore = { top, ...ig }; } catch {}
    });
  }

  // A path under the repo (lower case, "/"-separated) that git ignores.
  ignored(rel) {
    const ig = this.ignore;
    if (!ig || ig.top !== this.watched) return false;
    if (ig.files.has(rel) || ig.dirs.has(`${rel}/`)) return true;
    for (let i = rel.indexOf("/"); i >= 0; i = rel.indexOf("/", i + 1)) if (ig.dirs.has(rel.slice(0, i + 1))) return true;
    return false;
  }

  // Sorts a watch's paths: what git ignores and git's own bookkeeping are dropped; the rest
  // are noted (for the diffs to reload). → whether anything is left to refresh for.
  relevant(paths, top, cx) {
    const base = `${watchedPath(top)}/`;
    let any = false, rules = false;
    for (const raw of paths ?? []) {
      const p = watchedPath(raw);
      if (!p.startsWith(base)) { if (base.startsWith(`${p}/`)) { this.touchAll = true; any = true; } continue; }
      const rel = p.slice(base.length);
      if (!rel) { this.touchAll = true; any = true; continue; }
      if (rel === ".git" || rel.startsWith(".git/")) {
        if (GIT_NOISE.test(rel)) continue;
        if (rel === ".git/info/exclude") rules = true;
        any = true; continue;
      }
      if (this.ignored(rel)) continue;
      if (rel === ".gitignore" || rel.endsWith("/.gitignore")) rules = true;
      this.touched.add(rel); any = true;
    }
    if (rules) this.loadIgnored(top, cx);
    return any;
  }

  watch(top, cx) {
    if (this.on || this.watched === top) return;
    this.watched = top;
    this.loadIgnored(top, cx);
    // One loop per folder: back at a repo left a moment ago, its loop (still waiting for an
    // event) carries on rather than a second one starting beside it.
    this.looping ??= new Set();
    if (this.looping.has(top)) return;
    this.looping.add(top);
    cx.spawn(async (cx) => {
      try {
        while (this.watched === top) {
          const paths = await watchFolder(top);
          if (this.watched !== top) break;
          forgetLines(paths);
          if (!this.relevant(paths, top, cx)) continue;
          // A burst of writes (a build, a checkout) is one refresh.
          if (this.settling) continue;
          this.settling = true;
          cx.timer.after(SETTLE, (cx) => { this.settling = false; this.tick(cx); });
        }
      } catch { if (this.watched === top) this.watched = null; }
      finally { this.looping.delete(top); }
    });
  }

  entries(sectionId) { return this.data?.sections[sectionId] ?? []; }
  allEntries() { return SECTIONS.flatMap(s => this.entries(s.id)); }
  find(sel) { return sel && sel !== "all" ? this.entries(sel.section).find(e => e.path === sel.path) ?? null : null; }
  count() { return this.listModel().count; }

  // The list as rows, worked out once per refresh or fold (not per frame): items for the virtual
  // list, their sizes, and the selectable rows in order.
  listModel() {
    const key = `${this.dataVersion}|${this.wide}|${[...this.folded].join(",")}`;
    if (this.model?.key === key) return this.model;
    const items = [], rows = [], groups = [];
    let count = 0, adds = 0, dels = 0;
    for (const s of SECTIONS) for (const e of this.entries(s.id)) { count++; adds += e.adds; dels += e.dels; }
    if (this.wide && count) { items.push({ key: "all", kind: "all", size: SIZE.row + GAP }); rows.push("all"); }
    for (const g of GROUPS) {
      const list = g.from.length === 1 ? this.entries(g.from[0]) : mergeSorted(this.entries(g.from[0]), this.entries(g.from[1]));
      if (!list.length) continue;
      groups.push({ g, list });
      items.push({ key: `s:${g.id}`, kind: "section", g, list, size: SIZE.row + GAP });
      if (this.folded.has(g.id)) continue;
      for (const e of list) { items.push({ key: `e:${e.section}:${e.path}`, kind: "entry", e, size: SIZE.row }); rows.push({ section: e.section, path: e.path }); }
    }
    if (this.data?.cut) items.push({ key: "cut", kind: "cut", size: SIZE.row });
    items.push({ key: "end", kind: "end", size: 8 });
    this.model = { key, items, sizes: items.map(i => i.size), byKey: new Map(items.map(i => [i.key, i])), rows, groups, count, adds, dels };
    return this.model;
  }

  // After a refresh: a selected file that moved (staged, unstaged) is followed to its new section.
  fixSelection() {
    if (this.want) {
      const want = this.want, all = this.allEntries();
      const e = all.find(x => x.path === want.path && x.section === want.section) ?? all.find(x => x.path === want.path);
      this.want = null;
      if (e) { this.sel = { section: e.section, path: e.path }; if (!this.wide) this.page = "diff"; }
    }
    if (this.sel && this.sel !== "all" && !this.find(this.sel)) {
      const e = this.allEntries().find(x => x.path === this.sel.path);
      if (e) this.sel = { section: e.section, path: e.path };
      else { this.sel = this.wide ? "all" : null; if (this.page !== "list" && !this.previewAt) this.page = "list"; }
    }
    if (this.wide && !this.sel) this.sel = "all";
  }

  diffProps() {
    if (!this.repo || !this.sel) return null;
    const base = { on: this.on, top: this.repo.top, onOpenFile: (path, rev) => this.openFile(path, rev) };
    if (this.sel === "all") return { ...base, stamp: `${this.epoch}:${this.allStamp}`, source: { kind: "head" } };
    const kind = this.sel.section === "conflicts" ? "unstaged" : this.sel.section;
    return { ...base, stamp: `${this.epoch}:${this.versions.get(this.sel.path.toLowerCase()) ?? 0}`, source: { kind }, paths: [this.sel.path] };
  }

  previewProps() {
    if (!this.repo || !this.previewAt) return null;
    return { on: this.on, root: this.repo.top, path: this.previewAt.path, rev: this.previewAt.rev, repoTop: this.repo.top, wide: this.wide,
      // While the preview edits, typed keys and clicks are the editor's.
      onEditing: (on) => { this.editing = on; } };
  }

  // Mounts or updates the Diff and the Preview: from handlers and tasks only, never render.
  syncDetail(cx) {
    const dp = this.diffProps();
    if (dp) {
      const key = JSON.stringify(dp);
      if (key !== this.diffKey) { this.diffKey = key; if (this.diff) this.diff.set_props(dp); else this.diff = cx.new(Diff, dp); }
    }
    const pp = this.previewProps();
    if (pp) {
      const key = JSON.stringify(pp);
      if (key !== this.previewKey) { this.previewKey = key; if (this.preview) this.preview.set_props(pp); else this.preview = cx.new(Preview, pp); }
    }
  }

  // ---- navigation ----------------------------------------------------------

  select(sel, cx, { open = true } = {}) {
    this.sel = sel; this.previewAt = null; this.menu = null;
    if (!this.wide && open) this.page = "diff";
    this.syncDetail(cx);
    cx.notify();
  }

  openFile(path, rev) {
    this.previewAt = { path, rev: rev ?? null };
    if (!this.wide) this.page = "preview";
    this.poke();
  }

  back(cx) {
    if (this.previewAt) { this.previewAt = null; if (!this.wide) this.page = this.sel ? "diff" : "list"; }
    else if (!this.wide && this.page !== "list") this.page = "list";
    else return false;
    this.handle.focus();
    cx.notify();
    return true;
  }

  // The rows the keyboard moves through, in order.
  flat() { return this.listModel().rows; }
  same(a, b) { return a === b || (a && b && a !== "all" && b !== "all" && a.section === b.section && a.path === b.path); }

  move(delta, cx) {
    const rows = this.flat();
    if (!rows.length) return;
    const at = rows.findIndex(r => this.same(r, this.sel));
    const next = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? (delta > 0 ? 0 : rows.length - 1) : at + delta))];
    this.select(next, cx, { open: false });
    const key = next === "all" ? "all" : `e:${next.section}:${next.path}`, index = this.listModel().items.findIndex(i => i.key === key);
    if (index >= 0) this.scroll.scroll_to_item(index);
  }

  key(e, cx) {
    if (this.editing) return;
    const k = e.key;
    if (this.confirm) {
      if (k === "escape") { this.confirm = null; cx.stop_propagation(); cx.notify(); }
      else if (k === "enter") { const c = this.confirm; this.confirm = null; c.run(cx); cx.stop_propagation(); }
      return;
    }
    if (this.menu && k === "escape") { this.menu = null; cx.stop_propagation(); cx.notify(); return; }
    if (this.typing) {
      if (k === "escape") { this.handle.focus(); this.typing = false; cx.stop_propagation(); cx.notify(); }
      return;
    }
    if (k === "escape" || k === "backspace") { if (this.back(cx)) cx.stop_propagation(); return; }
    const onList = this.wide || this.page === "list";
    if (!onList) return;
    if (k === "down") { this.move(1, cx); cx.stop_propagation(); }
    else if (k === "up") { this.move(-1, cx); cx.stop_propagation(); }
    else if (k === "enter" && this.sel) { this.select(this.sel, cx); cx.stop_propagation(); }
    else if (k === "space" && this.sel && this.sel !== "all") { const x = this.find(this.sel); if (x) this.toggleStage(x, cx); cx.stop_propagation(); }
  }

  // ---- actions -------------------------------------------------------------

  act(name, work, cx) {
    if (this.busy || !this.repo) return;
    const top = this.repo.top, on = this.on, head = this.data?.head ?? true, ctx = this.ctx;
    this.busy = name; this.note = null; this.menu = null;
    cx.spawn(async (cx) => {
      try { await work(top, on, head); }
      catch (e) { if (ctx === this.ctx) this.note = { error: true, text: message(e) }; }
      // Here the folder watch reports the files the action wrote (the diffs reload for those);
      // another machine has no watch, so everything there reloads.
      finally { this.busy = null; this.refresh(cx, { changed: Boolean(on) }); cx.notify(); }
    });
    cx.notify();
  }

  toggleStage(e, cx) {
    if (e.section === "staged") this.act("unstage", (top, on, head) => unstage([e], top, on, head), cx);
    else this.act("stage", (top, on) => stage([e], top, on), cx);
  }

  askDiscard(list, cx, what) {
    if (!list.length) return;
    const untracked = list.every(e => e.section === "untracked"), staged = list.some(e => e.section === "staged");
    const one = list.length === 1 ? baseName(list[0].path) : null;
    this.confirm = {
      title: untracked ? (one ? `Delete ${one}?` : `Delete ${plural(list.length, "untracked file")}?`) : (one ? `Discard changes to ${one}?` : `Discard ${what ?? plural(list.length, "change")}?`),
      detail: untracked ? "The file is not in git: it is gone for good." : staged ? "Staged and unstaged changes go back to the last commit. This can't be undone."
        : list.some(e => e.section === "untracked") ? "Your edits go back to what is staged or committed, and untracked files are deleted for good. This can't be undone."
        : "Your edits go back to what is staged or committed. This can't be undone.",
      label: untracked ? "Delete" : "Discard",
      run: (cx) => this.act("discard", (top, on, head) => discard(list, top, on, head), cx),
    };
    cx.notify();
  }

  commit(cx) {
    const msg = this.message.trim(), staged = this.entries("staged").length, all = staged === 0;
    if (!msg || !this.repo || this.busy || !this.count() || this.entries("conflicts").length) return;
    const ctx = this.ctx;
    this.act("commit", async (top, on) => {
      await commit(msg, top, on, { all });
      if (ctx === this.ctx) { this.message = ""; this.input.set_value(""); this.note = { text: all ? "Committed every change" : `Committed ${plural(staged, "file")}` }; }
    }, cx);
  }

  menuItems(e) {
    return [
      [["diff", "Show changes"], ["open", "Open file"]],
      [e.section === "staged" ? ["unstage", "Unstage"] : ["stage", e.section === "conflicts" ? "Mark resolved (stage)" : "Stage"],
        e.section !== "conflicts" && ["discard", e.section === "untracked" ? "Delete file…" : "Discard changes…"]].filter(Boolean),
      [["copy", "Copy path"], ["copyabs", "Copy full path"]],
    ];
  }

  openEntry(e, cx) {
    this.sel = { section: e.section, path: e.path };
    this.openFile(e.path, e.section === "staged" && e.status === "D" ? "HEAD" : null);
    this.syncDetail(cx);
  }

  runMenu(id, e, cx) {
    this.menu = null;
    const sel = { section: e.section, path: e.path };
    if (id === "diff") this.select(sel, cx);
    else if (id === "open") this.openEntry(e, cx);
    else if (id === "stage" || id === "unstage") this.toggleStage(e, cx);
    else if (id === "discard") this.askDiscard([e], cx);
    else if (id === "copy") cx.write_to_clipboard(e.path);
    else if (id === "copyabs") cx.write_to_clipboard(`${this.repo.top}/${e.path}`);
    cx.notify();
  }

  // ---- the list's clicks ---------------------------------------------------
  // Rows of a virtual list take no handlers of their own: the list reports which row was
  // clicked, and where the press was (from the right edge) picks a row's button, as the
  // rows lay them out (rowActions, sectionActions).

  itemClick(key, cx) {
    const item = this.listModel().byKey.get(key);
    if (!item) return;
    this.typing = false; this.handle.focus();
    const fromEnd = this.listW - this.pressX;
    if (item.kind === "all") return this.select("all", cx);
    if (item.kind === "section") return this.sectionClick(item, fromEnd, cx);
    if (item.kind !== "entry") return;
    const e = item.e;
    const hit = this.busy ? null : rowButtonAt(fromEnd, e.section !== "conflicts");
    if (hit === "stage") return this.toggleStage(e, cx);
    if (hit === "discard") return this.askDiscard([e], cx);
    if (hit === "open") { this.openEntry(e, cx); cx.notify(); return; }
    this.select({ section: e.section, path: e.path }, cx);
  }

  sectionClick(item, fromEnd, cx) {
    const { g, list } = item;
    const at = fromEnd >= SIZE.pad - 1 && fromEnd < SIZE.pad + BUTTON + 1 ? 0 : fromEnd >= SIZE.pad + BUTTON + 3 && fromEnd < SIZE.pad + 2 * BUTTON + 5 ? 1 : -1;
    const actions = this.sectionActions(g, list);
    const action = at >= 0 && !this.busy ? actions[actions.length - 1 - at] : null;
    if (action) return action.run(cx);
    const open = !this.folded.has(g.id);
    open ? this.folded.add(g.id) : this.folded.delete(g.id);
    setPref("folded", [...this.folded]);
    cx.notify();
  }

  // A section's buttons, left to right: { icon, run }.
  sectionActions(g, list) {
    if (g.id === "staged") return [{ icon: "minus", run: (cx) => this.act("unstage", (top, on, head) => unstageAll(top, on, head), cx) }];
    if (g.id === "changes") return [
      { icon: "undo-2", run: (cx) => this.askDiscard(list, cx, `all ${plural(list.length, "change")}`) },
      { icon: "plus", run: (cx) => this.act("stage", (top, on) => stage(list, top, on), cx) },
    ];
    return [{ icon: "plus", run: (cx) => this.act("stage", (top, on) => stage(list, top, on), cx) }];
  }

  // ---- drawing -------------------------------------------------------------

  // A small button inside a list row: drawn only (the list takes the click).
  rowButton(t, icon, disabled = false) {
    return div().size(BUTTON).flex_none().flex().items_center().justify_center().rounded(SIZE.radius).text_color(disabled ? t.dim : t.muted)
      .when(!disabled, el => el.hover(s => s.bg(t.hover).text_color(t.foreground)))
      .child(svg(ui(icon)).size(SIZE.icon));
  }

  rowActions(t, e) {
    return h_flex().flex_none().gap(1)
      .child(this.rowButton(t, "file-text"))
      .when(e.section !== "conflicts", el => el.child(this.rowButton(t, "undo-2")))
      .child(this.rowButton(t, e.section === "staged" ? "minus" : "plus"));
  }

  entryRow(t, e) {
    const selected = this.same(this.sel, { section: e.section, path: e.path }) && (this.wide || this.page === "list");
    const name = baseName(e.path), dir = dirName(e.path), buttons = selected && !this.busy;
    return h_flex().h(SIZE.row).flex_none().w_full().pl(SIZE.pad).pr(SIZE.pad).gap(6).items_center().text_size(SIZE.text).relative()
      .when(selected, el => el.bg(t.selected)).text_color(t.foreground).cursor_pointer().hover(s => s.bg(selected ? t.selected : t.hover))
      .child(image(iconFor(e.path)).size(SIZE.icon).flex_none())
      .child(h_flex().flex_1().min_w(0).gap(6).items_center().overflow_hidden()
        .child(div().min_w(0).flex_shrink_1().truncate().text_color(e.status === "D" ? t.muted : t.foreground).when(e.status === "D", el => el.line_through()).child(name))
        .when(Boolean(dir), el => el.child(div().min_w(0).flex_shrink(100).truncate().text_size(SIZE.small).text_color(t.dim).child(dir))))
      .when(buttons, el => el.child(this.rowActions(t, e)))
      .when(!buttons, el => el.child(e.binary ? div().flex_none().text_size(SIZE.small).text_color(t.dim).child("bin") : counts(t, e.adds, e.dels)))
      .child(badge(t, statusLetter(e.status), statusColor(t, e.status)).text_center())
      // Hovered, the buttons cover the counts (a style, so no redraw per row the pointer crosses).
      .when(!selected && !this.busy, el => el.child(h_flex().absolute().top(0).left(0).size_full().pr(SIZE.pad + BADGE + 6).items_center().justify_end()
        .opacity(0).hover(s => s.opacity(1))
        .child(div().h_full().flex_none().bg(t.background).child(h_flex().h_full().pl(4).items_center().bg(t.hover).child(this.rowActions(t, e))))));
  }

  sectionRow(t, item) {
    const { g, list } = item, open = !this.folded.has(g.id);
    return div().w_full().h(SIZE.row + GAP).pt(GAP).child(h_flex().h(SIZE.row).flex_none().w_full().px(SIZE.pad).gap(4).items_center()
      .text_size(SIZE.small).font_semibold().text_color(g.id === "conflicts" ? t.ansi1 : t.muted).cursor_pointer().hover(s => s.text_color(t.foreground))
      .child(svg(ui(open ? "chevron-down" : "chevron-right")).size(12))
      .child(g.label.toUpperCase())
      .child(div().px(5).rounded(8).bg(t.surface).text_color(t.dim).child(String(list.length)))
      .child(div().flex_1())
      .child(h_flex().flex_none().gap(4).children(this.sectionActions(g, list).map(a => this.rowButton(t, a.icon, Boolean(this.busy))))));
  }

  allRow(t) {
    const m = this.listModel();
    return div().w_full().h(SIZE.row + GAP).pt(GAP).child(h_flex().h(SIZE.row).flex_none().w_full().pl(SIZE.pad).pr(SIZE.pad).gap(6).items_center().text_size(SIZE.text)
      .when(this.sel === "all", el => el.bg(t.selected)).text_color(t.foreground).cursor_pointer().hover(s => s.bg(this.sel === "all" ? t.selected : t.hover))
      .child(svg(ui("changes")).size(SIZE.icon).flex_none().text_color(t.accent))
      .child(div().flex_1().min_w(0).truncate().font_medium().child("All changes"))
      .child(counts(t, m.adds, m.dels))
      .child(div().w(BADGE).flex_none()));
  }

  itemView(t, item) {
    switch (item.kind) {
      case "entry": return this.entryRow(t, item.e);
      case "section": return this.sectionRow(t, item);
      case "all": return this.allRow(t);
      case "cut": return div().w_full().h(item.size).px(SIZE.pad).flex().items_center().text_size(SIZE.small).text_color(t.dim).child(`Showing the first ${this.data?.total ?? 0} changes`);
      default: return div().w_full().h(item.size);
    }
  }

  commitBox(t) {
    const staged = this.entries("staged").length, all = staged === 0, conflicts = this.entries("conflicts").length;
    const can = Boolean(this.message.trim()) && !this.busy && this.count() > 0 && !conflicts;
    const n = this.note;
    return v_flex().w_full().flex_none().px(SIZE.pad).py(8).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().w_full().gap(6).items_center()
        .child(div().id("changes-message").flex_1().min_w(0).h(SIZE.button + 4).px(8).flex().items_center().rounded(SIZE.radius)
          .bg(t.surface).border_1().border_color(this.typing ? t.accent : t.input ?? t.border).cursor_text()
          // Keys typed here are the field's: none reach the list's shortcuts (Enter, Space, arrows).
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); if (!this.typing) { this.typing = true; cx.notify(); } })
          .on_key_down((e, cx) => {
            cx.stop_propagation();
            if (e.key === "escape") { this.typing = false; this.handle.focus(); cx.notify(); }
          })
          .child(Input.new(this.input).flex_1().h_full().text_size(SIZE.text).text_color(t.foreground)))
        .child(textButton(t, "changes-commit", this.busy === "commit" ? "Committing…" : all ? "Commit all" : "Commit", (_e, cx) => this.commit(cx),
          { icon: "check", primary: can, disabled: !can }).h(SIZE.button + 4)
          .tooltip(conflicts ? "Resolve the conflicts first" : all ? "Stages every change, then commits" : `Commits ${plural(staged, "staged file")}`)))
      .when(Boolean(n), el => el.child(h_flex().gap(6).items_start().text_size(SIZE.small).text_color(n.error ? t.ansi1 : t.muted)
        .child(div().flex_1().min_w(0).child(n.text))
        .child(iconButton(t, "changes-note-close", "close", (_e, cx) => { this.note = null; cx.notify(); }, { size: 18 }))));
  }

  list(t) {
    if (this.error === "not-repo") return empty(t, "Not a git repository", this.cwd, textButton(t, "changes-retry", "Refresh", (_e, cx) => this.refresh(cx), { icon: "rotate-cw" }));
    if (!this.data) {
      if (this.error) return empty(t, "Can't read the changes", this.error, textButton(t, "changes-retry", "Retry", (_e, cx) => this.refresh(cx), { icon: "rotate-cw" }));
      return empty(t, this.ctx ? "Reading changes…" : "No folder", this.ctx ? null : "Focus a terminal to see its repo's changes");
    }
    const m = this.listModel();
    if (!m.count) {
      return v_flex().size_full()
        .child(empty(t, "No changes", this.note && !this.note.error ? `${this.note.text} · working tree clean` : `Working tree clean${this.repo?.branch ? ` on ${this.repo.branch}` : ""}`));
    }
    const items = m.items;
    return v_flex().id("changes-list-wrap").flex_1().min_h(0).w_full().relative()
      .on_mouse_down("right", (e, cx) => {
        if (!this.menuFor) return;
        const at = e.local_position ?? { x: 20, y: 20 };
        this.menu = { e: this.menuFor, x: at.x / zoom(), y: at.y / zoom() };
        this.menuFor = null; cx.notify();
      })
      .child(this.commitBox(t))
      .child(div().id("changes-list").flex_1().min_h(0).w_full().relative()
        .on_size_change((size) => { this.listW = size.width / zoom(); })
        .on_mouse_down("left", (e) => { this.pressX = (e.local_position?.x ?? 0) / zoom(); })
        .child(v_virtual_list("changes-rows", items.length, m.sizes, (i) => items[i]?.key ?? `x${i}`, (range) => {
          const out = [];
          for (let i = range.start; i < range.end; i++) out.push(this.itemView(t, items[i]));
          return out;
        }).track_scroll(this.scroll).size_full()
          .on_item_click((key, cx) => this.itemClick(key, cx))
          .on_item_secondary_click((key) => { const item = this.listModel().byKey.get(key); this.menuFor = item?.kind === "entry" ? item.e : null; }))
        .child(Scrollbar.vertical("changes-rows").absolute().inset_0()))
      .when(Boolean(this.menu), el => el.child(this.menuView(t)));
  }

  menuView(t) {
    const m = this.menu;
    const item = ([id, text]) => h_flex().id(`changes-menu-${id}`).h(ITEM_H).px(10).flex_none().items_center().rounded(SIZE.radius).cursor_pointer().text_size(SIZE.text)
      .text_color(id === "discard" ? t.ansi1 : t.foreground).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); this.runMenu(id, m.e, cx); })
      .child(text);
    const surface = v_flex().id("changes-menu").w(MENU_W).p(4).mt(2).rounded(SIZE.card).border_1().border_color(t.border).bg(t.popover ?? t.surface).shadow_lg()
      .on_mouse_down_out((_e, cx) => { if (this.menu === m) { this.menu = null; cx.notify(); } })
      .child(h_flex().h(ITEM_H - 4).px(10).gap(6).items_center().text_size(SIZE.small).text_color(t.dim)
        .child(image(iconFor(m.e.path)).size(SIZE.icon - 2).flex_none())
        .child(div().min_w(0).truncate().child(m.e.path)))
      .children(this.menuItems(m.e).flatMap((g) => [div().h(1).mx(6).my(4).bg(t.border), ...g.map(item)]));
    return Popup.new("changes-menu-pin", div()).absolute().top(m.y).left(m.x).size(1).anchor("top_left").content(surface);
  }

  confirmView(t) {
    const c = this.confirm;
    return div().id("changes-confirm").absolute().inset_0().flex().items_center().justify_center().p(16).bg(alpha(t.canvas ?? t.background, "b3"))
      .on_mouse_down("left", stop).on_scroll_wheel(stop)
      .child(v_flex().id("changes-confirm-card").w_full().max_w(340).p(14).gap(8).rounded(SIZE.card).bg(t.popover ?? t.surface).border_1().border_color(t.border).shadow_lg()
        .child(h_flex().gap(8).items_center()
          .child(svg(ui(c.label === "Delete" ? "trash" : "undo-2")).size(SIZE.icon + 2).flex_none().text_color(t.ansi1))
          .child(div().min_w(0).text_size(SIZE.text + 0.5).font_semibold().child(c.title)))
        .child(div().text_size(SIZE.small).text_color(t.muted).child(c.detail))
        .child(h_flex().pt(4).gap(6).justify_end()
          .child(textButton(t, "changes-confirm-cancel", "Cancel", (_e, cx) => { this.confirm = null; this.handle.focus(); cx.notify(); }))
          .child(textButton(t, "changes-confirm-ok", c.label, (_e, cx) => { this.confirm = null; this.handle.focus(); c.run(cx); })
            .bg(t.ansi1).border_color(t.ansi1).text_color(t.background).hover(s => s.bg(t.ansi9 ?? t.ansi1)))));
  }

  // What a selected file can do, for its page header (side panel) or its bar (full mode).
  fileActions(t, e, prefix) {
    if (!e) return [];
    const b = (bid, icon, tip, fn) => iconButton(t, `${prefix}-${bid}`, icon, (_ev, cx) => fn(cx), { disabled: Boolean(this.busy) }).tooltip(tip);
    return [
      e.section !== "conflicts" && b("discard", "undo-2", e.section === "untracked" ? "Delete file" : "Discard changes", (cx) => this.askDiscard([e], cx)),
      e.section === "staged" ? b("unstage", "minus", "Unstage", (cx) => this.toggleStage(e, cx)) : b("stage", "plus", e.section === "conflicts" ? "Mark resolved" : "Stage", (cx) => this.toggleStage(e, cx)),
      b("open", "file-text", "Open file", (cx) => { this.openFile(e.path, e.section === "staged" && e.status === "D" ? "HEAD" : null); this.syncDetail(cx); }),
    ].filter(Boolean);
  }

  expandButton(t) {
    return this.full
      ? iconButton(t, "changes-shrink", "collapse", () => closeFull()).tooltip("Back to the side panel")
      : iconButton(t, "changes-expand", "expand", () => openFull("changes", this.sel && this.sel !== "all" ? { path: this.sel.path, section: this.sel.section } : null)).tooltip("Full view");
  }

  headerActions(t) {
    return [
      this.loading || this.busy ? svg("mods/workspace-chrome/spinner.svg").size(SIZE.icon).flex_none().text_color(t.dim).spin(900) : null,
      iconButton(t, "changes-refresh", "rotate-cw", (_e, cx) => this.refresh(cx, { changed: true })).tooltip("Refresh"),
      this.expandButton(t),
    ].filter(Boolean);
  }

  subtitle() {
    if (!this.repo) return this.cwd ? baseName(this.cwd) : null;
    const n = this.count();
    return `${this.repo.branch ?? (this.repo.head ? `detached ${this.repo.head.slice(0, 7)}` : "no commits")}${n ? ` · ${plural(n, "change")}` : ""}`;
  }

  detailPane(t) {
    if (this.previewAt && this.preview) {
      return v_flex().size_full().min_h(0).min_w(0)
        .child(subbar(t, "changes-preview-bar").bg(t.chrome)
          .child(h_flex().id("changes-preview-back").h(SIZE.button).pl(4).pr(8).gap(4).items_center().rounded(SIZE.radius).cursor_pointer()
            .text_size(SIZE.small).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
            .on_click((_e, cx) => { cx.stop_propagation(); this.back(cx); })
            .child(svg(ui("chevron-left")).size(SIZE.icon)).child("Diff"))
          .child(div().min_w(0).truncate().text_size(SIZE.small).text_color(t.dim).child(this.previewAt.path)))
        .child(div().flex_1().min_h(0).min_w(0).flex().flex_col().child(this.preview));
    }
    if (!this.sel || !this.diff) return empty(t, "Nothing selected", "Pick a file on the left");
    const e = this.find(this.sel);
    const title = this.sel === "all" ? "All changes" : this.sel.path;
    return v_flex().size_full().min_h(0).min_w(0)
      .child(subbar(t, "changes-detail-bar").h(SIZE.header).bg(t.chrome)
        .when(Boolean(e), el => el.child(image(iconFor(e.path)).size(SIZE.icon).flex_none()))
        .child(div().min_w(0).flex_shrink_1().truncate().text_size(SIZE.text).font_medium().child(title))
        .child(div().flex_none().text_size(SIZE.small).text_color(t.dim).child(this.sel === "all" ? "vs HEAD" : label(this.sel.section)))
        .child(div().flex_1())
        .children(this.fileActions(t, e, "changes-detail")))
      .child(div().flex_1().min_h(0).min_w(0).flex().flex_col().child(this.diff));
  }

  render(cx) {
    // The first draw starts the work (a copy that is made but never drawn stays idle); a copy
    // that missed changes while hidden catches up when it shows again.
    if (!this.started) { this.started = true; this.refresh(cx); }
    else if (this.stale && this.isShown()) { this.stale = false; this.refresh(cx); }
    else { const loc = location(); if (loc.cwd && locationKey(loc) !== this.ctx) this.refresh(cx); }
    const t = theme();
    const root = (body) => div().id("changes-root").size_full().min_w(0).min_h(0).relative().flex().flex_col()
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", (_e, cx) => { if (this.typing) { this.typing = false; cx.notify(); } if (!this.editing) this.handle.focus(); })
      .child(body)
      .when(Boolean(this.confirm), el => el.child(this.confirmView(t)));
    const top = header(t, { icon: "changes", title: "Changes", subtitle: this.subtitle(), actions: this.headerActions(t) });

    if (!this.wide) {
      if (this.page === "preview" && this.previewAt && this.preview) {
        return root(frame(t, header(t, { id: "changes-preview-header", back: (_e, cx) => this.back(cx), backLabel: "Diff",
          title: baseName(this.previewAt.path), subtitle: dirName(this.previewAt.path), actions: [this.expandButton(t)] }),
          div().size_full().min_h(0).flex().flex_col().child(this.preview)));
      }
      if (this.page === "diff" && this.sel && this.diff) {
        const e = this.find(this.sel);
        const name = this.sel === "all" ? "All changes" : baseName(this.sel.path);
        const sub = this.sel === "all" ? null : [label(this.sel.section), dirName(this.sel.path)].filter(Boolean).join(" · ");
        return root(frame(t, header(t, { id: "changes-detail-header", back: (_e, cx) => this.back(cx), backLabel: "Changes", title: name, subtitle: sub,
          actions: [...this.fileActions(t, e, "changes-page"), this.expandButton(t)] }),
          div().size_full().min_h(0).flex().flex_col().child(this.diff)));
      }
      return root(frame(t, top, this.list(t)));
    }
    return root(frame(t, top, h_resizable("changes-split").size_full()
      .on_resize((sizes) => { if (sizes?.[0]) { this.split = Math.round(sizes[0]); setPref("split", this.split); } })
      .child(resizable_panel().size(this.split).size_range(SPLIT.min, SPLIT.max).child(v_flex().size_full().min_h(0).border_r(1).border_color(t.border).child(this.list(t))))
      .child(resizable_panel().child(div().size_full().min_w(0).flex().flex_col().child(this.data && this.count() ? this.detailPane(t) : empty(t, this.data ? "Nothing to show" : "", null))))));
  }
}

// Which of a file row's buttons a press `fromEnd` px from the row's right edge is on: they sit
// right to left past the padding and the status letter, gap 1 (rowActions).
function rowButtonAt(fromEnd, discardable) {
  const start = SIZE.pad + BADGE + 6;
  const slot = (n) => fromEnd >= start + n * (BUTTON + 1) - 0.5 && fromEnd < start + n * (BUTTON + 1) + BUTTON + 0.5;
  if (slot(0)) return "stage";
  if (discardable) return slot(1) ? "discard" : slot(2) ? "open" : null;
  return slot(1) ? "open" : null;
}
