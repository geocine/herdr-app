// The Diff component: a source's files stacked, each with a header (viewed check, icon, path,
// counts, status, open file, fold), hunks with old and new line numbers, tinted lines, word-level
// changes and cheap syntax colors. A virtual list, so big diffs scroll as small ones do.
// The look and the interactions (sticky file header, header press zones, fold menu, viewed marks,
// sideways wheel, ligature-safe spans) are ported from JinJieBeWater/herdr-t3
// `extras/mods/review` diff.js, controls.js, keys.js and main.js (Apache-2.0), fed by plain git
// instead of its daemon. See NOTICE.md.
//
// Props: { on, top, source: { kind, rev? }, paths?, split?, onOpenFile?(path, rev), stamp? }
// (stamp: any value; a new one reloads, for views that know the files changed).
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { theme, settings, shared, setShared } from "herdr";
import { SIZE, ui, monoFont, empty, textButton, iconButton, counts, badge, subbar } from "../ui.js";
import { statusColor, statusLetter } from "../git.js";
import { iconFor } from "../icons.js";
import { loadDiff } from "./parse.js";
import { buildItems, expandTabs, ROW, FILE, CHAR, MAX_COLUMNS, LARGE } from "./rows.js";
import { tokenize, langOf } from "./syntax.js";

// Viewed marks are shared state, so the side panel and full mode (two mod copies) agree.
const VIEWED = "geocine.diff.viewed", SPLIT = "diff.split";
const SPLIT_MIN = 640;   // narrower, a split diff is drawn unified (the choice is kept)
const KEEP_VIEWED = 1000;
let instances = 0;

const zoom = () => Number(settings()?.zoom) || 1;
// A theme color with an alpha byte (theme colors are #rrggbb; others are used as they are).
const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? c + a : c);
const stop = (_e, cx) => cx.stop_propagation();

function readStore(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

// The file's text after the change (its blob), what a viewed mark is for.
const blobOf = (f) => (f.newSha ?? (f.oldSha ? `${f.oldSha}:D` : `${f.status}:${f.adds}:${f.dels}`));

// Spaces that end a run are drawn into a following ligature (` =>` shows as `)⇒`): each run's
// trailing spaces lead the next run instead, where they keep their width. (t3's spans.)
function spans(runs) {
  const out = [];
  let carry = "";
  for (const [text, cls, hot] of runs) {
    const t = carry + text, body = t.trimEnd();
    carry = t.slice(body.length);
    if (body) out.push([body, cls, hot]);
  }
  return out;
}

// A line's runs: [text, class, changed], syntax split at the word-change range. Cached on the line.
function segments(line, lang) {
  if (line.seg) return line.seg;
  let text = expandTabs(line.text);
  let cut = false;
  if (text.length > MAX_COLUMNS) { text = text.slice(0, MAX_COLUMNS); cut = true; }
  const [a, b] = line.range ?? [-1, -1], out = [];
  for (const [s, e, cls] of tokenize(text, lang)) {
    const cuts = [s, ...[a, b].filter(x => x > s && x < e), e];
    for (let k = 0; k < cuts.length - 1; k++) out.push([text.slice(cuts[k], cuts[k + 1]), cls, cuts[k] >= a && cuts[k] < b]);
  }
  if (cut) out.push(["…", "c", false]);
  line.seg = spans(out);
  return line.seg;
}

export default class Diff extends View {
  init(p, cx) {
    this.p = p ?? {};
    this.uid = `diff${++instances}`;
    this.files = null; this.error = null; this.loading = false; this.loadId = 0; this.key = null;
    this.collapsed = new Set(); this.expanded = new Set();
    this.splitPref = readStore(SPLIT, null);
    this.scroll = VirtualListScrollHandle.new();
    this.handle = cx.focus_handle();
    this.width = 600; this.height = 400; this.shift = 0; this.visible = null; this.frames = 0;
    this.version = 0; this.menu = null; this.current = null; this.pressX = 0; this.pressY = 0;
    this.load(cx);
    // Scrolling redraws only the list; the sticky header above it follows the range it drew.
    cx.timer.every(150, (cx) => {
      const sticky = this.stickyFile()?.path ?? null;
      if (sticky !== this.lastSticky) { this.lastSticky = sticky; cx.notify(); }
    });
  }

  update(p) { this.p = p ?? {}; }

  sourceKey() {
    const { on = null, top = null, source = null, paths = null, stamp = null } = this.p;
    return JSON.stringify([on, top, source, paths, stamp]);
  }

  load(cx) {
    const key = this.sourceKey(), id = ++this.loadId, { on = null, top, source, paths } = this.p;
    // Another source (not just a reload of the same one): start from the top, without the old files.
    const base = JSON.stringify([on, top, source, paths]), fresh = base !== this.baseKey;
    if (fresh) {
      if (this.baseKey && JSON.parse(this.baseKey)[1] !== top) { this.collapsed.clear(); this.expanded.clear(); }
      this.files = null; this.error = null; this.shift = 0; this.version++;
      this.scroll.scroll_to_item(0);
    }
    this.key = key; this.baseKey = base; this.loading = true;
    if (!top || !source) { this.files = []; this.loading = false; return; }
    cx.spawn(async (cx) => {
      try {
        const files = await loadDiff({ on, top, source, paths });
        if (id !== this.loadId) return;
        const multi = files.length > 1;
        const old = new Map((this.files ?? []).map(f => [f.path, f]));
        for (const f of files) {
          f.large = multi && f.adds + f.dels > LARGE;
          // A reload keeps a large file shown when its diff is the same.
          if (old.get(f.path)?.shown && old.get(f.path).newSha === f.newSha) f.shown = true;
        }
        if (this.files && files.length !== this.files.length) this.shift = 0;
        this.files = files; this.more = files.more ?? 0; this.error = null;
      } catch (e) {
        if (id !== this.loadId) return;
        this.error = String(e?.message ?? e);
        if (fresh) this.files = null;
      } finally {
        if (id === this.loadId) { this.loading = false; this.version++; cx.notify(); }
      }
    });
  }

  // ---- state ---------------------------------------------------------------

  viewKey(f) { return `${this.p.on ?? ""}|${this.p.top}|${f.path}`; }
  // "viewed", "changed" (viewed, then changed), or "none".
  viewed() { const v = shared(VIEWED); return v && typeof v === "object" ? v : {}; }
  viewState(f) {
    const v = this.viewed()[this.viewKey(f)];
    return v === undefined ? "none" : v === blobOf(f) ? "viewed" : "changed";
  }
  isOpen(f) {
    if (this.expanded.has(f.path)) return true;
    if (this.collapsed.has(f.path)) return false;
    return this.viewState(f) !== "viewed";
  }
  setOpen(f, open) {
    if (open) { this.expanded.add(f.path); this.collapsed.delete(f.path); }
    else { this.collapsed.add(f.path); this.expanded.delete(f.path); }
    this.version++;
  }
  setViewed(f, on) {
    const key = this.viewKey(f);
    const viewed = { ...this.viewed() };
    delete viewed[key];
    if (on) viewed[key] = blobOf(f);
    const keys = Object.keys(viewed);
    if (keys.length > KEEP_VIEWED) for (const k of keys.slice(0, keys.length - KEEP_VIEWED)) delete viewed[k];
    setShared(VIEWED, viewed);
    this.setOpen(f, !on);
  }
  fold(kind, cx) {
    const anchor = this.stickyFile() ?? this.topFile();
    for (const f of this.files ?? []) {
      if (kind === "expand") this.setOpen(f, true);
      else if (kind === "collapse") this.setOpen(f, false);
      else if (kind === "viewed" && this.viewState(f) === "viewed") this.setOpen(f, false);
    }
    this.menu = null;
    // The file at the top stays there, as folding the bodies above it would carry the view elsewhere.
    if (anchor) { const at = this.items().findIndex(i => i.kind === "file" && i.file === anchor); if (at >= 0) this.scrollToTop(at, cx); }
    cx.notify();
  }

  splitShown() {
    const want = this.splitPref ?? this.p.split ?? false;
    return Boolean(want) && this.width >= SPLIT_MIN;
  }
  toggleSplit(cx) {
    this.splitPref = !this.splitShown();
    writeStore(SPLIT, this.splitPref);
    this.shift = 0; this.version++; cx.notify();
  }

  items() {
    // Marks set in another copy (full mode, the side panel) refold the files here too.
    const marks = shared(VIEWED);
    if (marks !== this.marks) { this.marks = marks; this.version++; }
    const split = this.splitShown(), id = `${this.version}:${split}`;
    if (id !== this.itemsId) {
      this.itemsId = id; this.visible = null;
      const built = buildItems(this.files ?? [], { open: (f) => this.isOpen(f), split });
      this.itemList = built.items; this.most = built.most; this.digits = built.digits;
      this.byKey = new Map(this.itemList.map(i => [i.key, i]));
    }
    return this.itemList;
  }

  numberWidth() { return Math.max(26, Math.ceil(this.digits * CHAR) + 12); }
  // Where code starts in a row, past the numbers and the sign.
  inset(split) { return (split ? 1 : 2) * this.numberWidth() + 14; }
  maxShift() {
    const split = this.splitShown();
    if (split) return Math.max(0, Math.max(this.most[1], this.most[2], this.most[0]) * CHAR + 24 - (this.width / 2 - this.inset(true)));
    return Math.max(0, this.most[0] * CHAR + 24 - (this.width - this.inset(false)));
  }

  // The blank after the list, so the last file's header can still reach the top.
  trailing() {
    const items = this.items();
    let top = 0, last = 0;
    for (const item of items) { if (item.kind === "file") last = top; top += item.size; }
    return Math.max(0, Math.ceil(this.height - (top - last)));
  }

  // The file whose lines open the view once its header has scrolled past the top.
  stickyFile() {
    const item = (this.itemList ?? [])[this.visible?.start ?? 0];
    return item && item.kind !== "file" ? item.file : null;
  }
  topFile() { return (this.itemList ?? [])[this.visible?.start ?? 0]?.file ?? null; }

  /**
   * Brings an item's top to the list's top. The list scrolls only to the near edge, so for an item
   * below the view, first bottom-align the item a view's height past it, then, once that frame is
   * drawn, scroll to it (now above): its top lands at the top. (t3's scrollToTop.)
   */
  scrollToTop(index, cx) {
    const sizes = [...this.items().map(i => i.size), this.trailing()], start = this.visible?.start ?? 0;
    const token = this.settling = {};
    if (index <= start) return this.scroll.scroll_to_item(index);
    let last = index, height = sizes[index];
    while (height <= this.height + 1 && last + 1 < sizes.length) height += sizes[++last];
    this.scroll.scroll_to_item(last);
    const drawn = this.frames;
    let tries = 0;
    const settle = (cx) => {
      if (this.settling !== token) return;
      if (this.frames > drawn) { this.scroll.scroll_to_item(index); cx.notify(); }
      else if (++tries < 30) cx.timer.after(8, settle);
    };
    cx.timer.after(8, settle);
  }

  step(delta, cx) {
    const files = this.files ?? [];
    if (!files.length) return;
    const now = files.indexOf(this.stickyFile() ?? this.topFile());
    const next = files[Math.min(files.length - 1, Math.max(0, (now < 0 ? 0 : now) + delta))];
    const at = this.items().findIndex(i => i.kind === "file" && i.file === next);
    this.current = next.path;
    if (at >= 0) this.scrollToTop(at, cx);
    cx.notify();
  }

  currentFile() {
    return (this.files ?? []).find(f => f.path === this.current) ?? this.stickyFile() ?? this.topFile();
  }

  revFor(f) {
    const kind = this.p.source?.kind;
    if (kind === "commit") return f.status === "D" ? `${this.p.source.rev}^` : this.p.source.rev;
    return f.status === "D" ? "HEAD" : null;
  }

  // A press on a file's header, placed by x as fileHeader() lays it out: the viewed box at the
  // start (8 in, 16 wide), the fold and open-file slots at the end (20 wide, 4 apart, 8 in).
  headerPress(f, x, cx) {
    const fromEnd = this.width - x;
    this.current = f.path;
    if (x < 30) this.setViewed(f, this.viewState(f) !== "viewed");
    else if (fromEnd > 30 && fromEnd <= 54 && this.p.onOpenFile) { this.p.onOpenFile(f.path, this.revFor(f)); return; }
    else this.setOpen(f, !this.isOpen(f));
    cx.notify();
  }

  key(e, cx) {
    if (this.menu && e.key === "escape") { this.menu = null; cx.stop_propagation(); cx.notify(); return; }
    const ks = e.keystroke ?? e.key;
    const f = () => this.currentFile();
    const actions = {
      j: () => this.step(1, cx), k: () => this.step(-1, cx),
      n: () => this.step(1, cx), p: () => this.step(-1, cx),
      c: () => { const x = f(); if (x) { this.setOpen(x, !this.isOpen(x)); cx.notify(); } },
      v: () => { const x = f(); if (x) { this.setViewed(x, this.viewState(x) !== "viewed"); cx.notify(); } },
      s: () => { if (this.width >= SPLIT_MIN) this.toggleSplit(cx); },
      o: () => { const x = f(); if (x && this.p.onOpenFile) this.p.onOpenFile(x.path, this.revFor(x)); },
    };
    const action = actions[ks];
    if (action) { action(); cx.stop_propagation(); }
  }

  // ---- drawing -------------------------------------------------------------

  checkMark(t, state) {
    const fill = state === "viewed" ? t.accent : state === "changed" ? t.ansi3 : null;
    return div().size(16).flex_none().rounded(4).border_1().border_color(fill ?? t.input ?? t.border).bg(fill ?? t.surface)
      .flex().items_center().justify_center().text_color(t.accent_foreground ?? t.background)
      .when(state === "viewed", el => el.child(svg(ui("check")).size(12)))
      .when(state === "changed", el => el.child(svg(ui("minus")).size(12)));
  }

  fileHeader(t, f, sticky = false) {
    const open = this.isOpen(f), state = this.viewState(f), parts = f.path.split("/"), name = parts.pop(), dir = parts.join("/");
    const slot = () => div().size(20).flex_none().flex().items_center().justify_center().rounded(4);
    const color = statusColor(t, f.untracked ? "?" : f.status);
    return h_flex().w_full().h(FILE).flex_none().pl(8).pr(8).gap(6).items_center().bg(this.current === f.path ? t.raised : t.chrome)
      .border_b(1).border_color(t.border).when(!sticky, el => el.border_t(1)).text_size(SIZE.text)
      .child(this.checkMark(t, state))
      .child(image(iconFor(f.path)).size(SIZE.icon).flex_none().ml(2))
      .child(h_flex().flex_1().min_w(0).gap(0).items_center().overflow_hidden()
        .when(Boolean(dir), el => el.child(div().min_w(0).flex_shrink(100).truncate().text_color(t.dim).child(`${dir}/`)))
        .child(div().min_w(0).flex_shrink_1().truncate().font_medium().text_color(state === "viewed" ? t.muted : t.foreground).child(name))
        .when(Boolean(f.oldPath) && f.oldPath !== f.path, el => el.child(div().min_w(0).flex_shrink(200).truncate().pl(6).text_size(SIZE.small).text_color(t.dim).child(`← ${f.oldPath}`))))
      .when(state === "changed", el => el.child(div().flex_none().text_size(SIZE.small).text_color(t.ansi3).child("changed")))
      .when(f.binary, el => el.child(div().flex_none().text_size(SIZE.small).text_color(t.dim).child("binary")))
      .when(!f.binary, el => el.child(counts(t, f.adds, f.dels)))
      .child(badge(t, statusLetter(f.untracked ? "?" : f.status), color).text_center())
      .child(h_flex().flex_none().gap(4)
        .child(slot().when(Boolean(this.p.onOpenFile), el => el.text_color(t.dim).child(svg(ui("file-text")).size(13))))
        .child(slot().text_color(t.dim).child(svg(ui(open ? "chevron-down" : "chevron-right")).size(14))));
  }

  code(t, line, numbers, lang, font, shift) {
    if (!line) return div().flex_1().min_w(0).h_full().bg(t.canvas ?? t.surface);
    const add = line.kind === "add", del = line.kind === "del", meta = line.kind === "meta";
    const base = add ? t.ansi2 : del ? t.ansi1 : null;
    const tint = base ? alpha(base, "1a") : null, gutter = base ? alpha(base, "2a") : null, hot = base ? alpha(base, "4d") : null;
    const colors = { k: t.ansi5, s: t.ansi3, n: t.ansi6, c: t.dim, f: t.ansi4, t: t.ansi6, p: t.muted };
    const w = this.numberWidth();
    return h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden().font_family(font).when(Boolean(tint), el => el.bg(tint))
      .children(numbers.map(n => div().w(w).h_full().flex_none().pr(6).flex().items_center().justify_end().text_color(base ?? t.dim).opacity(base ? 0.85 : 0.7)
        .when(Boolean(gutter), el => el.bg(gutter)).child(n === null || n === undefined ? "" : String(n))))
      .child(div().w(14).flex_none().text_center().text_color(base ?? t.dim).child(add ? "+" : del ? "−" : ""))
      .child(h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden().whitespace_nowrap()
        .child(meta
          ? div().flex_none().text_color(t.dim).italic().child(line.text.replace(/^\\ /, ""))
          : h_flex().flex_none().relative().left(-shift)
            .children(segments(line, lang).map(([text, cls, isHot]) => div().flex_none().text_color(cls ? colors[cls] ?? t.foreground : t.foreground)
              .when(isHot && Boolean(hot), el => el.bg(hot).rounded(2)).child(text)))));
  }

  item(t, item, font, shift) {
    switch (item.kind) {
      case "file": return this.fileHeader(t, item.file);
      case "hunk": {
        const h = item.hunk, range = `@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
        return h_flex().w_full().h(item.size).pl(8).pr(8).gap(8).items_center().bg(alpha(t.ansi4, "12")).font_family(font).text_size(SIZE.small).overflow_hidden()
          .child(div().flex_none().text_color(t.ansi4).opacity(0.8).child(range))
          .when(Boolean(h.context), el => el.child(div().min_w(0).truncate().text_color(t.muted).child(h.context)));
      }
      case "note":
        return h_flex().w_full().h(item.size).px(SIZE.pad).gap(6).items_center().text_size(SIZE.small).border_b(1).border_color(t.border)
          .text_color(item.action ? t.accent : t.dim).when(Boolean(item.action), el => el.cursor_pointer())
          .child(div().w(this.inset(false) - SIZE.pad).flex_none())
          .child(item.text);
      case "pairs": {
        const lang = langOf(item.file.path);
        return v_flex().w_full().h(item.size).children(item.lines.map(pair => h_flex().w_full().h(ROW)
          .child(this.code(t, pair.left, [pair.left?.old], lang, font, shift))
          .child(div().w(1).h_full().flex_none().bg(t.border))
          .child(this.code(t, pair.right, [pair.right?.new], lang, font, shift))));
      }
      default: {
        const lang = langOf(item.file.path), solo = item.kind === "solo";
        return v_flex().w_full().h(item.size).children(item.lines.map(line => h_flex().w_full().h(ROW)
          .child(this.code(t, line, solo ? [line.kind === "del" ? line.old : line.new] : [line.old, line.new], lang, font, shift))));
      }
    }
  }

  foldMenu(t) {
    const entries = [
      { id: "expand", label: "Expand all files", icon: "unfold-vertical" },
      { id: "collapse", label: "Collapse all files", icon: "fold-vertical" },
      { id: "viewed", label: "Collapse viewed files", icon: "square-check" },
    ];
    return v_flex().id(`${this.uid}-fold-menu`).absolute().top(SIZE.subheader + 2).right(SIZE.pad).min_w(190).p(4).gap(1)
      .rounded(SIZE.card).bg(t.popover).border_1().border_color(t.border).shadow_lg().text_size(SIZE.text)
      .on_mouse_down("left", stop).on_scroll_wheel(stop)
      .on_mouse_down_out((_e, cx) => { this.menu = null; this.menuClosedAt = Date.now(); cx.notify(); })
      .children(entries.map(e => h_flex().id(`${this.uid}-fold-${e.id}`).h(SIZE.row + 4).px(8).gap(8).items_center().rounded(SIZE.radius - 2)
        .cursor_pointer().hover(s => s.bg(t.hover)).on_click((_ev, cx) => this.fold(e.id, cx))
        .child(svg(ui(e.icon)).size(SIZE.icon).flex_none().text_color(t.muted)).child(e.label)));
  }

  toolbar(t) {
    const files = this.files ?? [], adds = files.reduce((n, f) => n + f.adds, 0), dels = files.reduce((n, f) => n + f.dels, 0);
    const viewed = files.filter(f => this.viewState(f) === "viewed").length, split = this.splitShown();
    return subbar(t, `${this.uid}-bar`).bg(t.background)
      .child(div().text_size(SIZE.small).text_color(t.muted).child(`${files.length} ${files.length === 1 ? "file" : "files"}`))
      .child(counts(t, adds, dels))
      .when(viewed > 0, el => el.child(div().text_size(SIZE.small).text_color(t.dim).child(`· ${viewed} viewed`)))
      .when(this.loading, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.dim).spin(900)))
      .child(div().flex_1())
      .when(this.width >= SPLIT_MIN, el => el.child(iconButton(t, `${this.uid}-split`, split ? "rows-2" : "columns-2", (_e, cx) => this.toggleSplit(cx), { on: split })))
      .child(iconButton(t, `${this.uid}-fold`, "chevrons-down-up", (_e, cx) => {
        if (this.menu) this.menu = null;
        else if (Date.now() - (this.menuClosedAt ?? 0) > 250) this.menu = "fold";
        cx.notify();
      }, { on: this.menu === "fold" }));
  }

  render(cx) {
    if (this.sourceKey() !== this.key) this.load(cx);
    const t = theme(), font = monoFont(settings());
    if (this.files === null) {
      return v_flex().size_full().min_h(0).bg(t.background).child(this.error
        ? empty(t, "Can't read this diff", this.error, textButton(t, `${this.uid}-retry`, "Retry", (_e, cx) => this.load(cx), { icon: "rotate-cw" }))
        : empty(t, "Loading diff…"));
    }
    if (!this.files.length) {
      return v_flex().size_full().min_h(0).bg(t.background).child(this.error
        ? empty(t, "Can't read this diff", this.error, textButton(t, `${this.uid}-retry`, "Retry", (_e, cx) => this.load(cx), { icon: "rotate-cw" }))
        : empty(t, this.loading ? "Loading diff…" : "No changes", this.loading ? null : "Nothing differs here."));
    }
    const items = this.items(), sticky = this.stickyFile(), shift = Math.min(this.shift, this.maxShift());
    const sizes = [...items.map(i => i.size), this.trailing()];
    const listId = `${this.uid}-list`;
    const showBar = this.files.length > 1 || this.width >= SPLIT_MIN;
    return v_flex().id(this.uid).size_full().min_h(0).min_w(0).relative().bg(t.background).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .when(showBar, el => el.child(this.toolbar(t)))
      .when(Boolean(this.error), el => el.child(h_flex().flex_none().px(SIZE.pad).py(4).gap(8).bg(alpha(t.ansi1, "18")).text_color(t.ansi1).text_size(SIZE.small)
        .child(div().flex_1().min_w(0).truncate().child(this.error))))
      .child(div().id(`${this.uid}-area`).flex_1().min_h(0).min_w(0).relative().overflow_hidden().text_size(SIZE.mono)
        .on_size_change((size, cx) => {
          const w = size.width / zoom(), h = size.height / zoom();
          if (Math.abs(w - this.width) >= 1 || Math.abs(h - this.height) >= 1) { this.width = w; this.height = h; cx.notify(); }
        })
        .on_scroll_wheel((e, cx) => {
          const dx = (e.delta?.x ?? 0) / zoom();
          if (!dx) return;
          const x = Math.min(this.maxShift(), Math.max(0, this.shift - dx));
          if (x !== this.shift) { this.shift = x; cx.notify(); }
        })
        .on_mouse_down("left", (e) => { this.pressX = (e.local_position?.x ?? 0) / zoom(); this.pressY = (e.local_position?.y ?? 0) / zoom(); })
        .child(v_virtual_list(listId, items.length + 1, sizes, (i) => items[i]?.key ?? "end", (range) => {
          this.visible = range; this.frames++;
          const out = [];
          for (let i = range.start; i < range.end; i++) out.push(items[i] ? this.item(t, items[i], font, shift) : div().w_full().h(sizes[i]));
          return out;
        }).track_scroll(this.scroll).size_full()
          .on_item_click((key, cx) => {
            // A press on the sticky header lands on the row under it too: the header has it.
            if (sticky && this.pressY < FILE) return;
            const item = this.byKey.get(key);
            if (!item) return;
            if (item.kind === "file") return this.headerPress(item.file, this.pressX, cx);
            if (item.kind === "note" && item.action === "show") { item.file.shown = true; this.version++; cx.notify(); return; }
            this.current = item.file?.path ?? this.current;
          }))
        .when(Boolean(sticky), el => el.child(div().id(`${this.uid}-sticky`).absolute().top(0).left(0).w_full().shadow_sm()
          .on_click((_e, cx) => {
            const open = this.isOpen(sticky);
            this.headerPress(sticky, this.pressX, cx);
            // Folded from its stuck header, the file's header comes back to the top.
            if (open && !this.isOpen(sticky)) { const at = this.items().findIndex(i => i.kind === "file" && i.file === sticky); if (at >= 0) this.scroll.scroll_to_item(at); }
          })
          .child(this.fileHeader(t, sticky, true))))
        .child(Scrollbar.vertical(listId).absolute().inset_0())
        .when(this.more > 0, el => el.child(div().absolute().bottom(6).left(SIZE.pad).px(8).py(2).rounded(SIZE.radius).bg(t.popover).border_1().border_color(t.border)
          .text_size(SIZE.small).text_color(t.muted).child(`${this.more} more untracked files not shown`))))
      .when(this.menu === "fold", el => el.child(this.foldMenu(t)));
  }
}
