// The Preview: one file, read-only, as the Geocine views show it. Markdown is rendered (prose in
// TextView, fences in highlighted readonly Editors with a header and Copy, Mermaid as images),
// code is highlighted with gutter marks of its changes against HEAD, images are drawn, binary
// files and files past 1 MB say so. It follows the file live (watchFolder here, polling on
// another machine), finds in the document and zooms. With `rev` it shows the file at that commit.
//
// Mount: cx.new(Preview, { on, root, path, rev, repoTop, wide, onOpen }); update: entity.set_props().
// Ported from bohumil/herdr-file-preview (MIT) and made to work on Windows. See NOTICE.md.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Scrollbar, InputState, Input } from "gpui-base";
import { theme, settings, watchFolder, exec, readTextFile, writeTextFile } from "herdr";
import { SIZE, iconButton, textButton, empty, ui, ago } from "../ui.js";
import { iconFor } from "../icons.js";
import { slash, dirName, baseName } from "../where.js";
import * as lang from "./lang.js";
import { readDoc, stamp, LIMIT, mb, fnv1a, isWindows } from "./source.js";
import { segment, splitQuotes, splitPictures } from "./markdown.js";
import * as git from "./marks.js";
import { Mermaid, cacheKey, config as mermaidConfig } from "./mermaid.js";
import { occurrences, positions, markMatches, syntaxMask, headings, section } from "./find.js";
import * as blm from "./blame.js";
import { Zoom, zoomKey, ZOOM_CONTEXT, ZOOM_ESCAPE } from "./zoom.js";

const FONT = 12;             // code at 100 %
const PROSE = 13.5;          // Markdown prose at 100 %
// Editor metrics: line height is GPUI's phi rounded; a mono char is 0.6 em; soft wrap leaves
// WRAP_PAD px of a fence's width without text.
const lineHeight = (font) => Math.round(font * 1.618034);
const charWidth = (font) => font * 0.6;
const WRAP_PAD = 24;
const CODE_PAD = 8;          // space above and below a fence's text
const COPIED_MS = 1500;
const MAX_EDITORS = 300;     // fences past this stay in the prose, uncolored
const MAX_DIAGRAM_W = 640;   // diagram width cap at 100 %
const COL_W = 860;           // reading column cap at 100 %; scales with the zoom
const LEVELS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const ZOOM_KEY = "preview.zoom", WRAP_KEY = "preview.wrap", BLAME_KEY = "preview.blame";
const BLAME_W = 210;         // the blame column (full mode)
const BLAME_DELAY = 150;     // ms after the file shows before git blame starts
const DEBOUNCE = 200, MAX_WAIT = 1000;   // live reload: agents write in bursts
const POLL = 2500, MARKS_EVERY = 4000;
const FULL_MAX = 1000;       // code files up to this many rows get the line gutter; longer ones, the ruler only
const GUTTER = 10, RULER = 12;
// Syntax colors cost: an EditorState with a language parses its whole text with syntect on the
// UI thread, ~3–4 ms per KB (a 75 KB file: ~250 ms), at creation and on every set_value/keystroke.
// Without a language it is ~free. So text shows plain at once and gets its colors a step later.
const HL_SYNC = 6000;        // chars colored before the first paint
const HL_MAX = 160000;       // a code file or fence past this stays plain (one parse would freeze ~0.5 s)
const EDIT_HL_MAX = 24000;   // editing re-parses the whole text per keystroke: plain past this
const HL_BUDGET = 24;        // ms of coloring per step (Markdown fences), then a frame
const HL_DELAY = 30;         // ms before a step, so the plain text paints first
const RULER_MAX = 300;       // overview ruler marks drawn; more are merged by position
const BAR_X = 10;            // a Markdown block's find bar sits this far right of the column
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Esc and Ctrl+F bound to these contexts outrank the app's bindings (Esc would close a dialog).
const FIND_CONTEXT = "GeocinePreviewFind", FIND_ESCAPE = "geocine_preview_find_escape";
const DOC_CONTEXT = "GeocinePreviewDoc", FIND_OPEN = "geocine_preview_find_open";
const SAVE = "geocine_preview_save", EDIT = "geocine_preview_edit";

let bound = false;

/** A theme color with an alpha byte ("#rrggbb" only), else null. */
const tint = (c, a) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c + a : null);
/** `a` laid over `b` at weight w, opaque, or null when either isn't #rrggbb. */
function blend(a, b, w) {
  const hex = /^#[0-9a-f]{6}/i;
  if (typeof a !== "string" || typeof b !== "string" || !hex.test(a) || !hex.test(b)) return null;
  let out = "#";
  for (let i = 1; i < 7; i += 2) out += Math.round(w * parseInt(a.slice(i, i + 2), 16) + (1 - w) * parseInt(b.slice(i, i + 2), 16)).toString(16).padStart(2, "0");
  return out;
}
const plural = (n, w) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
/** Ruler rows (from 0) merged to at most RULER_MAX by position, `keep` always kept. */
function thin(rows, total, keep = -1) {
  if (rows.length <= RULER_MAX) return rows;
  const out = [], seen = new Set();
  for (const r of rows) { const bin = Math.floor((r * RULER_MAX) / Math.max(1, total)); if (!seen.has(bin)) { seen.add(bin); out.push(r); } }
  if (keep >= 0 && !out.includes(keep)) out.push(keep);
  return out;
}
const rowCount = (text) => { let n = 1; for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++; return n; };
const isAbs = (p) => /^([a-z]:)?\//i.test(p);

function syntax(t) {
  // selection: the Editor's selection and find highlights; translucent so the text shows through.
  const selection = tint(t.accent, "59");
  return { keyword: t.ansi5, string: t.ansi2, "string.escape": t.ansi6, comment: t.dim, function: t.ansi4, type: t.ansi3,
    number: t.ansi9 ?? t.ansi1, boolean: t.ansi6, constant: t.ansi6, operator: t.muted, punctuation: t.muted,
    ...(selection ? { selection } : {}) };
}

function norm(p) {
  p ??= {};
  return { on: p.on ?? null, root: slash(p.root ?? "").replace(/\/+$/, ""), path: slash(p.path ?? "").replace(/^\.\//, ""),
    rev: p.rev || null, repoTop: p.repoTop ? slash(p.repoTop).replace(/\/+$/, "") : null, wide: Boolean(p.wide), onOpen: typeof p.onOpen === "function" ? p.onOpen : null,
    onDirty: typeof p.onDirty === "function" ? p.onDirty : null };
}
const ident = (p) => JSON.stringify([p.on, p.root, p.path, p.rev, p.repoTop]);

/** "/a/./b/../c" -> "/a/c" (keeps a drive letter). */
function normalize(path) {
  const out = [], drive = /^[a-z]:/i.exec(path)?.[0] ?? "";
  for (const part of path.slice(drive.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return drive + "/" + out.join("/");
}

// TextView drops HTML <br> (a README's "<b>Title</b><br>Line" reads "TitleLine"): make it a
// Markdown hard break, which it keeps.
const lineBreaks = (text) => text.replace(/<br\s*\/?>\s*/gi, "  \n");

export default class Preview extends View {
  init(props, cx) {
    this.p = norm(props);
    this.focus = cx.focus_handle();
    this.zoomFocus = cx.focus_handle();
    if (!bound) {
      bound = true;
      try {
        cx.bind_keys([
          { keystroke: "escape", action: FIND_ESCAPE, context: FIND_CONTEXT },
          { keystroke: "escape", action: ZOOM_ESCAPE, context: ZOOM_CONTEXT },
          { keystroke: "ctrl-f", action: FIND_OPEN, context: DOC_CONTEXT },
          { keystroke: "cmd-f", action: FIND_OPEN, context: DOC_CONTEXT },
          { keystroke: "ctrl-s", action: SAVE, context: DOC_CONTEXT },
          { keystroke: "cmd-s", action: SAVE, context: DOC_CONTEXT },
          { keystroke: "ctrl-e", action: EDIT, context: DOC_CONTEXT },
          { keystroke: "cmd-e", action: EDIT, context: DOC_CONTEXT },
        ]);
      } catch {}
    }
    const z = Number(localStorage.getItem(ZOOM_KEY));
    this.textZoom = LEVELS.includes(z) ? z : 1;
    this.codeFont = Math.round(FONT * this.textZoom);
    this.wrap = localStorage.getItem(WRAP_KEY) === "1";
    this.blameCol = localStorage.getItem(BLAME_KEY) !== "0";   // blame shown: the line notes, and full mode's column
    this.blame = null;    // { rows, commits } of the file on disk (blame.js), null until known
    this.blameKey = null; // what this.blame was read for: { doc, st }
    this.blameHints = null;
    this.blocks = [];     // Markdown: [{ kind: "md", text } | { kind: "code", info, text, state } | { kind: "mmd", ... }]
    this.code = null;     // EditorState of a code file
    this.codeLater = false;  // this.code is plain for now; colors come with the next coloring step
    this.codeBare = false;   // this.code stays plain: too large to color
    this.hlToken = 0;     // bumps when the EditorStates are released: coloring steps for them stop
    this.coloring = null; // the token a coloring step is scheduled for
    this.doc = null;      // what readDoc returned
    this.gen = 0;         // bumps when the file changes (props); stale loops and loads stop
    this.seq = 0;         // bumps on every load; late results are dropped
    this.tasks = [];      // timers of this file
    this.marks = null;    // changed lines vs HEAD
    this.ds = null;       // find: { input, query, hits, total, blocks, at, heads }
    this.zoomView = null; // an expanded diagram
    this.edit = null;     // editing: { state, base, raw, doc, dirty, conflict, saving, error }
    this.source = true;   // editing Markdown: the source (true) or the rendered edits (false)
    this.ask = null;      // unsaved edits and a step that would drop them: { kind: "leave" | "switch", next? }
    this.pics = new Map();// Markdown images: path as written -> { src, w, h } | null
    this.colW = null;
    this.width = null;
    this.mermaid = new Mermaid();
    this.themeSig = this.sig();
    this.load(cx);
  }

  update(props) {
    const next = norm(props);
    const moved = ident(next) !== ident(this.p);
    // Only the repo top arrived (a host learns it after showing the file): same file, no reread.
    if (moved && ident({ ...next, repoTop: this.p.repoTop }) === ident(this.p)) {
      if (this.ask?.kind === "switch") this.ask = null;   // the host went back to this file
      this.p = next; this.topMoved = true; return;
    }
    // Unsaved edits: the new file waits for Save / Discard / Cancel.
    if (moved && this.edit?.dirty) { this.ask = { kind: "switch", next }; return; }
    if (!moved && this.ask?.kind === "switch") this.ask = null;   // the host went back to this file
    this.p = next;
    if (moved) this.want = true;   // loaded from the next render, which has a cx
  }

  sig() { const t = theme(); return [t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6, t.dim, t.muted, t.foreground, settings().dark, settings().font_family].join("|"); }

  abs() {
    const { root, path } = this.p;
    if (!path) return null;
    return isAbs(path) || !root ? path : `${root}/${path}`;
  }

  // ---- loading ----------------------------------------------------------------

  release() {
    for (const b of this.blocks) b.state?.release();
    this.blocks = [];
    this.code?.release();
    this.code = null;
    this.codeLater = this.codeBare = false;
    this.hlToken++;
  }

  stopTasks() {
    for (const t of this.tasks) t.cancel();
    this.tasks = [];
    this.flushing?.cancel();
    this.flushing = null;
  }

  /** Reads the file. quiet: a live reload (nothing changes when the content is the same). */
  load(cx, quiet = false) {
    const p = this.p, abs = this.abs();
    if (!quiet) {
      this.gen++;
      this.stopTasks();
      this.release();
      this.doc = null; this.marks = null; this.codeMarks = null; this.stamp = null; this.note = null; this.loadedAt = null;
      this.inRepo = undefined; this.lastStatus = undefined;
      this.blame = this.blameHints = this.blameKey = this.blameRuns = null;
      if (this.zoomView) { this.zoomView.closed = true; this.zoomView = null; }
      if (this.ds) this.closeFind(false);
      this.dropEdit(cx, false);
      this.pics = new Map();
      this.loading = Boolean(abs);
    }
    if (!abs) { this.loading = false; return; }
    const gen = this.gen, seq = ++this.seq;
    cx.spawn(async (cx) => {
      let doc;
      try { doc = await readDoc({ on: p.on, abs, rev: p.rev, repo: p.repoTop ? { top: p.repoTop } : null }); }
      catch (e) { doc = { kind: "error", message: String(e?.message ?? e) }; }
      if (this.seq !== seq || this.gen !== gen) return;
      this.loading = false;
      if (doc.kind === "text") doc.lines = rowCount(doc.text);
      const e = this.edit;
      if (e && quiet) {
        if (doc.raw === e.raw) { cx.notify(); return; }            // our own save, or nothing new
        if (e.dirty || e.saving) { e.conflict = true; cx.notify(); return; }   // never over unsaved edits
        e.raw = doc.raw; e.base = doc.text; e.doc = doc; e.conflict = false;
        e.state.set_value(doc.text);
      }
      const prev = this.doc;
      if (prev && prev.kind === doc.kind && prev.text === doc.text && prev.message === doc.message && prev.truncated === doc.truncated && doc.kind !== "image") { cx.notify(); return; }
      if (doc.kind === "markdown") doc.segments = splitPictures(splitQuotes(segment(doc.text)));
      this.doc = doc;
      this.loadedAt = Date.now();
      if (!this.patch(prev)) this.build(cx);
      this.diagrams(cx);
      this.pictures(gen, cx);
      this.runFind();
      this.refreshMarks(cx);
      if (!quiet) this.watch(gen, cx);
      cx.notify();
    });
  }

  /** Live: watchFolder on this computer (the file's folder), a stat poll on another machine. */
  watch(gen, cx) {
    const p = this.p, abs = this.abs();
    if (p.rev || !abs) return;
    if (this.doc?.kind === "text" && !p.rev) { this.headSeen = undefined; if (this.headLocal()) this.checkHead(gen, cx); this.tasks.push(cx.timer.every(MARKS_EVERY, (cx) => this.checkHead(gen, cx))); }
    if (p.on) return this.poll(gen, cx);
    const folder = dirName(abs), me = abs.toLowerCase(), up = folder.toLowerCase();
    cx.spawn(async (cx) => {
      try {
        while (this.gen === gen) {
          const paths = await watchFolder(folder);
          if (this.gen !== gen) return;
          if (paths.some((x) => { const s = slash(x).replace(/^\/\/[?.]\//, "").toLowerCase().replace(/\/+$/, ""); return s === me || s === up; })) this.changed(gen, cx);
        }
      } catch {
        if (this.gen === gen) { this.polling = true; this.poll(gen, cx); cx.notify(); }
      }
    });
  }

  poll(gen, cx) {
    const p = this.p, abs = this.abs();
    this.tasks.push(cx.timer.every(POLL, async (cx) => {
      if (this.gen !== gen || this.statting) return;
      this.statting = true;
      let s;
      try { s = p.on ? await stamp(abs, p.on) : fnv1a(String(await readTextFile(abs).catch(() => ""))); }
      catch { s = null; }
      finally { this.statting = false; }
      if (this.gen !== gen || s === null) return;
      const before = this.stamp;
      this.stamp = s;
      if (before !== null && before !== undefined && s !== before) this.load(cx, true);
    }));
  }

  /**
   * A watch batch: reload 200 ms after the last one, at most 1 s late. A large colored code file
   * re-parses its colors on every reload (UI thread), so it waits longer, in proportion.
   */
  changed(gen, cx) {
    const now = Date.now();
    const parse = this.code && !this.codeBare && this.doc?.kind === "text" && lang.forPath(this.p.path) ? this.doc.text.length / 280 : 0;   // ~ms
    const wait = Math.max(DEBOUNCE, 2 * parse), most = Math.max(MAX_WAIT, 8 * parse);
    this.since ??= now;
    if (this.flushing && !this.flushing.is_done()) {
      if (now - this.since >= most) return;
      this.flushing.cancel();
    }
    this.flushing = cx.timer.after(wait, (cx) => { this.since = null; if (this.gen === gen) this.load(cx, true); });
  }

  reload(cx) { this.load(cx, true); this.refreshMarks(cx); }

  /** What build() makes of the segments, without EditorStates. */
  plan(segments) {
    const out = [], seen = new Map();
    let editors = 0;
    for (const s of segments) {
      if (s.kind === "md" || s.kind === "quote" || s.kind === "pic") { out.push(s); continue; }
      const mermaid = s.info.toLowerCase() === "mermaid", start = s.start, end = s.end;
      if (editors >= MAX_EDITORS) { out.push({ kind: "md", text: "```" + s.info + "\n" + s.text + "\n```", start, end }); continue; }
      editors++;
      const lines = Math.max(1, s.text.split("\n").length);
      if (!mermaid) { out.push({ kind: "code", info: s.info, text: s.text, lines, start, end, wrap: lang.wraps(lang.forFence(s.info)) }); continue; }
      const hash = fnv1a(s.text), n = (seen.get(hash) ?? 0) + 1;
      seen.set(hash, n);
      out.push({ kind: "mmd", info: s.info, text: s.text, lines, start, end, hash, id: n === 1 ? `mmd-${hash}` : `mmd-${hash}-${n}` });
    }
    return out;
  }

  /** Live reload in place: the same blocks get new texts, so Editors and element ids survive. */
  patch(prev) {
    const doc = this.doc;
    if (!prev || prev.kind !== doc.kind) return false;
    if (doc.kind === "text") {
      // Crossing the color limit makes a new state; else the text goes in place (colors re-parse).
      if (!this.code || this.codeBare !== this.tooBig(doc.text)) return false;
      this.code.set_value(doc.text);
      return true;
    }
    if (doc.kind !== "markdown") return false;
    const next = this.plan(doc.segments);
    if (next.length !== this.blocks.length || next.some((b, i) => b.kind !== this.blocks[i].kind || (b.kind === "code" && b.info !== this.blocks[i].info))) return false;
    next.forEach((b, i) => {
      const old = this.blocks[i];
      if (b.kind === "md" || b.kind === "quote" || b.kind === "pic") { this.blocks[i] = b; return; }
      if (b.kind === "mmd") {
        if (old.hash === b.hash) { old.id = b.id; old.start = b.start; old.end = b.end; return; }
        old.state?.release();
        this.blocks[i] = b;
        return;
      }
      if (old.text !== b.text) old.state.set_value(b.text);
      old.text = b.text; old.lines = b.lines; old.vis = null; old.start = b.start; old.end = b.end;
    });
    return true;
  }

  /** (Re)creates the EditorStates. Never from render itself. */
  build(cx) {
    this.release();
    const doc = this.doc;
    if (!doc) return;
    if (doc.kind === "text") { this.makeCode(cx); return; }
    if (doc.kind !== "markdown") return;
    // Fences get their colors while the first HL_BUDGET ms last; the rest show plain and are
    // colored a step at a time (colorStep), top first.
    const t0 = Date.now();
    for (const b of this.plan(doc.segments)) {
      if (b.kind === "md" || b.kind === "quote" || b.kind === "pic" || b.kind === "mmd") { this.blocks.push(b); continue; }
      this.blocks.push(this.fence(b, Date.now() - t0 < HL_BUDGET));
    }
    this.colorLater(cx);
  }

  /** A code block with its EditorState: colored now, or plain with `later` set (or for good when too large). */
  fence(b, now) {
    const language = lang.forFence(b.info), color = Boolean(language) && b.text.length <= HL_MAX;
    b.later = color && !now;
    b.state = this.fenceState(b.text, color && now ? language : null, language);
    return b;
  }

  tooBig(text) { return Boolean(lang.forPath(this.p.path)) && text.length > HL_MAX; }

  /** The code file's EditorState: colored at once when small, else plain now and colored on the next step. */
  makeCode(cx) {
    this.code?.release();
    const text = this.doc?.text ?? "", language = lang.forPath(this.p.path);
    this.codeBare = this.tooBig(text);
    const now = !language || this.codeBare || text.length <= HL_SYNC || !cx;
    this.codeLater = !now;
    this.code = this.codeState(now && !this.codeBare);
    this.colorLater(cx);
  }

  /** Schedules a coloring step for what was left plain (codeLater, fences' `later`). */
  colorLater(cx) {
    if (!cx || this.coloring === this.hlToken) return;
    if (!this.codeLater && !this.blocks.some((b) => b.later)) return;
    const token = this.coloring = this.hlToken;
    cx.timer.after(HL_DELAY, (cx) => {
      if (this.coloring === token) this.coloring = null;
      if (token === this.hlToken) this.colorStep(cx);
    });
  }

  /**
   * Colors the code file, or fences for about HL_BUDGET ms (at least one), then lets a frame through.
   * Each step redraws: a colored fence's first paint is the costly part (~60 ms for 6 KB), so
   * batching several into one redraw only makes that frame longer.
   */
  colorStep(cx) {
    const t0 = Date.now();
    let done = 0;
    if (this.codeLater && this.code) {
      this.code.release();
      this.code = this.codeState(true);
      this.codeLater = false;
      done++;
    }
    for (const b of this.blocks) {
      if (!b.later) continue;
      if (done && Date.now() - t0 >= HL_BUDGET) break;
      const s = this.fenceState(b.text, lang.forFence(b.info));
      b.state.release();
      b.state = s;
      b.later = false;
      done++;
    }
    if (done) cx.notify();
    this.colorLater(cx);
  }

  codeState(color = true) {
    const language = color ? lang.forPath(this.p.path) : null;
    const state = EditorState.new({ readonly: true, font_family: settings().font_family, font_size: this.codeFont, syntax: syntax(theme()),
      ...(language ? { language } : {}), soft_wrap: this.wrapOn(), value: this.doc?.text ?? "" });
    this.findInCode(state);
    if (this.hintsNow() && this.doc?.kind === "text") state.set_line_hints(this.hintsNow());
    return state;
  }

  /**
   * A code file's find runs in its Editor: the matches are highlighted in the text and the
   * current one is scrolled to (the Editor scrolls itself while finding, see codeLayout).
   * Again on every new state (colors, zoom, wrap) and every load.
   */
  findInCode(state = this.code) {
    const ds = this.ds;
    if (!state || this.doc?.kind !== "text") return;
    if (!ds?.query) { if (ds) { ds.hits = []; ds.total = 0; } state.search(""); return; }
    const rows = state.search(ds.query);
    ds.hits = rows.map((r) => ({ line: r + 1 }));
    ds.total = rows.length;
    ds.at = Math.max(0, Math.min(rows.length - 1, ds.at));
    if (rows.length) state.search_go(ds.at);
  }

  /** wrapAs: the fence's language for soft wrap, when it's drawn plain for now. */
  fenceState(value, language, wrapAs = language) {
    return EditorState.new({ readonly: true, font_family: settings().font_family, font_size: this.codeFont, syntax: syntax(theme()),
      ...(language ? { language } : {}), value, line_numbers: false, folding: false, soft_wrap: lang.wraps(wrapAs) });
  }

  /** Soft wrap of the code view: the person's toggle, and always for JSON. */
  wrapOn() { return this.wrap || lang.wraps(lang.forPath(this.p.path ?? "")); }

  /** EditorStates take their font and colors at creation: new ones in place (plain first, colored by steps). */
  refont(cx) {
    if (this.code) this.makeCode(cx);
    if (this.edit) { const v = this.edit.state.value(); this.edit.state.release(); this.edit.state = this.editState(v); }
    const t0 = Date.now();
    for (const b of this.blocks) {
      if (!b.state) continue;
      b.state.release();
      if (b.kind === "mmd") { b.state = this.fenceState(b.text, null); b.later = false; }
      else this.fence(b, Date.now() - t0 < HL_BUDGET);
      b.vis = null;
    }
    this.colorLater(cx);
  }

  // ---- git marks ------------------------------------------------------------------

  /**
   * Changed lines of the code file against HEAD (none at a commit, in Markdown, outside a repo).
   * poll: a periodic check, which asks for the status alone and diffs only when it moved;
   * otherwise status and diff run at once.
   */
  refreshMarks(cx, poll = false) {
    const doc = this.doc, p = this.p, abs = this.abs(), gen = this.gen;
    if (!doc || doc.kind !== "text" || p.rev || !abs) { this.setMarks(null); return; }
    if (this.marking) { this.markAgain = true; return; }
    this.marking = true;
    const folder = dirName(abs), name = baseName(abs);
    cx.spawn(async (cx) => {
      let m, st, diff = null;
      try {
        if (poll) st = await git.status(folder, name, p.on);
        else ({ st, diff } = await git.both(folder, name, p.on));
        if (st === null) this.inRepo = false;
        else if (st !== undefined) {
          this.inRepo = true;
          // Unchanged status and text: the marks stand.
          if (poll && st === this.lastStatus && doc === this.marksDoc) m = this.marks;
          else m = await git.changes(folder, name, doc.text, p.on, st, diff);
        }
      } finally { this.marking = false; }
      if (this.gen === gen && this.doc === doc && m !== undefined) {
        this.lastStatus = st; this.marksDoc = doc;
        if (m !== this.marks) { this.setMarks(m); cx.notify(); }
      }
      if (this.gen === gen && this.doc === doc && st !== undefined) this.queueBlame(cx, st);
      if (this.markAgain) { this.markAgain = false; this.refreshMarks(cx); }
    });
  }

  /**
   * The marks' periodic check: HEAD can move (a commit) while the file stays. Here, with a known
   * repo top, that's read from .git's files (no process); else (another machine, no top) a git status.
   */
  /** HEAD is read from .git's files: this computer, a known repo top, and the file inside it (not in a nested repo or elsewhere). */
  headLocal() {
    const p = this.p, abs = this.abs();
    return !p.on && Boolean(p.repoTop) && Boolean(abs) && abs.toLowerCase().startsWith(p.repoTop.toLowerCase() + "/");
  }

  checkHead(gen, cx) {
    if (this.gen !== gen || this.inRepo === false || this.headBusy) return;
    const p = this.p;
    if (!this.headLocal()) return this.refreshMarks(cx, true);
    this.headBusy = true;
    cx.spawn(async (cx) => {
      let s;
      try { s = await git.headStamp(p.repoTop); } catch { s = null; } finally { this.headBusy = false; }
      if (this.gen !== gen || this.p.repoTop !== p.repoTop) return;
      if (s === null) { this.headSeen = undefined; return this.refreshMarks(cx, true); }
      const before = this.headSeen;
      this.headSeen = s;
      if (before !== undefined && s !== before) this.refreshMarks(cx);
    });
  }

  /**
   * git blame of the file, in the background once it shows and its marks are known: again only when
   * the text or its git status changes (an edit, a commit). Never holds the view up.
   */
  queueBlame(cx, st) {
    const doc = this.doc, p = this.p, abs = this.abs(), gen = this.gen;
    const key = String(st ?? "");
    if (!doc || (doc.kind !== "text" && doc.kind !== "markdown") || p.rev || !abs) return;
    if (this.blameKey?.doc === doc && this.blameKey.st === key) return;
    if (st === null || (doc.lines ?? 0) > blm.BLAME_MAX_LINES) { this.blameKey = { doc, st: key }; this.setBlame(null); return; }
    if (this.blaming) { this.blameAgain = true; return; }
    this.blaming = true;
    cx.spawn(async (cx) => {
      let b = null;
      try {
        await cx.sleep(BLAME_DELAY);
        if (this.gen !== gen || this.doc !== doc) return;
        b = await blm.blame(dirName(abs), baseName(abs), p.on);
      } catch { b = null; } finally { this.blaming = false; }
      if (this.gen === gen && this.doc === doc) {
        this.blameKey = { doc, st: key };
        this.setBlame(b);
        cx.notify();
      }
      if (this.blameAgain) { this.blameAgain = false; if (this.gen === gen && this.lastStatus !== undefined) this.queueBlame(cx, this.lastStatus); }
    });
  }

  setBlame(b) {
    this.blame = b;
    this.blameRuns = null;
    this.blameHints = b ? blm.hints(b) : null;
    this.applyHints();
  }

  /** The cursor line's blame note in the Editors (an edited, unsaved text has none: its rows moved). */
  /** The line notes to show: none while blame is hidden. */
  hintsNow() { return this.blameCol ? this.blameHints : null; }

  applyHints() {
    const h = this.hintsNow();
    if (this.code) this.code.set_line_hints(this.doc?.kind === "text" ? h : null);
    if (this.edit?.state) this.edit.state.set_line_hints(this.edit.dirty ? null : h);
  }

  toggleBlame(cx) {
    this.blameCol = !this.blameCol;
    try { localStorage.setItem(BLAME_KEY, this.blameCol ? "1" : "0"); } catch {}
    this.applyHints();
    cx.notify();
  }

  setMarks(m) {
    this.marks = m;
    if (!m || this.doc?.kind !== "text") { this.codeMarks = null; return; }
    const runs = git.runs(m), dels = [...m.dels].sort((a, b) => a - b), rows = Math.max(1, this.doc.lines ?? 1);
    // The ruler draws at most RULER_MAX of each (a file changed all over has thousands).
    const byRow = new Map(runs.map((r) => [r.from - 1, r])), keep = thin(runs.map((r) => r.from - 1), rows);
    this.codeMarks = { runs, dels, sum: git.summary(m), rulerRuns: keep.map((r) => byRow.get(r)), rulerDels: thin(dels, rows) };
  }

  // ---- zoom and wrap ----------------------------------------------------------------

  textAct(a, cx) {
    const i = LEVELS.indexOf(this.textZoom);
    const z = a === "reset" ? 1 : LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i + (a === "in" ? 1 : -1)))];
    if (z === this.textZoom) return;
    this.textZoom = z;
    try { if (z === 1) localStorage.removeItem(ZOOM_KEY); else localStorage.setItem(ZOOM_KEY, String(z)); } catch {}
    const font = Math.round(FONT * z);
    if (font !== this.codeFont) { this.codeFont = font; this.refont(cx); }
    cx.notify();
  }

  toggleWrap(cx) {
    this.wrap = !this.wrap;
    try { localStorage.setItem(WRAP_KEY, this.wrap ? "1" : "0"); } catch {}
    if (this.code) this.makeCode(cx);
    cx.notify();
  }

  proseSize() { return Math.round(PROSE * this.textZoom * 2) / 2; }

  /** Visual rows of a fence; a soft-wrapped one depends on the column width. */
  rows(b) {
    if (!b.wrap || !this.colW) return b.lines;
    const cols = Math.max(1, Math.floor((this.colW - WRAP_PAD) / charWidth(this.codeFont)));
    if (b.vis?.cols !== cols) b.vis = { cols, n: lang.wrappedRows(b.text, cols) };
    return b.vis.n;
  }

  // ---- Mermaid ------------------------------------------------------------------

  mermaidConfig() {
    const t = theme(), s = settings();
    return mermaidConfig(t, Boolean(s.dark), s.ui_font_family ? `${s.ui_font_family}, sans-serif` : null);
  }

  /** Asks for every diagram without a result: cached PNGs answer at once, the rest queue. */
  diagrams(cx) {
    if (!cx) return;
    const cfg = this.mermaidConfig();
    for (const b of this.blocks) {
      if (b.kind !== "mmd" || b.d) continue;
      const key = cacheKey(b.text, cfg), gen = this.gen;
      b.key = key;
      b.d = { pending: true };
      const alive = () => this.gen === gen && b.key === key && this.blocks.includes(b);
      this.mermaid.request({ key, source: b.text, config: cfg }, {
        alive,
        done: (res, cx) => {
          if (!alive()) return;
          b.d = res;
          // Fallback: the source as a code block (EditorState made here, never in render).
          if (res.error && !b.state) b.state = this.fenceState(b.text, null);
          cx.notify();
        },
      }, cx);
    }
  }

  retryDiagram(b, cx) {
    if (b.d?.setup) {
      this.mermaid.retrySetup();
      for (const o of this.blocks) if (o.kind === "mmd" && o.d?.setup) o.d = null;
    } else if (b.d?.error) {
      for (const o of this.blocks) if (o.kind === "mmd" && o.key === b.key) o.d = null;
      this.mermaid.forget(b.key);
    }
    this.diagrams(cx);
    cx.notify();
  }

  /** Images on lines of their own in the prose (`![](shot.png)`, `<img src>`), from the file's folder. */
  pictures(gen, cx) {
    const p = this.p, abs = this.abs();
    if (!abs || this.doc?.kind !== "markdown") return;
    const want = [];
    for (const b of this.blocks) if (b.kind === "pic") for (const x of b.pics) if (!this.pics.has(x.src) && !want.includes(x.src)) want.push(x.src);
    if (!want.length) return;
    for (const src of want) this.pics.set(src, undefined);   // asked for
    const base = dirName(abs), pics = this.pics, queue = want.slice(0, 24);
    // A few at a time: each is a process (a copy into the cache).
    for (let k = 0; k < 4; k++) cx.spawn(async (cx) => {
      for (let src; (src = queue.shift()) !== undefined;) {
        let path = src.split(/[?#]/)[0];
        try { path = decodeURI(path); } catch {}
        path = slash(path);
        const target = path.startsWith("/") ? (p.repoTop ? p.repoTop + path : null) : normalize(base + "/" + path);
        const d = target && lang.isImage(target) ? await readDoc({ on: p.on, abs: target, rev: p.rev, repo: p.repoTop ? { top: p.repoTop } : null }).catch(() => null) : null;
        if (this.gen !== gen || this.pics !== pics) return;
        pics.set(src, d?.kind === "image" ? d : null);
        cx.notify();
      }
    });
  }

  picBlock(b, t) {
    const z = this.textZoom, col = this.colW ?? 600;
    return h_flex().w_full().flex_wrap().gap(8).items_center().when(b.center, (el) => el.justify_center())
      .children(b.pics.map((x, k) => {
        const d = this.pics.get(x.src);
        if (d === undefined) return div().id(`pic-${b.start}-${k}`).h(24).px(8).flex().items_center().rounded(SIZE.radius).bg(t.surface).text_size(SIZE.small).text_color(t.dim).child(x.alt || "image…");
        if (!d) return h_flex().id(`pic-${b.start}-${k}`).h(24).px(8).gap(6).items_center().rounded(SIZE.radius).border_1().border_color(t.border).text_size(SIZE.small).text_color(t.dim)
          .child(svg(ui("image")).size(12)).child(x.alt || x.src);
        const natural = x.width ?? (d.w ? d.w : 320);
        const w = Math.max(8, Math.min(col, natural * z)), h = d.w && d.h ? (w * d.h) / d.w : null;
        return h === null ? image(d.src).w(w) : image(d.src).w(w).h(h);
      }));
  }

  diagramSize(w, h) {
    const z = this.textZoom, dw = Math.max(1, Math.min(this.colW ?? 700, (w / 2) * z, MAX_DIAGRAM_W * z));
    return { w: dw, h: (dw * h) / w };
  }

  expandDiagram(b, cx) {
    if (!b?.d?.ok) return;
    const list = this.blocks.filter((o) => o.kind === "mmd"), n = list.indexOf(b);
    const d = { key: b.key, source: b.text, config: this.mermaidConfig(), path: b.d.path, w: b.d.w, h: b.d.h };
    this.zoomView = new Zoom(d, this.mermaid, `${baseName(this.p.path)} · diagram ${n + 1} of ${list.length}`);
    this.zoomFocus.focus();
    cx.notify();
  }

  zoomAct(a, cx) {
    if (!this.zoomView) return;
    if (a !== "close") return this.zoomView.act(a, cx);
    this.zoomView.closed = true;
    this.zoomView = null;
    this.focus.focus();
  }

  // ---- find ------------------------------------------------------------------------

  findable() { const k = this.doc?.kind; return (k === "markdown" || k === "text") && !this.editing(); }

  openFind(cx) {
    if (!this.findable()) return;
    if (!this.ds) {
      const input = InputState.new({ placeholder: "Find in file…" });
      const ds = this.ds = { input, query: "", hits: [], total: 0, blocks: 0, at: 0, heads: [] };
      input.on("change", (_e, cx) => { if (this.ds === ds && input.value() !== ds.query) { ds.query = input.value(); ds.at = 0; this.runFind(); cx.notify(); } });
      input.on("submit", (e, cx) => { if (this.ds === ds) { this.step(e?.shift ? -1 : 1); cx.notify(); } });
    }
    this.ds.input.focus();
    cx?.notify();
  }

  closeFind(focus = true) {
    const ds = this.ds;
    if (!ds) return;
    this.ds = null;
    for (const b of this.blocks) b.find = null;
    this.code?.search_close();
    ds.input.release();
    if (focus) this.focus.focus();
  }

  /** Matches of the query: per line in a code file, one hit per match in Markdown. Again after every load. */
  runFind() {
    for (const b of this.blocks) b.find = null;
    const ds = this.ds, doc = this.doc;
    if (!ds) return;
    ds.hits = []; ds.total = 0; ds.blocks = 0;
    const q = ds.query.toLowerCase();
    if (doc?.kind === "text" && this.code) { this.findInCode(); return; }
    if (!q || !doc) return;
    if (doc.kind === "text") {
      const o = occurrences(doc.text, q);
      ds.hits = o.lines.map((l) => ({ line: l.line + 1, n: l.n }));
      ds.total = o.total;
    } else if (doc.kind === "markdown") {
      ds.heads = headings(this.blocks);
      for (const b of this.blocks) {
        const at = positions(b.text, q);
        if (!at.length) continue;
        const first = b.kind === "md" || b.kind === "quote" ? b.start : b.start + 1;
        b.find = { n: at.length, rows: [...new Set(at.map((x) => x.line))], at, k: -1, current: false, md: null, mdKey: null };
        at.forEach((x, k) => ds.hits.push({ block: b, line: first + x.line, k }));
        ds.total += at.length;
        ds.blocks++;
      }
    }
    ds.at = Math.max(0, Math.min(ds.hits.length - 1, ds.at));
    this.current(true);
  }

  current(on) {
    const h = this.ds?.hits[this.ds.at], f = h?.block?.find;
    if (!f) return;
    f.current = on;
    f.k = on ? h.k : -1;
  }

  step(d) {
    const ds = this.ds, n = ds?.hits.length;
    if (!n) return;
    this.current(false);
    ds.at = (ds.at + d + n) % n;
    this.current(true);
    if (this.doc?.kind === "text") this.code?.search_go(ds.at);
  }

  /** A prose block's Markdown with its matches in <mark>, cached on b.find. */
  markedText(b, t) {
    const f = b.find;
    if (!f || !this.ds) return b.text;
    const soft = blend(t.accent, t.background, 0.3) ?? t.selection, strong = blend(t.accent, t.background, 0.65) ?? t.accent;
    const key = `${f.k}|${soft}|${strong}`;
    if (f.mdKey !== key) {
      f.md = markMatches(b.text, f.at, this.ds.query.toLowerCase().length, (k) => (k === f.k ? strong : soft), f.mask ??= syntaxMask(b.text)).text;
      f.mdKey = key;
    }
    return f.md;
  }

  /** "3 of 12 · line 120 · Heading": where the current match is (the view can't scroll there). */
  findWhere() {
    const ds = this.ds, h = ds?.hits[ds.at];
    if (!h) return null;
    const sec = this.doc?.kind === "markdown" ? section(ds.heads, h.line) : null;
    return `line ${h.line}` + (sec ? ` · ${sec.text}` : "");
  }

  // ---- editing ---------------------------------------------------------------------------

  /** { reason } when this file can't be edited here, else {}. */
  canEdit() {
    const p = this.p, d = this.doc;
    if (p.rev) return { reason: "A past version can't be edited" };
    if (p.on) return { reason: `Editing works on this computer only (this file is on ${p.on})` };
    if (!d || (d.kind !== "text" && d.kind !== "markdown")) return { reason: d?.kind === "image" || d?.kind === "binary" ? "Not a text file" : "Nothing to edit" };
    if (d.truncated) return { reason: `Too large to edit (over ${mb(LIMIT)})` };
    if (d.note || d.raw === undefined) return { reason: "Not UTF-8: can't be saved safely" };
    return {};
  }

  /** Editing the source now (not the rendered Markdown of the edits). */
  editing() { return Boolean(this.edit) && (this.doc?.kind !== "markdown" || this.source); }

  editState(value) {
    // Every keystroke re-parses the whole text for colors: a large file is edited plain.
    const language = value.length <= EDIT_HL_MAX ? lang.forPath(this.p.path) : null, e = this.edit;
    e.plain = !language && Boolean(lang.forPath(this.p.path));
    const state = EditorState.new({ readonly: false, font_family: settings().font_family, font_size: this.codeFont, syntax: syntax(theme()),
      ...(language ? { language } : {}), soft_wrap: this.wrapOn() || this.doc?.kind === "markdown", value, line_numbers: true });
    state.on("change", (_e, cx) => { if (this.edit === e) this.setDirty(state.value() !== e.base, cx); });
    if (this.hintsNow() && !e.dirty) state.set_line_hints(this.hintsNow());
    return state;
  }

  toggleEdit(cx) {
    if (this.edit) return this.leaveEdit(cx);
    if (this.canEdit().reason) return;
    const d = this.doc;
    this.edit = { state: null, base: d.text, raw: d.raw, doc: d, dirty: false, conflict: false, saving: false, error: null };
    this.edit.state = this.editState(d.text);
    this.source = true;
    if (this.ds) this.closeFind(false);
    // The host stops taking the keyboard and its shortcuts while the editor types.
    this.p.onEditing?.(true, cx);
    cx.notify();
  }

  /** Back to the view; unsaved edits ask first. */
  leaveEdit(cx) {
    if (!this.edit) return;
    if (this.edit.dirty) { this.ask = { kind: "leave" }; cx.notify(); return; }
    this.dropEdit(cx);
    cx.notify();
  }

  /** Ends editing, edits dropped; the view shows the disk again. */
  dropEdit(cx, restore = true) {
    const e = this.edit;
    if (!e) return;
    this.edit = null;
    this.ask = null;
    this.p.onEditing?.(false, cx);
    e.state.release();
    if (e.dirty) this.p.onDirty?.(false, cx);
    if (restore && this.doc !== e.doc && e.doc) { this.doc = e.doc; this.build(cx); this.diagrams(cx); this.pictures(this.gen, cx); }
    if (restore) this.focus.focus();
  }

  setDirty(d, cx) {
    const e = this.edit;
    if (!e || e.dirty === d) return;
    e.dirty = d;
    e.state?.set_line_hints(d ? null : this.hintsNow());
    if (d && this.note === "Saved") this.note = null;
    this.p.onDirty?.(d, cx);
    cx.notify();
  }

  /** Markdown while editing: the source, or the edits rendered (they stay). */
  toggleSource(cx) {
    const e = this.edit;
    if (!e || this.doc?.kind !== "markdown") return;
    this.source = !this.source;
    if (!this.source) {
      const text = e.state.value();
      if (text !== this.doc.text) {
        this.doc = { ...e.doc, text, segments: splitPictures(splitQuotes(segment(text))), edited: true };
        this.build(cx); this.diagrams(cx); this.pictures(this.gen, cx);
      }
    }
    cx.notify();
  }

  /**
   * Writes the edits, only if the file still holds what was loaded (writeTextFile's `expected`):
   * else "Changed on disk" with Reload / Overwrite. overwrite: save over whatever is there now.
   */
  save(cx, { overwrite = false, then = null } = {}) {
    const e = this.edit, abs = this.abs();
    if (!e || e.saving || !abs) return;
    const value = e.state.value();
    if (!e.dirty && !overwrite) { then?.(cx); return; }
    let out = e.doc.crlf ? value.replace(/\r?\n/g, "\r\n") : value;
    if (e.doc.bom && out.charCodeAt(0) !== 0xfeff) out = "\ufeff" + out;
    e.saving = true; e.error = null;
    const gen = this.gen;
    cx.spawn(async (cx) => {
      let expected = e.raw;
      if (overwrite) expected = await readTextFile(abs).catch(() => null);
      let ok = false, err = null;
      try { await writeTextFile(abs, out, expected); ok = true; } catch (x) { err = String(x?.message ?? x); }
      e.saving = false;
      if (this.edit !== e || this.gen !== gen) return;
      if (ok) {
        const doc = { ...e.doc, text: value, raw: out, lines: rowCount(value) };
        if (doc.kind === "markdown") doc.segments = splitPictures(splitQuotes(segment(value)));
        e.doc = doc; e.raw = out; e.base = value; e.conflict = false;
        this.setDirty(e.state.value() !== e.base, cx);
        this.doc = doc; this.loadedAt = Date.now();
        this.build(cx); this.diagrams(cx); this.pictures(gen, cx);
        this.note = "Saved";
        this.refreshMarks(cx);
        then?.(cx);
      } else {
        // Refused: the file moved on under us (or can't be written).
        const disk = await readTextFile(abs).catch(() => undefined);
        if (this.edit !== e) return;
        if (disk !== e.raw) e.conflict = true;
        else e.error = err ?? "Cannot save this file";
      }
      cx.notify();
    });
    cx.notify();
  }

  /** "Changed on disk": Reload drops the edits for the disk's text. */
  reloadDisk(cx) {
    const e = this.edit, abs = this.abs();
    if (!e || !abs) return;
    cx.spawn(async (cx) => {
      let doc;
      try { doc = await readDoc({ on: null, abs, rev: null, repo: null }); } catch { doc = null; }
      if (this.edit !== e || !doc || doc.raw === undefined) return;
      if (doc.kind === "text") doc.lines = rowCount(doc.text);
      if (doc.kind === "markdown") doc.segments = splitPictures(splitQuotes(segment(doc.text)));
      e.doc = doc; e.raw = doc.raw; e.base = doc.text; e.conflict = false; e.error = null;
      e.state.set_value(doc.text);
      this.setDirty(false, cx);
      this.doc = doc; this.build(cx); this.diagrams(cx); this.pictures(this.gen, cx);
      this.refreshMarks(cx);
      cx.notify();
    });
  }

  /** The unsaved-edits question: "save" | "discard" | "cancel". */
  answer(choice, cx) {
    const a = this.ask;
    if (!a) return;
    const go = (cx) => {
      this.ask = null;
      if (a.kind === "switch") { this.dropEdit(cx); this.p = a.next; this.load(cx); }
      else this.dropEdit(cx);
      cx.notify();
    };
    if (choice === "cancel") { this.ask = null; cx.notify(); return; }
    if (choice === "discard") return go(cx);
    this.save(cx, { then: go });
  }

  // ---- keys and links ------------------------------------------------------------------

  onKey(e, cx) {
    if (this.inInput) { this.inInput = false; return; }   // typed into the find field
    const m = e.modifiers;
    // Ctrl+S / Ctrl+E also come as actions; this catches them where the binding didn't match.
    if ((m.control || m.platform) && !m.alt && !m.shift && e.key === "s") { if (this.edit) { cx.stop_propagation(); this.save(cx); } return; }
    if ((m.control || m.platform) && !m.alt && !m.shift && e.key === "e") { cx.stop_propagation(); this.toggleEdit(cx); return; }
    if (this.editing()) return;   // keys typed into the editor stay there
    if (!m.platform && !m.control && !m.alt && e.key === "e" && this.edit === null && !this.canEdit().reason) { cx.stop_propagation(); this.toggleEdit(cx); return; }
    if ((m.control || m.platform) && !m.alt && !m.shift && e.key === "f") { cx.stop_propagation(); this.openFind(cx); return; }
    if (m.platform || m.control || m.alt) return;
    if (e.key === "/" || e.key_char === "/") { if (this.findable()) { cx.stop_propagation(); this.openFind(cx); } return; }
    if (this.ds && (e.key === "n" || e.key === "N" || e.key === "f3")) { cx.stop_propagation(); this.step(m.shift || e.key === "N" ? -1 : 1); cx.notify(); return; }
    if (e.key === "escape" && this.ds) { cx.stop_propagation(); this.closeFind(); cx.notify(); return; }
    const c = e.key_char, k = e.key;
    if (c === "+" || k === "+" || k === "=") { cx.stop_propagation(); this.textAct("in", cx); return; }
    if (c === "-" || k === "-") { cx.stop_propagation(); this.textAct("out", cx); return; }
    if (k === "0") { cx.stop_propagation(); this.textAct("reset", cx); return; }
    if (k === "w" && this.doc?.kind === "text") { cx.stop_propagation(); this.toggleWrap(cx); return; }
    if (k === "r") { cx.stop_propagation(); this.reload(cx); }
  }

  findKey(e, cx) {
    const m = e.modifiers;
    if (!m.platform && !m.control && !m.alt && (e.key === "down" || e.key === "up")) {
      cx.stop_propagation(); this.step(e.key === "down" ? 1 : -1); cx.notify(); return;
    }
    if (e.key === "escape") { cx.stop_propagation(); this.closeFind(); cx.notify(); return; }
    this.inInput = true;   // the root's on_key_down, next on the way up, leaves it alone
  }

  zoomKeyDown(e, cx) {
    const a = zoomKey(e);
    if (!a) return;
    cx.stop_propagation();
    this.zoomAct(a, cx);
    cx.notify();
  }

  link(url, cx) {
    if (/^https?:\/\//i.test(url)) { try { cx.open_url(url); } catch {} return; }
    if (/^mailto:/i.test(url)) { if (isWindows(this.p.on)) exec("explorer", [url]).catch(() => {}); return; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url) && !/^[a-z]:[\\/]/i.test(url)) return;
    let path = url.replace(/^file:\/\/\/?/i, "").split("#")[0];
    try { path = decodeURI(path); } catch {}
    path = slash(path);
    if (!path) { this.note = "Section links don't scroll the preview"; cx.notify(); return; }
    const { root, repoTop } = this.p;
    let rel;
    if (/^[a-z]:\//i.test(path)) rel = this.relTo(normalize(path), root);
    else if (path.startsWith("/")) rel = repoTop ? this.relTo(normalize(repoTop + path), root) : normalize(path).slice(1);
    else rel = normalize("/" + dirName(this.p.path) + "/" + path).slice(1);
    if (rel === null) { this.note = `Outside this folder: ${path}`; cx.notify(); return; }
    if (this.p.onOpen) this.p.onOpen(rel, this.p.rev, cx);
    else { this.note = `Link: ${rel}`; cx.notify(); }
  }

  relTo(abs, root) {
    const r = root.toLowerCase(), a = abs.toLowerCase();
    if (a === r) return "";
    return a.startsWith(r + "/") ? abs.slice(root.length + 1) : null;
  }

  copyBlock(b, cx) {
    cx.write_to_clipboard(b.text);
    const mark = (b.copied ?? 0) + 1;
    b.copied = mark;
    cx.timer.after(COPIED_MS, (cx) => { if (b.copied !== mark) return; b.copied = 0; cx.notify(); });
    cx.notify();
  }

  // ---- render --------------------------------------------------------------------------

  render(cx) {
    const t = theme();
    // Not from render itself: a load may create EditorStates and notify.
    if (this.want) { this.want = false; cx.timer.after(1, (cx) => { this.load(cx); cx.notify(); }); }
    const s = this.sig();
    if (s !== this.themeSig) {
      // Theme or font changed: colors are baked into the EditorStates, so rebuild them (not from render).
      this.themeSig = s;
      cx.timer.after(1, (cx) => { this.refont(cx); for (const b of this.blocks) if (b.kind === "mmd") b.d = null; this.diagrams(cx); cx.notify(); });
    }
    if (this.topMoved) {
      // The repo top arrived: pictures written from the repo's top ("/docs/a.png") can be found now.
      this.topMoved = false;
      cx.timer.after(1, (cx) => { for (const [k, v] of this.pics) if (v === null) this.pics.delete(k); this.pictures(this.gen, cx); });
    }
    const root = v_flex().id("pv-root").size_full().min_w(0).min_h(0).bg(t.background).text_color(t.foreground)
      .track_focus(this.focus).key_context(DOC_CONTEXT).on_action(FIND_OPEN, (_e, cx) => this.openFind(cx))
      .on_action(SAVE, (_e, cx) => { if (this.edit) this.save(cx); }).on_action(EDIT, (_e, cx) => this.toggleEdit(cx))
      .on_key_down((e, cx) => this.onKey(e, cx))
      // A press in the editor bubbles here: leave the keyboard with the editor then.
      .on_mouse_down("left", () => { if (!this.ds && !this.editing()) this.focus.focus(); })
      .on_size_change((size, cx) => { const w = Math.round(size.width); if (w !== this.width) { this.width = w; cx.notify(); } });
    if (this.zoomView) return root.child(this.zoomView.render(t, this.zoomFocus, {
      onKey: (e, cx) => this.zoomKeyDown(e, cx),
      onEscape: (cx) => { this.zoomAct("close", cx); cx?.notify(); },
      onClose: (cx) => { this.zoomAct("close", cx); cx.notify(); },
    }));
    return root.child(this.bar(t)).when(Boolean(this.ds), (el) => el.child(this.findBar(t)))
      .children(this.notices(t))
      .child(div().flex_1().min_h(0).min_w(0).flex().flex_col().child(this.body(t)))
      .child(this.footer(t));
  }

  narrow() { return this.width !== null && this.width < 340; }

  bar(t) {
    const p = this.p, doc = this.doc, name = baseName(p.path) || "No file", dir = dirName(p.path);
    const sum = this.codeMarks?.sum, z = Math.round(this.textZoom * 100), narrow = this.narrow();
    return h_flex().id("pv-bar").h(SIZE.subheader).flex_none().pl(SIZE.pad).pr(4).gap(6).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(p.path ? image(iconFor(p.path)).size(SIZE.icon + 2).flex_none() : svg(ui("file-text")).size(SIZE.icon).flex_none().text_color(t.dim))
      .child(h_flex().min_w(0).flex_shrink(1).gap(6).items_center().overflow_hidden()
        .child(div().flex_none().max_w_full().truncate().text_size(SIZE.text).font_semibold().text_color(t.foreground).child(name))
        .when(Boolean(dir) && !narrow && dir !== p.path, (el) => el.child(div().min_w(0).flex_shrink(1).truncate().text_size(SIZE.small).text_color(t.dim).child(dir))))
      .when(Boolean(p.rev), (el) => el.child(h_flex().flex_none().h(18).px(6).gap(4).items_center().rounded(SIZE.radius).bg(t.selected).text_size(SIZE.small).text_color(t.accent)
        .child(svg(ui("git-commit")).size(12)).child(String(p.rev).slice(0, 7))))
      .when(Boolean(sum) && !narrow, (el) => el.child(h_flex().flex_none().gap(5).text_size(SIZE.small)
        .when(sum.added > 0, (e) => e.child(div().text_color(t.ansi2).child(`+${sum.added}`)))
        .when(sum.modified > 0, (e) => e.child(div().text_color(t.ansi4).child(`~${sum.modified}`)))
        .when(sum.deleted > 0, (e) => e.child(div().text_color(t.ansi1).child(`−${sum.deleted}`)))))
      .when(this.loading, (el) => el.child(div().w(10).flex_none().text_size(SIZE.small).text_color(t.accent).frames(SPIN, 90).child(SPIN[0])))
      .when(Boolean(this.edit?.dirty), (el) => el.child(h_flex().flex_none().gap(5).items_center().text_size(SIZE.small).text_color(t.ansi3)
        .child(div().size(7).rounded(4).bg(t.ansi3)).when(!narrow, (e) => e.child("Modified"))))
      .child(div().flex_1())
      .children(this.editButtons(t))
      .when(this.findable(), (el) => el.child(iconButton(t, "pv-find", "search", (_e, cx) => this.openFind(cx), { on: Boolean(this.ds) })))
      .when(Boolean(this.blame) && (doc?.kind === "text" || this.editing()), (el) => el.child(iconButton(t, "pv-blame", "history", (_e, cx) => this.toggleBlame(cx), { on: this.blameCol })))
      .when(doc?.kind === "text", (el) => el.child(iconButton(t, "pv-wrap", "wrap-text", (_e, cx) => this.toggleWrap(cx), { on: this.wrapOn(), disabled: lang.wraps(lang.forPath(p.path)) })))
      .when(Boolean(doc) && doc.kind !== "binary" && doc.kind !== "missing" && doc.kind !== "error", (el) => el
        .child(iconButton(t, "pv-zoom-out", "zoom-out", (_e, cx) => this.textAct("out", cx), { disabled: this.textZoom === LEVELS[0] }))
        .when(!narrow || z !== 100, (e) => e.child(div().id("pv-zoom-pct").w(38).h(SIZE.button).flex_none().flex().items_center().justify_center().rounded(SIZE.radius)
          .text_size(SIZE.small).text_color(z === 100 ? t.dim : t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.textAct("reset", cx)).child(`${z}%`)))
        .child(iconButton(t, "pv-zoom-in", "zoom-in", (_e, cx) => this.textAct("in", cx), { disabled: this.textZoom === LEVELS[LEVELS.length - 1] })));
  }

  /** Edit (or why not), and while editing: Rendered/Source for Markdown, Save. */
  editButtons(t) {
    const e = this.edit, doc = this.doc;
    if (!doc || (doc.kind !== "text" && doc.kind !== "markdown")) return [];
    const why = this.canEdit().reason;
    const out = [iconButton(t, "pv-edit", "pencil", (_e, cx) => this.toggleEdit(cx), { on: Boolean(e), disabled: Boolean(why) && !e })
      .tooltip(e ? "Stop editing (Ctrl+E)" : why ?? "Edit (E or Ctrl+E)")];
    if (!e) return out;
    if (doc.kind === "markdown") out.push(iconButton(t, "pv-source", this.source ? "eye" : "code", (_e, cx) => this.toggleSource(cx)).tooltip(this.source ? "Show the edits rendered" : "Back to the source"));
    out.push(textButton(t, "pv-save", e.saving ? "Saving…" : "Save", (_e, cx) => this.save(cx), { icon: "save", primary: e.dirty, disabled: !e.dirty || e.saving }).tooltip("Save (Ctrl+S)"));
    return out;
  }

  findBar(t) {
    const ds = this.ds, has = ds.hits.length > 0;
    const count = !ds.query ? "" : ds.total ? `${ds.at + 1} of ${ds.hits.length}` : "No matches";
    return h_flex().id("pv-findbar").h(SIZE.subheader + 4).flex_none().px(SIZE.pad).gap(4).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .key_context(FIND_CONTEXT).on_action(FIND_ESCAPE, (_e, cx) => { this.closeFind(); cx.notify(); })
      .on_key_down((e, cx) => this.findKey(e, cx))
      .child(h_flex().flex_1().min_w(0).h(SIZE.button).px(7).gap(6).items_center().rounded(SIZE.radius).border_1().border_color(t.accent).bg(t.background)
        .child(svg(ui("search")).size(12).flex_none().text_color(t.dim))
        .child(Input.new(ds.input).flex_1().min_w(0).h_full().text_size(SIZE.text).text_color(t.foreground))
        .when(Boolean(count), (el) => el.child(div().flex_none().text_size(SIZE.small).text_color(ds.total ? t.muted : t.ansi3).child(count))))
      .child(iconButton(t, "pv-find-prev", "chevron-up", (_e, cx) => { this.step(-1); cx.notify(); }, { disabled: !has }))
      .child(iconButton(t, "pv-find-next", "chevron-down", (_e, cx) => { this.step(1); cx.notify(); }, { disabled: !has }))
      .child(iconButton(t, "pv-find-close", "close", (_e, cx) => { this.closeFind(); cx.notify(); }));
  }

  /** One-line notices under the bar: cut off, read in another encoding. */
  notices(t) {
    const doc = this.doc, out = [];
    const strip = (id, text, color) => h_flex().id(id).h(SIZE.row).flex_none().px(SIZE.pad + 2).gap(6).items_center().bg(t.surface).border_b(1).border_color(t.border)
      .text_size(SIZE.small).text_color(color).child(svg(ui("triangle-alert")).size(12).flex_none()).child(div().min_w(0).truncate().child(text));
    const e = this.edit, name = baseName(this.p.path);
    const choice = (id, text, color, buttons) => h_flex().id(id).min_h(SIZE.subheader + 4).flex_none().px(SIZE.pad + 2).py(4).gap(6).items_center().bg(t.surface).border_b(1).border_color(t.border)
      .text_size(SIZE.small).text_color(color).child(svg(ui("triangle-alert")).size(12).flex_none()).child(div().flex_1().min_w(0).truncate().child(text)).children(buttons);
    if (this.ask) out.push(choice("pv-ask", `Unsaved changes in ${name}`, t.ansi3, [
      textButton(t, "pv-ask-save", "Save", (_e, cx) => this.answer("save", cx), { primary: true }),
      textButton(t, "pv-ask-discard", "Discard", (_e, cx) => this.answer("discard", cx)),
      textButton(t, "pv-ask-cancel", "Cancel", (_e, cx) => this.answer("cancel", cx))]));
    if (e?.conflict) out.push(choice("pv-conflict", "Changed on disk since you started editing", t.ansi3, [
      textButton(t, "pv-reload-disk", "Reload", (_e, cx) => this.reloadDisk(cx)).tooltip("Drop your edits and show the file as it is now"),
      textButton(t, "pv-overwrite", "Overwrite", (_e, cx) => this.save(cx, { overwrite: true })).tooltip("Save your edits over it")]));
    if (e?.error) out.push(strip("pv-save-error", `Not saved: ${e.error}`, t.ansi1));
    if (doc?.truncated) out.push(strip("pv-cut", `Large file: showing the first ${mb(LIMIT)}${doc.size ? ` of ${mb(doc.size)}` : ""}`, t.ansi3));
    if (doc?.note) out.push(strip("pv-enc", doc.note, t.muted));
    return out;
  }

  footer(t) {
    const doc = this.doc, p = this.p, parts = [];
    if (!p.path) return div();
    parts.push(doc?.kind === "binary" ? "Binary" : lang.label(p.path));
    if (doc?.kind === "text") parts.push(plural(doc.lines, "line"));
    if (doc?.kind === "text" && this.codeBare && !this.edit) parts.push("no colors: large file");
    if (this.edit?.plain && this.editing()) parts.push("no colors while editing: large file");
    if (doc?.kind === "image" && doc.w) parts.push(`${doc.w} × ${doc.h}`);
    if (doc?.size) parts.push(mb(doc.size));
    if (doc?.kind === "markdown") {
      const n = this.blocks.filter((b) => b.kind === "code").length, m = this.blocks.filter((b) => b.kind === "mmd");
      if (n) parts.push(plural(n, "code block"));
      if (m.length) { const busy = m.filter((b) => b.d?.pending).length; parts.push(busy ? `rendering ${plural(busy, "diagram")}…` : plural(m.length, "diagram")); }
    }
    const where = this.findWhere();
    if (where) parts.push(where);
    if (this.note) parts.push(this.note);
    if (this.polling && !p.on) parts.push("polling");
    if (this.edit) parts.push(this.editing() ? "editing · Ctrl+S save · Ctrl+E done" : "rendered edits · not saved yet");
    return h_flex().id("pv-foot").h(22).flex_none().px(SIZE.pad + 2).gap(8).items_center().overflow_hidden().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11).text_color(t.dim)
      .children(parts.map((x, i) => div().flex_none().when(i === parts.length - 1, (el) => el.flex_shrink(1).min_w(0).truncate()).child(i ? `· ${x}` : x)))
      .child(div().flex_1())
      .when(Boolean(p.on), (el) => el.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_color(t.muted).child(p.on)));
  }

  body(t) {
    const doc = this.doc;
    if (!this.p.path) return empty(t, "No file selected", "Pick a file to preview it here");
    if (!doc) return this.loading ? empty(t, "Loading…") : empty(t, "Nothing to show");
    if (this.editing()) return this.editView(t);
    if (doc.kind === "markdown") return this.markdownView(t);
    if (doc.kind === "text" && this.code) return this.codeView(t);
    if (doc.kind === "image") return this.imageView(t);
    const icon = doc.kind === "binary" ? "file-text" : "triangle-alert";
    return v_flex().size_full().items_center().justify_center().gap(10).p(24)
      .child(svg(ui(icon)).size(28).text_color(t.dim))
      .child(div().text_size(SIZE.text).text_color(t.muted).text_center().child(doc.message ?? "Cannot preview this file"))
      .when(doc.kind === "binary" && Boolean(doc.size), (el) => el.child(div().text_size(SIZE.small).text_color(t.dim).child(mb(doc.size))));
  }

  /** The editor: the whole file, writable, with the change ruler of the last save. */
  editView(t) {
    const m = this.codeMarks, e = this.edit;
    const rows = Math.max(1, this.doc?.lines ?? 1), pct = (n) => `${(100 * n) / rows}%`;
    const at = (el, from, n) => (2 * from + n <= rows ? el.top(pct(from)) : el.bottom(pct(rows - from - n)));
    return h_flex().size_full().min_h(0)
      .child(div().flex_1().min_w(0).h_full().pt(4).pl(4).border_l(2).border_color(e.dirty ? t.ansi3 : t.accent).child(Editor.new(e.state).size_full()))
      .when(Boolean(m) && !e.dirty, (el) => el.child(div().w(RULER).flex_none().h_full().relative().border_l(1).border_color(t.border).bg(t.chrome)
        .children(m.rulerRuns.map((r) => at(div().absolute().left(3).w(RULER - 7).h(pct(r.n)).min_h(3).rounded(1).bg(r.kind === "a" ? t.ansi2 : t.ansi4), r.from - 1, r.n)))
        .children(m.rulerDels.map((n) => at(div().absolute().left(2).w(RULER - 5).h(2).rounded(1).bg(t.ansi1), n, 0)))));
  }

  // ---- Markdown ------------------------------------------------------------------------

  markdownView(t) {
    const pad = this.p.wide ? 28 : 16, z = this.textZoom;
    return div().id(`pv-doc:${this.p.path}`).size_full().min_h(0).overflow_y_scrollbar()
      .child(h_flex().w_full().justify_center().px(pad).pt(this.p.wide ? 22 : 14).pb(40)
        .child(v_flex().id("pv-col").w_full().max_w(Math.round(COL_W * z)).gap(Math.round(14 * z)).text_size(this.proseSize()).text_color(t.foreground)
          .on_size_change((size, cx) => { const w = Math.round(size.width); if (w !== this.colW) { this.colW = w; cx.notify(); } })
          .children(this.blocks.map((b, i) => this.marked(b, t, b.kind === "md" ? this.prose(b, i, t)
            : b.kind === "pic" ? this.picBlock(b, t)
            : b.kind === "quote" ? h_flex().w_full().items_start().py(2)
              .child(div().w(3).flex_none().self_stretch().rounded(2).bg(t.accent))
              .child(div().flex_1().min_w(0).pl(Math.round(14 * z)).text_color(t.muted).child(this.prose(b, i, t)))
            : b.kind === "mmd" ? this.diagramBlock(b, i, t) : this.codeBlock(b, i, t))))));
  }

  prose(b, i, t) {
    // A section starting a block of its own (after a fence or a quote) keeps its space above.
    const head = i > 0 && b.kind === "md" && /^\s{0,3}#{1,4}\s/.test(b.text);
    return div().w_full().when(head, (el) => el.pt(Math.round(10 * this.textZoom))).child(TextView.markdown(`md-${i}`, lineBreaks(this.markedText(b, t))).selectable(true).on_link_click((url, cx) => this.link(url, cx)));
  }

  /** A block with its find marks, drawn in the column's side padding so nothing moves. */
  marked(b, t, el) {
    return v_flex().w_full().flex_none().relative().child(el)
      .when(Boolean(b.find), (e) => e.child(div().absolute().top(0).bottom(0).right(b.find.current ? -BAR_X - 1 : -BAR_X).w(b.find.current ? 4 : 2).rounded(2).bg(t.accent)))
      .when(Boolean(b.find?.current), (e) => e.child(div().absolute().top(-5).bottom(-5).left(-6).right(-6).rounded(SIZE.card).border_1().border_color(t.accent)));
  }

  /**
   * A fence: a header (language, Copy) over a readonly Editor. An Editor scrolls past its end by
   * max(half its height, 3 rows), so it is laid out that much taller inside a box clipped to the
   * text: it never scrolls itself, and the wheel goes on to the document.
   */
  codeBlock(b, i, t) {
    const id = b.kind === "mmd" ? `${b.id}-src` : `code-${i}`, lh = lineHeight(this.codeFont), pad = Math.round(CODE_PAD * this.textZoom);
    const text = this.rows(b) * lh, slack = Math.max(text, 3 * lh), copied = Boolean(b.copied);
    return v_flex().id(id).w_full().flex_none().rounded(SIZE.card).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
      .child(h_flex().h(SIZE.row + 2).pl(12).pr(4).gap(6).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().size(6).flex_none().rounded(3).bg(b.kind === "mmd" ? t.ansi5 : t.accent))
        .child(div().flex_1().min_w(0).truncate().text_size(SIZE.small).font_semibold().text_color(t.muted).child(lang.fenceLabel(b.kind === "mmd" ? "mermaid" : b.info)))
        .child(h_flex().id(`${id}-copy`).h(20).flex_none().px(6).gap(5).rounded(SIZE.radius - 2).items_center().cursor_pointer()
          .text_color(copied ? t.accent : t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.copyBlock(b, cx))
          .child(svg(ui(copied ? "check" : "copy")).size(12))
          .child(div().text_size(11).child(copied ? "Copied" : "Copy"))))
      .child(div().w_full().h(text + 2 * pad).flex_none().py(pad).pl(4)
        .child(div().w_full().h(text).overflow_hidden().relative()
          .child(div().w_full().h(text + slack).flex_none().child(Editor.new(b.state).size_full()))
          .when(Boolean(b.find) && !b.wrap, (e) => e.children(this.lineMarks(b.find.rows, lh, t, b.find.current ? b.find.at[b.find.k].line : -1)))));
  }

  diagramBlock(b, i, t) {
    const d = b.d ?? { pending: true };
    if (d.ok) {
      const s = this.diagramSize(d.w, d.h);
      return v_flex().id(b.id).w_full().flex_none().rounded(SIZE.card).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
        .child(h_flex().h(SIZE.row + 2).pl(12).pr(4).gap(6).items_center().bg(t.chrome).border_b(1).border_color(t.border)
          .child(div().size(6).flex_none().rounded(3).bg(t.ansi5))
          .child(div().flex_1().min_w(0).truncate().text_size(SIZE.small).font_semibold().text_color(t.muted).child("Mermaid"))
          .child(iconButton(t, `${b.id}-expand`, "expand", (_e, cx) => this.expandDiagram(b, cx), { size: 20 })))
        .child(h_flex().w_full().h(s.h + 24).flex_none().justify_center().items_center().child(image(d.path).w(s.w)));
    }
    if (d.error && b.state) {
      return v_flex().id(b.id).w_full().flex_none().gap(8)
        .child(h_flex().w_full().px(12).py(8).gap(10).items_start().rounded(SIZE.card).border_1().border_color(t.border).bg(t.surface).text_size(SIZE.small)
          .child(svg(ui("triangle-alert")).size(13).flex_none().mt(1).text_color(d.setup ? t.ansi3 : t.ansi1))
          .child(div().flex_1().min_w(0).text_color(d.setup ? t.muted : t.ansi1)
            .when(!d.setup && typeof settings().font_family === "string", (el) => el.font_family(String(settings().font_family))).child(d.error))
          .child(div().id(`${b.id}-retry`).flex_none().cursor_pointer().text_color(t.accent).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.retryDiagram(b, cx)).child("Retry")))
        .child(this.codeBlock(b, i, t));
    }
    return h_flex().id(b.id).w_full().h(Math.round(Math.min(220, 48 + b.lines * 12) * this.textZoom)).flex_none().gap(8).items_center().justify_center()
      .rounded(SIZE.card).border_1().border_color(t.border).bg(t.surface).text_size(SIZE.small).text_color(t.dim)
      .child(div().w(12).flex_none().text_color(t.accent).frames(SPIN, 90).child(SPIN[0]))
      .child("Rendering diagram…");
  }

  // ---- code -----------------------------------------------------------------------------

  /** "full" (gutter of changed lines, outer scroll) or "plain" (the Editor scrolls itself; ruler only). */
  /** Full mode's blame column: on, known, and the file short enough for the full layout. */
  blameShown() { return this.p.wide && this.blameCol && Boolean(this.blame) && this.doc?.kind === "text" && (this.doc.lines ?? 0) <= FULL_MAX && !this.wrapOn(); }

  codeLayout() {
    // While finding, the Editor scrolls itself: it can scroll to a match (an outer box can't).
    if ((!this.codeMarks && !this.blameShown()) || !this.doc || this.wrapOn() || this.ds) return "plain";
    return this.doc.lines <= FULL_MAX ? "full" : "plain";
  }

  /**
   * The whole-file Editor. With changes against HEAD and up to FULL_MAX lines it is laid out at its
   * full height inside a scrolling box, next to a gutter of changed lines; else it scrolls itself.
   * An overview ruler on the right shows the whole file's changes and find hits.
   */
  codeView(t) {
    const editor = Editor.new(this.code).size_full(), m = this.codeMarks, ds = this.ds;
    const hits = ds?.hits.length ? ds.hits : null, cur = hits ? hits[ds.at].line : 0;
    let body;
    if (this.codeLayout() === "plain") {
      body = div().flex_1().min_w(0).h_full().pl(4).child(editor);
      if (!m && !hits) return div().size_full().min_h(0).pt(4).child(body);
    } else {
      // A short file still fills the view: the gutters run to the bottom (H), as in an editor.
      const lh = lineHeight(this.codeFont), text = this.doc.lines * lh, slack = Math.max(text, 3 * lh);
      const H = Math.max(text, (this.codeViewH ?? 0) - 8);
      body = div().id(`pv-code:${this.p.path}`).flex_1().min_w(0).h_full().overflow_y_scrollbar()
        .on_size_change((size, cx) => { const h = Math.round(size.height); if (h !== this.codeViewH) { this.codeViewH = h; cx.notify(); } })
        .child(h_flex().w_full().h(H + 8).flex_none().pt(4).items_start()
          .when(this.blameShown(), (el) => el.child(this.blameColumn(t, lh, H)))
          .child(div().w(GUTTER).h(H).flex_none().relative()
            .when(Boolean(m), (e) => e
              .children(m.runs.map((r) => div().absolute().left(4).w(3).top((r.from - 1) * lh).h(r.n * lh).rounded(1).bg(r.kind === "a" ? t.ansi2 : t.ansi4)))
              .children(m.dels.map((n) => div().absolute().left(2).w(7).h(3).rounded(1).top(Math.max(0, Math.min(text - 3, n * lh - 1.5))).bg(t.ansi1)))))
          .child(div().flex_1().min_w(0).h(H).overflow_hidden().relative()
            .child(div().w_full().h(H + slack).flex_none().child(editor))
            .when(Boolean(hits), (e) => e.children(this.lineMarks(hits.map((h) => h.line - 1), lh, t, cur - 1)))));
    }
    const rows = Math.max(1, this.doc.lines), pct = (n) => `${(100 * n) / rows}%`;
    const at = (el, from, n) => (2 * from + n <= rows ? el.top(pct(from)) : el.bottom(pct(rows - from - n)));
    return h_flex().size_full().min_h(0).child(body)
      .when(Boolean(m) || Boolean(hits), (el) => el.child(div().w(RULER).flex_none().h_full().relative().border_l(1).border_color(t.border).bg(t.chrome)
        .when(Boolean(m), (e) => e
          .children(m.rulerRuns.map((r) => at(div().absolute().left(3).w(RULER - 7).h(pct(r.n)).min_h(3).rounded(1).bg(r.kind === "a" ? t.ansi2 : t.ansi4), r.from - 1, r.n)))
          .children(m.rulerDels.map((n) => at(div().absolute().left(2).w(RULER - 5).h(2).rounded(1).bg(t.ansi1), n, 0))))
        .when(Boolean(hits), (e) => e.children(this.rulerHits(rows).map((r) => at(div().absolute().right(0).w(r === cur - 1 ? RULER - 1 : 4).h(pct(1))
          .min_h(r === cur - 1 ? 3 : 2).bg(r === cur - 1 ? t.foreground : t.accent), r, 1))))));
  }

  /**
   * Full mode's blame column: one block per run of lines from the same commit (who, when), a
   * bar on its left brighter the newer it is. Runs are worked out once per blame.
   */
  blameColumn(t, lh, text) {
    const b = this.blame;
    if (this.blameRuns?.blame !== b) {
      const now = Date.now(), times = b.commits.map((c) => c.time).filter(Boolean);
      const oldest = times.length ? Math.min(...times) : now, span = Math.max(1, now - oldest);
      this.blameRuns = {
        blame: b,
        list: blm.runs(b).filter((r) => r.c >= 0).map((r) => {
          const c = b.commits[r.c];
          const fresh = c.uncommitted ? 1 : 1 - (now - c.time) / span;
          const who = c.uncommitted ? "You" : c.mine ? "You" : c.author || "Unknown";
          return { from: r.from, n: r.n, label: who, when: c.uncommitted ? "now" : ago(c.time, now),
            summary: c.summary, alpha: Math.round(40 + 215 * Math.max(0, Math.min(1, fresh))).toString(16).padStart(2, "0") };
        }),
      };
    }
    const size = Math.max(10, Math.round(this.codeFont * 0.82));
    return div().w(BLAME_W).h(text).flex_none().relative().border_r(1).border_color(t.border).bg(t.chrome)
      .children(this.blameRuns.list.map((r) => h_flex().absolute().left(0).right(0).top(r.from * lh).h(r.n * lh).items_start().border_t(1).border_color(t.border)
        .child(div().w(2).h_full().flex_none().bg(tint(t.accent, r.alpha) ?? t.accent))
        .child(h_flex().flex_1().min_w(0).h(lh).px(6).gap(6).items_center().text_size(size)
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.summary ? `${r.label} \u00b7 ${r.summary}` : r.label))
          .child(div().flex_none().text_color(t.dim).child(r.when)))));
  }

  /** The find hits' rows (from 0) for the ruler, merged to RULER_MAX; kept until the hits or the current one change. */
  rulerHits(rows) {
    const ds = this.ds, cur = ds.hits[ds.at].line - 1;
    if (ds.ruler?.hits !== ds.hits || ds.ruler.cur !== cur || ds.ruler.rows !== rows) ds.ruler = { hits: ds.hits, cur, rows, list: thin(ds.hits.map((h) => h.line - 1), rows, cur) };
    return ds.ruler.list;
  }

  /** Rows (from 0) with matches: a tint across the row and a bar at the right edge; `at` stronger. */
  lineMarks(rows, lh, t, at = -1) {
    const soft = tint(t.accent, "1c"), strong = tint(t.accent, "3a");
    return rows.flatMap((r) => {
      const on = r === at, out = [];
      const bg = on ? strong : soft;
      if (bg) out.push(div().absolute().left(0).right(0).top(r * lh).h(lh).bg(bg));
      out.push(div().absolute().right(0).w(on ? 3 : 2).top(r * lh).h(lh).bg(t.accent));
      return out;
    });
  }

  // ---- images ---------------------------------------------------------------------------

  imageView(t) {
    const d = this.doc, z = this.textZoom, pad = 16;
    const box = this.width ? this.width - 2 * pad : 600;
    let w = null, h = null;
    if (d.w && d.h) {
      const fit = Math.min(1, box / d.w);
      w = Math.max(1, Math.round(d.w * fit * z));
      h = Math.round((w * d.h) / d.w);
    }
    const img = image(d.src);
    return div().size_full().min_h(0).relative()
      .child(div().id("pv-image").size_full().overflow_scroll()
        .child(h_flex().min_w_full().min_h_full().p(pad).items_center().justify_center()
          .child(div().flex_none().rounded(SIZE.radius).border_1().border_color(t.border).bg(t.surface).p(1)
            .child(w ? img.w(w).h(h) : img.max_w(box)))))
      .child(Scrollbar.new("pv-image").absolute().inset_0());
  }
}
