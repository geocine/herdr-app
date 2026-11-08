// Files: the focused terminal's folder as a tree, with git state on every row (status letters
// and colors, folders' change dots, +/− lines), the branch and its upstream, a Changed filter,
// fuzzy search across folders not yet opened, keyboard navigation and a context menu. A file
// opens in the shared Preview: one page at a time in the side panel ("← Files"), beside the
// tree in full mode.
//
// Ported from carstenlucke/herdr-roundup `roundup-files` (Apache-2.0), parts of which follow
// cybertron288/herdr-mods `filetree` (MIT). See NOTICE.md.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, Popup, v_virtual_list, VirtualListScrollHandle, h_resizable, resizable_panel } from "gpui-base";
import { theme, settings, watchFolder, notify, home } from "herdr";
import { SIZE, frame, header, subbar, row, iconButton, segmented, empty, textButton, badge, counts, ui } from "../../lib/ui.js";
import { statusLetter, statusColor } from "../../lib/git.js";
import { location, slash, baseName } from "../../lib/where.js";
import { iconFor } from "../../lib/icons.js";
import { openFull, closeFull, inFull } from "../../lib/nav.js";
import Preview from "../../lib/preview/index.js";
import { listDir, diskIndex, compare, PER_FOLDER, INDEX_DIRS, INDEX_PATHS } from "./disk.js";
import { readGit, gitIndex, emptyGit, ancestors, dirOf, baseOf, within, NEW, MODIFIED, DELETED } from "./status.js";
import { search, words } from "./fuzzy.js";
import { openExternal, revealExternal, revealLabel, copy, sendPath, sendTarget, terminalHere, native, relTo } from "./actions.js";
import { rootKey, recall, remember, pref, setPref } from "./memory.js";

const ROW = SIZE.row;
const FIND_LIMIT = 200;
// Changed builds its rows on every render: at most this many of git's paths.
const CHANGED_LIMIT = 2000;
// A search index is read again once a change made it stale and it is this old, or at this age.
const STALE_AGE = 3000, INDEX_AGE = 300000;
const MENU_W = 236, ITEM_H = 28;
const SPLIT = { min: 200, max: 900, default: 320 };
const VIEWS = ["all", "changed"];

const message = (e) => String(e?.message ?? e).trim().split(/\r?\n/)[0];
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const zoom = () => Number(settings()?.zoom) || 1;
// rel is "/"-separated; root too ("C:/src/app" on Windows, which every tool there accepts).
const join = (root, rel) => (!rel ? root : root.endsWith("/") ? root + rel : `${root}/${rel}`);
const changeColor = (t, i) => statusColor(t, i === NEW ? "A" : i === MODIFIED ? "M" : "D");

export default class FilesView extends View {
  init(p, cx) {
    this.p = p ?? {};
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.view = VIEWS.includes(pref("view", "all")) ? pref("view", "all") : "all";
    this.source = pref("source", "git") === "disk" ? "disk" : "git";
    this.split = Math.max(SPLIT.min, Math.min(SPLIT.max, Number(pref("split", SPLIT.default)) || SPLIT.default));
    this.width = 360; this.query = ""; this.hits = null; this.searchSeq = 0; this.shown = [];
    this.preview = null; this.menu = null; this.typing = false;
    this.start = this.p.start?.path ? this.p.start : null;
    this.input = InputState.new({ placeholder: "Search files" });
    this.input.on("change", (_e, cx) => { const v = this.input.value(); if (v !== this.query) this.search(v, cx); });
    this.input.on("submit", (_e, cx) => {
      const r = this.shown.find((x) => x.key === this.cursorKey()) ?? this.shown[0];
      if (r && !r.dir) this.handle.focus();
      this.activate(r, cx);
      cx.notify();
    });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.reset(null, null);
    cx.timer.every(10000, (cx) => {
      this.refresh(cx);
      if (this.index && this.outdated(this.index)) this.searchAgain(cx);
    });
  }

  update(p) {
    const wide = Boolean(this.p.wide);
    this.p = p ?? {};
    if (Boolean(this.p.wide) !== wide && this.preview) this.preview.set_props(this.previewProps());
  }

  get wide() { return Boolean(this.p.wide); }
  get full() { return Boolean(this.p.full) || inFull(); }

  // ── the folder shown ─────────────────────────────────────────────────────────────────
  // Leaves the folder shown (its open folders, cursor and file are remembered) for root.
  reset(root, on) {
    if (this.root) this.save();
    const key = rootKey(root ?? "", on), s = root ? recall(key) : null;
    this.ctx = { key, root, on, base: null, drops: 0, failed: null };
    this.root = root; this.on = on;
    this.entries = new Map(); this.folders = new Set(s?.folders); this.shut = new Set(); this.pending = new Set();
    this.cursor = s?.cursor ?? ""; this.git = emptyGit(); this.index = null; this.indexing = null;
    this.hits = null; this.searchError = null; this.searchSeq++; this.searching = false;
    this.error = null; this.limited = false; this.loading = false; this.again = false; this.watched = null;
    this.menu = null; this.file = null;
    this.scrollTo = this.cursor || null;
    if (this.query) { this.query = ""; this.input?.set_value(""); }
    return s?.file ?? null;
  }

  save() {
    if (!this.root) return;
    remember(this.ctx.key, { folders: this.folders, cursor: this.cursor, file: this.file });
  }

  current(ctx) { return this.ctx === ctx; }

  // Follows the focused terminal; keeps the last place while focus is somewhere without a folder.
  sync(cx) {
    const l = location();
    const cwd = l.cwd ? slash(l.cwd).replace(/(.)\/+$/, "$1") : null;
    if (!cwd || (cwd === this.root && l.on === this.on)) return;
    let file = this.reset(cwd, l.on);
    if (this.start) {
      const s = this.start;
      this.start = null;
      const rel = s.root && slash(s.root) !== cwd ? relTo(cwd, join(slash(s.root), s.path)) : s.path;
      if (rel) { file = rel; this.cursor = rel; for (const a of ancestors(rel)) this.folders.add(a); this.scrollTo = rel; }
    }
    this.refresh(cx);
    if (file) {
      const ctx = this.ctx;
      // Not now: render can't create the Preview (a retained view).
      cx.timer.after(1, (cx) => { if (this.current(ctx) && !this.file) { this.openFile(file, cx, false); cx.notify(); } });
    }
  }

  refresh(cx) {
    if (!this.root) return;
    if (this.loading) { this.again = true; return; }
    const ctx = this.ctx, drops = ctx.drops;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const [more, git] = await Promise.all([
          Promise.all(["", ...this.folders].map((path) => this.loadFolder(path, ctx).catch((e) => {
            if (!path) throw e;
            if (this.current(ctx)) { this.folders.delete(path); this.entries.delete(path); }
            return false;
          }))),
          readGit(ctx.root, ctx.on, ctx.base),
        ]);
        if (!this.current(ctx)) return;
        if (ctx.drops === drops) ctx.base = git.repo && !git.failed ? { top: git.top, prefix: git.prefix } : null;
        const prev = this.git;
        this.git = git; this.limited = more.some(Boolean); this.error = null;
        if (git.known && (!prev.known || prev.repo !== git.repo || prev.rootIgnored !== git.rootIgnored)) {
          if (this.index) { this.index.stale = true; this.index.at = 0; this.searchAgain(cx); }
          if (this.preview && prev.top !== git.top) this.preview.set_props(this.previewProps());
        }
        // Changed searches git's paths: they may have changed.
        if (this.view === "changed" && this.hits) this.searchAgain(cx);
        this.watch(cx);
      } catch (e) { if (this.current(ctx)) { this.error = message(e); this.git = emptyGit(true); this.entries = new Map(); } }
      finally {
        if (this.current(ctx)) {
          this.loading = false;
          if (this.again) { this.again = false; this.refresh(cx); }
        }
        cx.notify();
      }
    });
  }

  async loadFolder(path, ctx) {
    const { entries, more } = await listDir(join(ctx.root, path), ctx.on);
    if (!this.current(ctx) || (path && !this.folders.has(path))) return false;
    this.entries.set(path, entries);
    return more;
  }

  // Local folders refresh when something under them changes; other machines on the timer.
  watch(cx) {
    if (this.on || this.watched === this.root) return;
    const ctx = this.ctx, root = this.root;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.current(ctx)) {
          const paths = await watchFolder(root);
          if (!this.current(ctx)) return;
          this.changed(paths, cx);
        }
      } catch { if (this.current(ctx)) this.watched = null; }
    });
  }

  // A batch of changed paths: refresh unless all of them are out of sight (an ignored folder
  // not open: a build in target/ or node_modules), and mark the search index stale.
  changed(paths, cx) {
    let shown = !paths.length, touched = false;
    for (const abs of paths) {
      const rel = relTo(this.root, abs);
      if (rel === null || rel === "") { shown = true; touched = true; continue; }
      if (rel === ".git") { this.ctx.base = null; this.ctx.drops++; }
      if (!shown && !this.unseen(rel)) shown = true;
      if (!rel.split("/").includes(".git") || rel === ".git/index" || rel === ".git/info/exclude") touched = true;
    }
    if (touched && this.index) {
      this.index.stale = true;
      if (!this.index.held && this.query.trim()) {
        this.index.held = true;
        const index = this.index;
        cx.timer.after(STALE_AGE, (cx) => { if (this.index === index) this.searchAgain(cx); });
      }
    }
    if (shown) this.refresh(cx);
  }

  // Whether a change at rel leaves the tree and git's marks as they are.
  unseen(rel) {
    const g = this.git;
    if (!rel || !g.known) return false;
    const dir = dirOf(rel);
    if (!dir || this.folders.has(dir)) return false;
    if (!g.repo) return !rel.startsWith(".git/");
    return this.isIgnored(rel) && !g.status.has(rel);
  }

  isIgnored(rel) { const g = this.git; return (g.rootIgnored || within(g.ignored, rel)) && !g.forced.has(rel); }
  underUntracked(rel) { return this.git.rootUntracked || within(this.git.untracked, rel); }

  // ── folders ──────────────────────────────────────────────────────────────────────────
  toggle(r, cx) {
    if (!r?.dir || r.gone) return;
    if (this.hits) { this.reveal(r.rel, true, cx); return; }
    if (this.view === "changed" && !r.disk) {
      if (this.shut.has(r.rel)) this.shut.delete(r.rel); else this.shut.add(r.rel);
    } else if (this.folders.has(r.rel)) {
      for (const f of [...this.folders]) if (f === r.rel || f.startsWith(r.rel + "/")) { this.folders.delete(f); this.entries.delete(f); }
      this.save();
    } else this.open([r.rel], cx, () => this.save(), false);
  }

  collapseAll(cx) {
    if (this.view === "changed") for (const r of this.changedRows()) { if (r.dir && !r.disk) this.shut.add(r.rel); }
    this.folders.clear();
    for (const k of [...this.entries.keys()]) if (k) this.entries.delete(k);
    this.cursor = this.cursor.split("/")[0];
    this.scrollTo = this.cursor;
    this.save();
    cx.notify();
  }

  // Opens folders (with parents, those above them too) and loads what they hold.
  open(paths, cx, then, parents = true) {
    const ctx = this.ctx, todo = [];
    for (const p of paths) for (const d of parents ? [...ancestors(p).reverse(), p] : [p]) if (d && !this.folders.has(d)) { this.folders.add(d); todo.push(d); }
    cx.spawn(async (cx) => {
      await Promise.all(todo.map(async (d) => {
        if (!this.current(ctx) || this.entries.has(d) || this.pending.has(d)) return;
        this.pending.add(d);
        try { if (await this.loadFolder(d, ctx)) this.limited = true; }
        catch (e) {
          if (!this.current(ctx)) return;
          this.folders.delete(d);
          notify({ title: "Can't open this folder", body: `${d}: ${message(e)}`, level: "warning", timeout: 3000 });
        } finally { if (this.current(ctx)) this.pending.delete(d); }
      }));
      if (this.current(ctx)) then?.();
      cx.notify();
    });
  }

  // Shows rel in the tree (search cleared, its folders open, the cursor on it).
  reveal(rel, openIt, cx) {
    if (this.query) this.clearSearch(cx);
    this.cursor = rel;
    if (this.view === "changed") {
      // In Changed a path git doesn't list isn't in the tree: show it in All.
      if (!this.git.files.has(rel) && ![...this.git.files.keys()].some((f) => f.startsWith(rel + "/"))) this.setView("all", cx);
      else for (const a of [...ancestors(rel), ...(openIt ? [rel] : [])]) this.shut.delete(a);
    }
    this.open(openIt ? [rel] : ancestors(rel), cx, () => { this.scrollTo = rel; this.save(); });
  }

  setView(view, cx) {
    if (view === this.view || !VIEWS.includes(view)) return;
    this.view = view;
    setPref("view", view);
    this.hits = null; this.searchSeq++;
    if (this.query.trim()) this.search(this.query, cx);
    this.scrollTo = this.cursor || null;
    cx.notify();
  }

  setSource(source, cx) {
    if (source === this.source) return;
    this.source = source;
    setPref("source", source);
    if (this.query.trim()) this.search(this.query, cx);
    cx.notify();
  }

  // ── search ───────────────────────────────────────────────────────────────────────────
  // Fuzzy: All searches every path below the folder (git's files, or the disk); Changed
  // searches git's paths. The best FIND_LIMIT, best first.
  search(query, cx, quiet = false) {
    this.query = query;
    const seq = ++this.searchSeq;
    if (!words(query).length) { this.hits = null; this.searching = false; this.searchError = null; this.scrollTo = this.cursor || null; cx.notify(); return; }
    const ctx = this.ctx;
    if (this.view === "changed") {
      const all = [...this.git.files.keys()];
      this.hits = search(all, all.map((r) => r.toLowerCase()), query, FIND_LIMIT).map((h) => ({ ...h, dir: this.git.untracked.has(h.rel) || this.git.links.has(h.rel) }));
      this.afterSearch(quiet);
      cx.notify();
      return;
    }
    this.searching = true; this.searchError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const index = await this.ensureIndex(ctx);
        if (seq !== this.searchSeq || !this.current(ctx)) return;
        this.hits = search(index.all, index.lower, query, FIND_LIMIT).map((h) => ({ ...h, dir: index.dirs.has(h.rel) }));
        this.afterSearch(quiet);
      } catch (e) { if (seq === this.searchSeq && this.current(ctx)) { this.hits = []; this.searchError = message(e); } }
      finally { if (seq === this.searchSeq) this.searching = false; cx.notify(); }
    });
  }

  afterSearch(quiet) {
    const before = this.cursor;
    if (!this.hits.some((h) => h.rel === before)) this.cursor = this.hits[0]?.rel ?? "";
    if (!quiet || this.cursor !== before) this.scrollTo = this.cursor;
  }

  searchAgain(cx) { if (this.query.trim()) this.search(this.query, cx, true); }

  outdated(i) { const age = Date.now() - i.at; return (i.stale && age >= STALE_AGE) || age >= INDEX_AGE; }

  // Where search reads: git's files in a repo (unless the disk was picked), else the disk.
  gitSearch() { const g = this.git; return this.source === "git" && (!g.known || (g.repo && !g.rootIgnored)); }

  ensureIndex(ctx) {
    const i = this.index, fromGit = this.gitSearch();
    if (i && i.git === fromGit && !this.outdated(i)) return Promise.resolve(i);
    if (this.indexing?.git !== fromGit) {
      const job = { git: fromGit };
      job.promise = (async () => {
        const g = this.git;
        let built = fromGit ? await gitIndex(ctx.root, ctx.on, INDEX_PATHS, g.known && g.repo ? g.rootIgnored : undefined) : null;
        const from = built ? "git" : "disk";
        if (!built) built = await diskIndex(ctx.root, ctx.on, home());
        const index = { ...built, lower: built.all.map((r) => r.toLowerCase()), git: fromGit, from, at: Date.now(), stale: false, held: false };
        if (this.current(ctx)) this.index = index;
        return index;
      })().finally(() => { if (this.current(ctx) && this.indexing === job) this.indexing = null; });
      this.indexing = job;
    }
    return this.indexing.promise;
  }

  clearSearch(cx) {
    this.query = ""; this.hits = null; this.searchSeq++; this.searching = false; this.searchError = null;
    this.input.set_value("");
    this.scrollTo = this.cursor || null;
    cx.notify();
  }

  // ── rows ─────────────────────────────────────────────────────────────────────────────
  // Tree rows: { key, rel, name, dir, depth, open, gone, disk }; search rows add hit: pos.
  rows() {
    this.changedCut = false;
    if (this.error || !this.root) return [];
    if (this.hits) return this.hitRows();
    if (this.view === "changed") return this.changedRows();
    const out = [];
    this.diskRows("", 0, out);
    return out;
  }

  diskRows(prefix, depth, out) {
    for (const e of this.entries.get(prefix) ?? []) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name, open = e.dir && this.folders.has(rel);
      out.push({ key: rel, rel, name: e.name, dir: e.dir, depth, open, gone: false, disk: e.dir });
      if (open && depth < 40) this.diskRows(rel, depth + 1, out);
    }
  }

  hitRows() {
    return this.hits.map((h) => ({ key: `?${h.rel}`, rel: h.rel, name: baseOf(h.rel), dir: h.dir, depth: 0, open: false, gone: this.git.gone.has(h.rel), disk: false, hit: h.pos }));
  }

  // Exactly the paths git status lists, as a tree: deleted files too, untracked folders and
  // submodules as one row that opens from disk.
  changedRows() {
    const g = this.git, out = [], kids = new Map(), dirs = new Set([...g.untracked, ...g.links]);
    const add = (rel) => { const p = dirOf(rel); if (!kids.has(p)) kids.set(p, new Set()); kids.get(p).add(rel); };
    let taken = 0;
    for (const rel of g.files.keys()) {
      if (taken++ >= CHANGED_LIMIT) { this.changedCut = true; break; }
      add(rel);
      for (const a of ancestors(rel)) { dirs.add(a); add(a); }
    }
    const order = (list) => list.sort((a, b) => Number(b[1]) - Number(a[1]) || compare(baseOf(a[0]), baseOf(b[0])));
    const push = (rel, dir, depth, open, gone, disk) => out.push({ key: rel, rel, name: baseOf(rel), dir, depth, open, gone, disk });
    const walk = (p, depth) => {
      for (const [rel, dir] of order([...(kids.get(p) ?? [])].map((rel) => [rel, dirs.has(rel)]))) {
        const gone = g.gone.has(rel);
        if (dir && !gone && (g.untracked.has(rel) || g.links.has(rel))) {
          const open = this.folders.has(rel);
          push(rel, true, depth, open, false, true);
          if (open) mixed(rel, depth + 1);
        } else if (dir && !gone) {
          const open = !this.shut.has(rel);
          push(rel, true, depth, open, false, false);
          if (open) walk(rel, depth + 1);
        } else push(rel, dir, depth, false, gone, false);
      }
    };
    const mixed = (p, depth) => {
      const disk = this.entries.get(p) ?? [], here = new Map();
      for (const e of disk) here.set(`${p}/${e.name}`, e.dir);
      const list = new Map(here);
      for (const rel of kids.get(p) ?? []) if (!list.has(rel)) list.set(rel, dirs.has(rel));
      for (const [rel, dir] of order([...list])) {
        const onDisk = here.has(rel), gone = !onDisk && g.gone.has(rel);
        if (dir && onDisk) {
          const open = this.folders.has(rel);
          push(rel, dir, depth, open, gone, true);
          if (open && depth < 40) mixed(rel, depth + 1);
        } else push(rel, dir, depth, false, gone, false);
      }
    };
    walk("", 0);
    return out;
  }

  cursorKey() { return this.hits ? `?${this.cursor}` : this.cursor; }

  // ── opening ──────────────────────────────────────────────────────────────────────────
  previewProps() {
    return {
      on: this.on, root: this.root, path: this.file, rev: null, repoTop: this.git.repo ? slash(this.git.top) : null, wide: this.wide,
      // A relative link in the preview (a markdown link to another file).
      onOpen: (rel, _rev, cx) => this.followLink(rel, cx),
      // While the preview edits, typed keys are the editor's, not the tree's shortcuts.
      onEditing: (on) => { this.editing = on; },
    };
  }

  followLink(rel, cx) {
    if (!rel) return;
    rel = slash(rel).replace(/^\.\//, "");
    this.file = rel; this.cursor = rel;
    this.preview?.set_props(this.previewProps());
    this.save();
    if (cx) { this.reveal(rel, false, cx); cx.notify(); }
  }

  // Shows a file in the detail page (Preview). cx: an event's or a task's (it may create the
  // Preview, which render can't).
  openFile(rel, cx, save = true) {
    this.file = rel;
    this.cursor = rel;
    if (!this.preview) this.preview = cx.new(Preview, this.previewProps());
    else this.preview.set_props(this.previewProps());
    if (save) this.save();
  }

  closeFile(cx) {
    this.file = null;
    this.handle.focus();
    this.scrollTo = this.cursor || null;
    this.save();
    cx.notify();
  }

  // Enter, a click: a file opens, a folder opens or closes; neither when it is gone.
  activate(r, cx) {
    if (!r) return;
    this.cursor = r.rel;
    if (r.gone) { notify({ title: r.dir ? "Deleted folder" : "Deleted file", body: `${r.rel} is no longer on disk`, level: "info", timeout: 2500 }); return; }
    if (r.dir) this.toggle(r, cx);
    else this.openFile(r.rel, cx);
  }

  // ── context menu ─────────────────────────────────────────────────────────────────────
  menuItems(r) {
    const local = !this.on, live = !r.gone, target = sendTarget();
    return [
      [live && (r.dir ? ["toggle", r.open && !this.hits ? "Collapse" : "Expand"] : ["open", "Open"]),
        live && !r.dir && !this.full && ["full", "Open in full view"],
        local && live && !r.dir && ["external", "Open in default app"],
        local && live && ["reveal", revealLabel()]],
      [["copy-abs", "Copy path"], ["copy-rel", "Copy relative path"], ["copy-name", "Copy name"]],
      [["send", target?.agent === false ? "Send path to terminal" : "Send path to agent"],
        live && ["terminal", r.dir ? "New terminal here" : "New terminal in its folder"]],
    ].map((g) => g.filter(Boolean)).filter((g) => g.length);
  }

  openMenu(r, at) {
    this.cursor = r.rel;
    const groups = this.menuItems(r);
    this.menu = { r, groups, items: groups.flat(), at: at.keys ? 0 : -1, x: at.x, y: at.y, up: at.up };
  }

  runMenu(id, cx) {
    const r = this.menu?.r;
    this.menu = null;
    if (r) this.act(id, r, cx);
    cx.notify();
  }

  act(id, r, cx) {
    const abs = join(this.root, r.rel);
    if (id === "open") this.activate(r, cx);
    else if (id === "toggle") this.toggle(r, cx);
    else if (id === "full") openFull("files", { path: r.rel, root: this.root, on: this.on });
    else if (id === "copy-abs") copy(cx, native(abs, this.on));
    else if (id === "copy-rel") copy(cx, r.rel);
    else if (id === "copy-name") copy(cx, r.name);
    else if (id === "send") sendPath(cx, abs, this.on);
    else if (id === "terminal") terminalHere(native(r.dir ? abs : join(this.root, dirOf(r.rel)), this.on));
    else cx.spawn(async () => {
      try {
        if (id === "external") await openExternal(abs);
        else if (id === "reveal") await revealExternal(abs, r.dir);
      } catch (e) { notify({ title: id === "reveal" ? "Can't show it" : "Can't open it", body: message(e), level: "error", timeout: 4000 }); }
    });
  }

  // The Menu key or Shift-F10: the menu below the selected row (above it near the bottom).
  keyMenu() {
    const at = this.shown.findIndex((x) => x.key === this.cursorKey());
    if (at < 0 || !this.listHeight) return;
    const r = this.shown[at];
    this.scroll.scroll_to_item(at, "center");
    const h = this.listHeight, n = this.shown.length;
    const offset = Math.max(0, Math.min(at * ROW + ROW / 2 - h / 2, n * ROW - h));
    const top = at * ROW - offset, tall = this.menuItems(r).flat().length * ITEM_H + 40;
    const x = SIZE.pad + r.depth * SIZE.indent + 30;
    this.openMenu(r, top + ROW + tall > h ? { x, y: top, up: true, keys: true } : { x, y: top + ROW, keys: true });
  }

  menuView(t) {
    const m = this.menu;
    let n = 0;
    const item = ([id, label]) => {
      const on = n++ === m.at;
      return h_flex().id(`files-menu-${id}`).h(ITEM_H).px(10).flex_none().items_center().rounded(SIZE.radius).cursor_pointer().text_size(SIZE.text)
        .text_color(t.foreground).when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.runMenu(id, cx); })
        .child(label);
    };
    const surface = v_flex().id("files-menu").w(MENU_W).p(4).rounded(SIZE.card).border_1().border_color(t.border).bg(t.popover ?? t.surface).shadow_lg()
      .when(m.up, (el) => el.mb(2)).when(!m.up, (el) => el.mt(2))
      .on_mouse_down_out((_e, cx) => { if (this.menu === m) { this.menu = null; cx.notify(); } })
      .child(h_flex().h(ITEM_H - 4).px(10).gap(6).items_center().text_size(SIZE.small).text_color(t.dim)
        .child(image(iconFor(m.r.rel, m.r.dir, false)).size(SIZE.icon - 2).flex_none())
        .child(div().min_w(0).truncate().child(m.r.rel)))
      .children(m.groups.flatMap((g) => [div().h(1).mx(6).my(4).bg(t.border), ...g.map(item)]));
    return Popup.new("files-menu-pin", div()).absolute().top(m.y).left(m.x).size(1).anchor(m.up ? "bottom_left" : "top_left").content(surface);
  }

  // ── keyboard ─────────────────────────────────────────────────────────────────────────
  move(delta) {
    const rows = this.shown;
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.key === this.cursorKey());
    const from = at >= 0 ? at : delta > 0 ? -1 : rows.length;
    const next = Math.max(0, Math.min(rows.length - 1, from + delta));
    this.cursor = rows[next].rel;
    this.scroll.scroll_to_item(next);
  }

  key(e, cx) {
    if (this.editing) return;
    const k = e.key, m = e.modifiers ?? {};
    if (this.menu) {
      const menu = this.menu, n = menu.items.length;
      if (k === "down" || k === "tab") menu.at = (menu.at + 1) % n;
      else if (k === "up") menu.at = (menu.at - 1 + n) % n;
      else if (k === "home" || k === "pageup") menu.at = 0;
      else if (k === "end" || k === "pagedown") menu.at = n - 1;
      else if ((k === "enter" || k === "space") && menu.at >= 0) this.runMenu(menu.items[menu.at][0], cx);
      else if (k === "escape" || k === "left" || k === "menu" || (k === "f10" && m.shift)) this.menu = null;
      else return;
      cx.stop_propagation(); cx.notify(); return;
    }
    // Ctrl+F searches the files while the list has the keyboard (the preview has its own find).
    if ((m.control || m.platform) && k === "f" && this.handle.is_focused() && !(this.file && !this.wide)) { this.input.focus(); cx.stop_propagation(); return; }
    if (m.control || m.platform || m.alt) return;
    if (this.typing) {
      if (k === "escape") { if (this.query) this.clearSearch(cx); else this.handle.focus(); }
      else if (k === "down" || k === "up") this.move(k === "down" ? 1 : -1);
      else return;
      cx.stop_propagation(); cx.notify(); return;
    }
    const mine = this.handle.is_focused();
    if (this.file && !this.wide) {
      if (k === "escape" || (mine && (k === "backspace" || k === "left"))) this.closeFile(cx);
      else return;
      cx.stop_propagation(); return;
    }
    if (!mine) return;
    const rows = this.shown, cur = rows.find((r) => r.key === this.cursorKey());
    if (k === "up") this.move(-1);
    else if (k === "down") this.move(1);
    else if (k === "pageup") this.move(-10);
    else if (k === "pagedown") this.move(10);
    else if (k === "home") this.move(-rows.length);
    else if (k === "end") this.move(rows.length);
    else if (k === "/" || e.key_char === "/") this.input.focus();
    else if (k === "escape" && this.query) this.clearSearch(cx);
    else if (!cur) return;
    else if (k === "right") { if (cur.dir && !cur.open) this.toggle(cur, cx); else if (cur.dir) this.move(1); }
    else if (k === "left") {
      if (cur.dir && cur.open && !this.hits) this.toggle(cur, cx);
      else { const at = rows.findIndex((r) => r.key === dirOf(cur.rel)); if (dirOf(cur.rel) && at >= 0) { this.cursor = rows[at].rel; this.scroll.scroll_to_item(at); } }
    }
    else if (k === "enter" || k === "space") this.activate(cur, cx);
    else if (k === "menu" || (k === "f10" && m.shift)) this.keyMenu();
    else return;
    cx.stop_propagation(); cx.notify();
  }

  // ── drawing ──────────────────────────────────────────────────────────────────────────
  treeRow(r, t) {
    const g = this.git, rel = r.rel;
    const own = g.status.get(rel), ignored = !own && this.isIgnored(rel);
    const status = own ?? (!ignored && this.underUntracked(rel) ? "?" : null);
    const color = status ? statusColor(t, status) : null;
    const lines = g.diff.get(rel), dots = r.dir ? g.counts.get(rel) : null;
    const showLines = Boolean(lines?.[0] || lines?.[1]) && (!r.dir ? this.width >= 260 : this.width >= 380);
    const selected = r.key === this.cursorKey(), open = !r.dir && rel === this.file;
    const name = (r.hit ? this.marked(t, r.name, r.hit, rel.length - r.name.length, color ?? t.foreground).flex_none() : div().flex_1().min_w(0).truncate().child(r.name))
      .text_color(ignored ? t.dim : color ?? t.foreground).when(r.gone, (el) => el.line_through()).when(open, (el) => el.font_semibold());
    return row(t, `files-row-${r.key}`, { selected, depth: r.depth })
      .when(!r.hit, (el) => el.child(r.dir ? svg(ui(r.open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none()))
      .child(image(iconFor(rel, r.dir, r.open)).size(SIZE.icon + 2).flex_none().when(ignored || r.gone, (el) => el.opacity(0.5)))
      .child(name)
      .when(Boolean(r.hit) && !dirOf(rel), (el) => el.child(div().flex_1()))
      .when(Boolean(r.hit) && Boolean(dirOf(rel)), (el) => el.child(this.marked(t, dirOf(rel), r.hit, 0, t.dim).flex_1().min_w(0).overflow_hidden().text_size(SIZE.small)))
      .when(Boolean(dots), (el) => el.child(this.dots(t, dots)))
      .when(showLines, (el) => el.child(counts(t, lines[0], lines[1])))
      .child(badge(t, !status || (r.dir && dots) ? "" : statusLetter(status), color).text_right());
  }

  // A folder's changes below it: a dot and a count each for modified, new and deleted.
  dots(t, c) {
    return h_flex().gap(6).flex_none().text_size(SIZE.small).children([MODIFIED, NEW, DELETED].filter((i) => c[i] > 0).map((i) =>
      h_flex().gap(3).items_center().text_color(changeColor(t, i)).child(div().size(6).rounded(3).bg(changeColor(t, i))).child(String(c[i]))));
  }

  // Text with the fuzzy match's characters lit. pos: positions in the whole path; offset: where
  // text starts in it.
  marked(t, text, pos, offset, base) {
    const lit = new Set(pos.map((p) => p - offset).filter((p) => p >= 0 && p < text.length));
    const parts = [];
    let i = 0;
    while (i < text.length) {
      const on = lit.has(i);
      let j = i;
      while (j < text.length && lit.has(j) === on) j++;
      parts.push(div().flex_none().text_color(on ? t.accent : base).when(on, (el) => el.font_semibold()).child(text.slice(i, j).replace(/ /g, "\u00a0")));
      i = j;
    }
    return h_flex().whitespace_nowrap().children(parts);
  }

  branchBar(t) {
    const g = this.git, b = g.branch;
    const bar = subbar(t, "files-branch").text_size(SIZE.small).text_color(t.muted)
      .child(svg(ui("git-branch")).size(SIZE.icon - 2).flex_none().text_color(g.repo ? t.accent : t.dim));
    if (!this.root) return bar.child(div().text_color(t.dim).child("No folder"));
    if (!g.known) return bar.child(div().text_color(t.dim).child("Reading git…"));
    if (!g.repo || g.failed) return bar.child(div().min_w(0).truncate().text_color(t.dim).child(g.failed ? "Git can't read this folder" : g.missing ? "Git not found" : "Not a git repository"));
    const c = g.counts.get("") ?? [0, 0, 0], lines = g.diff.get("") ?? [0, 0], total = c[0] + c[1] + c[2];
    const upstream = b?.upstream ? (b.gone ? `${b.upstream} (gone)` : b.upstream) : b?.detached ? "" : "no upstream";
    return bar
      .child(div().min_w(0).flex_shrink(1).truncate().font_semibold().text_color(t.foreground).child(b?.detached ? `HEAD ${b.oid.slice(0, 7)}` : b?.head || "…"))
      .when(Boolean(b?.ahead), (el) => el.child(div().flex_none().text_color(t.foreground).child(`↑${b.ahead}`)))
      .when(Boolean(b?.behind), (el) => el.child(div().flex_none().text_color(t.foreground).child(`↓${b.behind}`)))
      .when(Boolean(upstream) && this.width >= 380, (el) => el.child(div().min_w(0).flex_shrink(1).truncate().text_color(t.dim).child(upstream)))
      .child(div().flex_1())
      .when(!total, (el) => el.child(div().flex_none().text_color(t.dim).child("clean")))
      .when(total > 0, (el) => el.child(this.dots(t, c)))
      .when(Boolean(lines[0] || lines[1]) && this.width >= 330, (el) => el.child(counts(t, lines[0], lines[1])));
  }

  searchBar(t) {
    const g = this.git, git = this.gitSearch();
    return subbar(t, "files-search").cursor_text().when(this.typing, (el) => el.bg(t.surface))
      .child(svg(ui("search")).size(SIZE.icon - 1).flex_none().text_color(this.typing ? t.accent : t.dim))
      .child(Input.new(this.input).flex_1().min_w(0).h_full().text_size(SIZE.text).text_color(t.foreground))
      .when(this.searching && !this.hits?.length, (el) => el.child(div().flex_none().text_size(SIZE.small).text_color(t.dim).frames(["·  ", "·· ", "···"], 260)))
      .when(Boolean(this.query), (el) => el.child(iconButton(t, "files-clear", "close", (_e, cx) => this.clearSearch(cx), { size: SIZE.button - 4 }).tooltip("Clear (Esc)")))
      .when(this.view === "all" && g.repo && !g.rootIgnored, (el) => el.child(iconButton(t, "files-source", "git-branch", (_e, cx) => this.setSource(git ? "disk" : "git", cx), { on: git, size: SIZE.button - 4 })
        .tooltip(git ? "Searching git's files (ignored ones left out). Click to search the disk" : "Searching the disk, ignored files too. Click to search git's files")));
  }

  note(rows) {
    const g = this.git;
    if (!this.root) return ["No folder", "Focus a terminal to see its files"];
    if (this.error) return ["Can't open this folder", this.error, "retry"];
    if (this.hits) {
      if (this.searchError) return ["Search failed", this.searchError, "clear"];
      if (rows.length) return null;
      return ["No matches", this.view === "changed" ? "Among the changed files" : this.index?.from === "git" ? "Ignored files are left out" : null, "clear"];
    }
    if (this.searching && !rows.length) return ["Searching…"];
    if (this.view === "changed") {
      if (!g.known) return ["Reading git…"];
      if (!g.repo) return [g.missing ? "Git not found" : "Not a git repository", null, "all"];
      if (g.failed) return ["Git can't read this folder", null, "all"];
      return rows.length ? null : g.rootUntracked ? ["This whole folder is new to git", null, "all"] : g.rootIgnored ? ["Git ignores this folder", null, "all"] : ["No changes", "The working tree is clean", "all"];
    }
    if (this.loading && !rows.length) return ["Loading…"];
    return rows.length ? null : ["Empty folder"];
  }

  noteView(t, n) {
    const [title, detail, action] = n;
    const button = action === "retry" ? textButton(t, "files-retry", "Retry", (_e, cx) => { this.error = null; this.refresh(cx); cx.notify(); }, { icon: "rotate-cw" })
      : action === "clear" ? textButton(t, "files-clear-search", "Clear search", (_e, cx) => this.clearSearch(cx))
      : action === "all" ? textButton(t, "files-show-all", "Show all files", (_e, cx) => this.setView("all", cx))
      : null;
    return empty(t, title, detail ?? null, button);
  }

  // The tree (or search results): virtual list, scrollbar, menu.
  list(t) {
    const rows = this.shown = this.rows();
    if (this.menu && !rows.some((r) => r.rel === this.menu.r.rel)) this.menu = null;
    if (this.scrollTo !== null && this.scrollTo !== undefined) {
      const key = this.hits ? `?${this.scrollTo}` : this.scrollTo;
      const at = rows.findIndex((r) => r.key === key);
      if (at >= 0) { this.scroll.scroll_to_item(at, "center"); this.scrollTo = null; }
      else if (!this.pending.size && !this.loading) this.scrollTo = null;
    }
    const n = this.note(rows), more = [];
    if (this.limited && !this.hits) more.push(`Folders show their first ${PER_FOLDER} entries`);
    if (this.hits?.length >= FIND_LIMIT) more.push(`Best ${FIND_LIMIT} matches`);
    if (this.view === "changed" && this.changedCut) more.push(`Changed shows the first ${thousands(CHANGED_LIMIT)} paths`);
    if (this.hits && this.index && !this.index.full) more.push(`Search covers the first ${this.index.cut.includes("dirs") ? `${thousands(INDEX_DIRS)} folders` : `${thousands(INDEX_PATHS)} files`}`);
    return v_flex().flex_1().min_h(0).min_w(0)
      .child(div().id("files-list").flex_1().min_h(0).relative().py(2)
        .on_mouse_down("left", (_e, cx) => { this.handle.focus(); if (this.menu) { this.menu = null; cx.notify(); } })
        .on_mouse_down("right", (e, cx) => {
          const r = this.menuFor;
          this.menuFor = null;
          if (!r) return;
          const p = e.local_position ?? { x: 20, y: 20 }, z = zoom();
          this.handle.focus();
          this.openMenu(r, { x: p.x / z, y: p.y / z });
          cx.notify();
        })
        .on_scroll_wheel((_e, cx) => { if (this.menu) { this.menu = null; cx.notify(); } })
        .on_size_change((size, cx) => { const h = size.height / zoom(); if (Math.abs(h - (this.listHeight ?? 0)) > 1) { this.listHeight = h; cx.notify(); } })
        .when(!n, (el) => el
          .child(v_virtual_list("files-rows", rows.length, ROW, (i) => rows[i]?.key ?? String(i), (range) => rows.slice(range.start, range.end).map((r) => this.treeRow(r, t)))
            .track_scroll(this.scroll).size_full()
            .on_item_click((key, cx) => {
              const r = this.shown.find((x) => x.key === key);
              this.handle.focus();
              if (this.menu) this.menu = null;
              this.activate(r, cx);
              cx.notify();
            })
            .on_item_secondary_click((key) => { this.menuFor = this.shown.find((x) => x.key === key) ?? null; }))
          .child(Scrollbar.vertical("files-rows").viewport_from_layout().absolute().inset_0()))
        .when(Boolean(n), (el) => el.child(this.noteView(t, n)))
        .when(Boolean(this.menu), (el) => el.child(this.menuView(t))))
      .when(more.length > 0, (el) => el.child(div().flex_none().px(SIZE.pad).py(4).border_t(1).border_color(t.border).text_size(SIZE.small).text_color(t.dim).child(more.join(" · "))));
  }

  // Header actions: the All/Changed switch, collapse folders, full mode.
  actions(t) {
    const changed = this.git.records;
    return [
      segmented(t, "files-view", [{ id: "all", label: "All" }, { id: "changed", label: changed ? `Changed ${changed}` : "Changed" }], this.view, (id, cx) => this.setView(id, cx)),
      iconButton(t, "files-collapse", "fold-vertical", (_e, cx) => this.collapseAll(cx), { disabled: !this.folders.size && !(this.view === "changed" && !this.hits) }).tooltip("Collapse folders"),
      this.full
        ? iconButton(t, "files-shrink", "collapse", () => closeFull()).tooltip("Back to the side panel")
        : iconButton(t, "files-expand", "expand", () => openFull("files", this.file ? { path: this.file, root: this.root, on: this.on } : null)).tooltip("Full view"),
    ];
  }

  folderName() { return this.root ? baseName(this.root) || this.root : ""; }

  // The side panel's detail page: back to the files, the file's place, open-in-app.
  detail(t) {
    const rel = this.file, local = !this.on;
    return frame(t, header(t, {
      id: "files-detail-header", back: (_e, cx) => this.closeFile(cx), backLabel: "Files",
      title: baseOf(rel), subtitle: dirOf(rel) || this.folderName(),
      actions: [
        local && iconButton(t, "files-external", "external-link", (_e, cx) => this.act("external", { rel, dir: false, name: baseOf(rel) }, cx)).tooltip("Open in default app"),
        iconButton(t, "files-detail-full", "expand", () => openFull("files", { path: rel, root: this.root, on: this.on })).tooltip("Full view"),
      ].filter(Boolean),
    }), this.preview ? div().size_full().min_h(0).min_w(0).flex().flex_col().child(this.preview) : empty(t, "Loading…"));
  }

  render(cx) {
    this.sync(cx);
    const t = theme();
    const root = (body) => body.id("files-root").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => { const w = size.width / zoom(); if (Math.abs(w - this.width) > 4) { this.width = w; cx.notify(); } });
    if (this.file && !this.wide) return root(this.detail(t));
    // Narrow, the folder's name gives way to the title and the switch.
    const top = header(t, { icon: "files", title: "Files", subtitle: this.width >= 380 || this.wide ? this.folderName() : null, actions: this.actions(t) });
    const tree = v_flex().size_full().min_w(0).min_h(0).child(this.branchBar(t)).child(this.searchBar(t)).child(this.list(t));
    if (!this.wide) return root(frame(t, top, tree));
    const side = this.file && this.preview ? div().size_full().min_w(0).min_h(0).flex().flex_col().child(this.preview)
      : empty(t, "No file open", "Pick a file on the left");
    return root(frame(t, top, h_resizable("files-split").size_full()
      .on_resize((sizes) => { if (sizes?.[0]) { this.split = Math.round(sizes[0]); setPref("split", this.split); } })
      .child(resizable_panel().size(this.split).size_range(SPLIT.min, SPLIT.max).child(div().size_full().border_r(1).border_color(t.border).child(tree)))
      .child(resizable_panel().child(side))));
  }
}
