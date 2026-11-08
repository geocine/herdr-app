// Changes: the uncommitted changes of the focused terminal's repo, in sections (Conflicts,
// Staged, Unstaged, Untracked), with stage / unstage / discard and a commit box. A file opens its
// Diff: on its own page in the side panel ("← Changes"), beside the list in full mode, where the
// list's first row shows every change at once. "Open file" in a diff shows the shared Preview.
// Herdr's own Changes panel (defaults/mods/changes) is where this started.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Popup, h_resizable, resizable_panel } from "gpui-base";
import { theme, settings, watchFolder, notify } from "herdr";
import { SIZE, ui, frame, header, subbar, row, section, iconButton, textButton, counts, badge, empty } from "../../lib/ui.js";
import { repoOf, statusColor, statusLetter } from "../../lib/git.js";
import { location, locationKey, baseName, dirName } from "../../lib/where.js";
import { iconFor } from "../../lib/icons.js";
import { openFull, closeFull, inFull } from "../../lib/nav.js";
import Diff from "../../lib/diff/index.js";
import Preview from "../../lib/preview/index.js";
import { SECTIONS, loadStatus, forgetLines, stage, unstage, stageAll, unstageAll, discard, commit } from "./status.js";

const SPLIT = { min: 220, max: 720, default: 320 };
const SHOWN = 150;   // rows drawn in all, so a render stays inside its ~50 ms
const MENU_W = 236, ITEM_H = 28;
const zoom = () => Number(settings()?.zoom) || 1;
const stop = (_e, cx) => cx.stop_propagation();
const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? c + a : c);
const pref = (key, fallback) => { try { const v = localStorage.getItem(`changes.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } };
const setPref = (key, value) => { try { localStorage.setItem(`changes.${key}`, JSON.stringify(value)); } catch {} };
const message = (e) => String(e?.message ?? e).replace(/^error: /, "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const label = (id) => SECTIONS.find(s => s.id === id)?.label ?? id;

export default class ChangesView extends View {
  init(p, cx) {
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
    this.stamp = 0; this.sig = null;
    this.hover = null; this.menu = null; this.menuFor = null; this.confirm = null;
    this.message = ""; this.typing = false; this.busy = null; this.note = null;
    this.want = this.p.start?.path ? { path: this.p.start.path, section: this.p.start.section ?? null } : null;
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
    cx.timer.every(4000, (cx) => { if (this.on || !this.watched) this.refresh(cx); });
    cx.timer.every(30000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  update(p) { this.p = p ?? {}; }
  poke() { const w = this.wake; this.wake = null; w?.(); }

  get wide() { return Boolean(this.p.wide); }
  get full() { return Boolean(this.p.full) || inFull(); }

  // ---- data ----------------------------------------------------------------

  refresh(cx, { changed = false } = {}) {
    if (this.loading) { this.again = true; this.againChanged ||= changed; return; }
    const loc = location();
    if (!loc.cwd) return;   // focus somewhere without a folder (our own panel): keep the last place
    const ctx = locationKey(loc);
    if (ctx !== this.ctx) {
      this.ctx = ctx; this.cwd = loc.cwd; this.repo = null; this.data = null; this.error = null; this.sel = null; this.page = "list";
      this.previewAt = null; this.note = null; this.watched = null; this.sig = null; this.menu = null; this.confirm = null;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const repo = await repoOf(loc.cwd, { on: loc.on });
        if (ctx !== this.ctx) return;
        if (!repo) { this.repo = null; this.data = null; this.error = "not-repo"; return; }
        const data = await loadStatus(repo.top, loc.on);
        if (ctx !== this.ctx) return;
        const sig = JSON.stringify([repo.head, Object.values(data.sections).map(l => l.map(e => [e.path, e.status, e.adds, e.dels]))]);
        if (sig !== this.sig || changed) this.stamp++;
        this.sig = sig; this.repo = repo; this.on = loc.on; this.data = data; this.error = null;
        this.fixSelection();
        this.syncDetail(cx);
        this.watch(repo.top, cx);
      } catch (e) {
        if (ctx === this.ctx) this.error = message(e);
      } finally {
        this.loading = false;
        if (this.again) { const c = this.againChanged; this.again = false; this.againChanged = false; this.refresh(cx, { changed: c }); }
        cx.notify();
      }
    });
  }

  watch(top, cx) {
    if (this.on || this.watched === top) return;
    this.watched = top;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === top) {
          const paths = await watchFolder(top);
          if (this.watched !== top) break;
          forgetLines(paths);
          // A burst of writes (a build, a checkout) is one refresh.
          if (this.settling) continue;
          this.settling = true;
          cx.timer.after(250, (cx) => { this.settling = false; this.refresh(cx, { changed: true }); });
        }
      } catch { if (this.watched === top) this.watched = null; }
    });
  }

  entries(sectionId) { return this.data?.sections[sectionId] ?? []; }
  allEntries() { return SECTIONS.flatMap(s => this.entries(s.id)); }
  find(sel) { return sel && sel !== "all" ? this.entries(sel.section).find(e => e.path === sel.path) ?? null : null; }
  count() { return this.allEntries().length; }

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
    const base = { on: this.on, top: this.repo.top, stamp: this.stamp, onOpenFile: (path, rev) => this.openFile(path, rev) };
    if (this.sel === "all") return { ...base, source: { kind: "head" } };
    const kind = this.sel.section === "conflicts" ? "unstaged" : this.sel.section;
    return { ...base, source: { kind }, paths: [this.sel.path] };
  }

  previewProps() {
    if (!this.repo || !this.previewAt) return null;
    return { on: this.on, root: this.repo.top, path: this.previewAt.path, rev: this.previewAt.rev, repoTop: this.repo.top, wide: this.wide };
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
  flat() {
    const out = this.wide && this.count() ? ["all"] : [];
    for (const s of SECTIONS) if (!this.folded.has(s.id)) for (const e of this.entries(s.id)) if (out.length < SHOWN) out.push({ section: s.id, path: e.path });
    return out;
  }
  same(a, b) { return a === b || (a && b && a !== "all" && b !== "all" && a.section === b.section && a.path === b.path); }

  move(delta, cx) {
    const rows = this.flat();
    if (!rows.length) return;
    const at = rows.findIndex(r => this.same(r, this.sel));
    const next = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? (delta > 0 ? 0 : rows.length - 1) : at + delta))];
    this.select(next, cx, { open: false });
  }

  key(e, cx) {
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
      finally { this.busy = null; this.refresh(cx, { changed: true }); cx.notify(); }
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
      detail: untracked ? "The file is not in git: it is gone for good." : staged ? "Staged and unstaged changes go back to the last commit. This can't be undone." : "Your edits go back to what is staged or committed. This can't be undone.",
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

  runMenu(id, e, cx) {
    this.menu = null;
    const sel = { section: e.section, path: e.path };
    if (id === "diff") this.select(sel, cx);
    else if (id === "open") { this.sel = sel; this.openFile(e.path, e.section === "staged" && e.status === "D" ? "HEAD" : null); this.syncDetail(cx); }
    else if (id === "stage" || id === "unstage") this.toggleStage(e, cx);
    else if (id === "discard") this.askDiscard([e], cx);
    else if (id === "copy") cx.write_to_clipboard(e.path);
    else if (id === "copyabs") cx.write_to_clipboard(`${this.repo.top}/${e.path}`);
    cx.notify();
  }

  // ---- drawing -------------------------------------------------------------

  entryRow(t, e) {
    const sel = { section: e.section, path: e.path }, id = `changes-row-${e.section}-${e.path}`, hovered = this.hover === id;
    const name = baseName(e.path), dir = dirName(e.path), selected = this.same(this.sel, sel) && (this.wide || this.page === "list");
    const small = (bid, icon, tip, fn) => iconButton(t, `${id}-${bid}`, icon, (_ev, cx) => fn(cx), { size: 20 }).tooltip(tip);
    return row(t, id, { selected, onClick: (_ev, cx) => { this.typing = false; this.handle.focus(); this.select(sel, cx); } })
      .on_hover((on, cx) => { if (on) this.hover = id; else if (this.hover === id) this.hover = null; cx.notify(); })
      .on_mouse_down("right", () => { this.menuFor = e; })
      .child(image(iconFor(e.path)).size(SIZE.icon).flex_none())
      .child(h_flex().flex_1().min_w(0).gap(6).items_center().overflow_hidden()
        .child(div().min_w(0).flex_shrink_1().truncate().text_color(e.status === "D" ? t.muted : t.foreground).when(e.status === "D", el => el.line_through()).child(name))
        .when(Boolean(dir), el => el.child(div().min_w(0).flex_shrink(100).truncate().text_size(SIZE.small).text_color(t.dim).child(dir))))
      .when(hovered && !this.busy, el => el.child(h_flex().flex_none().gap(1)
        .child(small("open", "file-text", "Open file", (cx) => { this.sel = sel; this.openFile(e.path, e.section === "staged" && e.status === "D" ? "HEAD" : null); this.syncDetail(cx); }))
        .when(e.section !== "conflicts", el => el.child(small("discard", "undo-2", e.section === "untracked" ? "Delete" : "Discard changes", (cx) => this.askDiscard([e], cx))))
        .child(e.section === "staged" ? small("unstage", "minus", "Unstage", (cx) => this.toggleStage(e, cx)) : small("stage", "plus", "Stage", (cx) => this.toggleStage(e, cx)))))
      .when(!hovered || this.busy, el => el.child(e.binary ? div().flex_none().text_size(SIZE.small).text_color(t.dim).child("bin") : counts(t, e.adds, e.dels)))
      .child(badge(t, statusLetter(e.status), statusColor(t, e.status)).text_center());
  }

  sectionView(t, s) {
    const list = this.entries(s.id);
    if (!list.length) return null;
    const open = !this.folded.has(s.id);
    const btn = (bid, icon, tip, fn) => iconButton(t, `changes-sec-${s.id}-${bid}`, icon, (_e, cx) => fn(cx), { size: 20, disabled: Boolean(this.busy) }).tooltip(tip);
    const actions = s.id === "staged" ? [btn("unstage", "minus", "Unstage all", (cx) => this.act("unstage", (top, on, head) => unstageAll(top, on, head), cx))]
      : s.id === "unstaged" ? [btn("discard", "undo-2", "Discard all", (cx) => this.askDiscard(list, cx, `all ${plural(list.length, "unstaged change")}`)), btn("stage", "plus", "Stage all", (cx) => this.act("stage", (top, on) => stage(list, top, on), cx))]
      : s.id === "untracked" ? [btn("discard", "undo-2", "Delete all", (cx) => this.askDiscard(list, cx)), btn("stage", "plus", "Stage all", (cx) => this.act("stage", (top, on) => stage(list, top, on), cx))]
      : [btn("stage", "plus", "Mark all resolved", (cx) => this.act("stage", (top, on) => stage(list, top, on), cx))];
    const head = section(t, `changes-sec-${s.id}`, s.label, {
      count: list.length, open, actions,
      onToggle: (_e, cx) => { open ? this.folded.add(s.id) : this.folded.delete(s.id); setPref("folded", [...this.folded]); cx.notify(); },
    }).mt(4).when(s.id === "conflicts", el => el.text_color(t.ansi1));
    // A render has ~50 ms: rows are drawn up to a budget shared by the sections.
    const shown = open ? list.slice(0, Math.max(0, this.budget)) : [];
    this.budget -= shown.length;
    const rest = open ? list.length - shown.length : 0;
    return v_flex().w_full().flex_none().child(head)
      .children(shown.map(e => this.entryRow(t, e)))
      .when(rest > 0, el => el.child(div().px(SIZE.pad).h(SIZE.row).flex().items_center().text_size(SIZE.small).text_color(t.dim)
        .child(`${rest} more not listed${this.wide ? "" : " · full mode shows the diff of all"}`)));
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

  allRow(t) {
    const list = this.allEntries(), adds = list.reduce((a, e) => a + e.adds, 0), dels = list.reduce((a, e) => a + e.dels, 0);
    return row(t, "changes-all", { selected: this.sel === "all", onClick: (_e, cx) => { this.typing = false; this.handle.focus(); this.select("all", cx); } })
      .child(svg(ui("changes")).size(SIZE.icon).flex_none().text_color(t.accent))
      .child(div().flex_1().min_w(0).truncate().font_medium().child("All changes"))
      .child(counts(t, adds, dels))
      .child(div().w(14).flex_none());
  }

  list(t) {
    if (this.error === "not-repo") return empty(t, "Not a git repository", this.cwd, textButton(t, "changes-retry", "Refresh", (_e, cx) => this.refresh(cx), { icon: "rotate-cw" }));
    if (!this.data) {
      if (this.error) return empty(t, "Can't read the changes", this.error, textButton(t, "changes-retry", "Retry", (_e, cx) => this.refresh(cx), { icon: "rotate-cw" }));
      return empty(t, this.ctx ? "Reading changes…" : "No folder", this.ctx ? null : "Focus a terminal to see its repo's changes");
    }
    if (!this.count()) {
      return v_flex().size_full()
        .child(empty(t, "No changes", this.note && !this.note.error ? `${this.note.text} · working tree clean` : `Working tree clean${this.repo?.branch ? ` on ${this.repo.branch}` : ""}`));
    }
    return v_flex().id("changes-list-wrap").flex_1().min_h(0).w_full().relative()
      .on_mouse_down("right", (e, cx) => {
        if (!this.menuFor) return;
        const at = e.local_position ?? { x: 20, y: 20 };
        this.menu = { e: this.menuFor, x: at.x / zoom(), y: at.y / zoom() };
        this.menuFor = null; cx.notify();
      })
      .child(this.commitBox(t))
      .child(v_flex().id("changes-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar()
        .when(this.wide, el => el.child(this.allRow(t).mt(4)))
        .map(el => { this.budget = SHOWN; return el.children(SECTIONS.map(s => this.sectionView(t, s)).filter(Boolean)); })
        .when(Boolean(this.data.cut), el => el.child(div().px(SIZE.pad).py(4).text_size(SIZE.small).text_color(t.dim).child(`Showing the first ${this.data.total} changes`))))
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
    if (locationKey() !== this.ctx && location().cwd) this.refresh(cx);
    const t = theme();
    const root = (body) => div().id("changes-root").size_full().min_w(0).min_h(0).relative().flex().flex_col()
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", (_e, cx) => { if (this.typing) { this.typing = false; cx.notify(); } this.handle.focus(); })
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
