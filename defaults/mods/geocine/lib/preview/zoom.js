// The expanded view of one rendered Mermaid diagram, over the preview: opens fitted, zooms in
// steps and scrolls on both axes. Zooming past what the -s 2 PNG holds asks mermaid-cli for a
// sharper render.
// Adapted from bohumil/herdr-file-preview `zoom.js` (MIT). See NOTICE.md.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { SIZE, iconButton, ui } from "../ui.js";
import { scaledKey } from "./mermaid.js";

// Esc bound to this context outranks the app's Esc, which would close a whole dialog.
export const ZOOM_CONTEXT = "GeocinePreviewZoom", ZOOM_ESCAPE = "geocine_preview_zoom_escape";

export const STEP = 1.25;
const MIN = 0.25, MAX = 8;   // zoom, relative to fit
const DEVICE = 2;            // display scale assumed: no API reports it
const BASE = 2, SHARP = 4;   // -s of the document's PNG, and of the sharper one (the cap)
const PAD = 24;
const VIEW = "pv-zoom-view";
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** What a key does in the expanded view: "in" | "out" | "fit" | "close" | null. */
export function zoomKey(e) {
  const m = e.modifiers;
  if (m.platform || m.control || m.alt) return null;
  const k = e.key, c = e.key_char;
  if (k === "escape" || k === "backspace") return "close";
  if (c === "+" || k === "+" || k === "=") return "in";
  if (c === "-" || k === "-") return "out";
  if (k === "0") return "fit";
  return null;
}

export class Zoom {
  /** d = { key, source, config, path, w, h }: the -s 2 render. */
  constructor(d, mermaid, label) {
    this.d = d;
    this.mermaid = mermaid;
    this.label = label;
    this.natural = d.w / BASE;   // logical width at 100 %
    this.z = 1;                  // × fit
    this.box = null;             // measured viewport
    this.img = { path: d.path, w: d.w, scale: BASE };
    this.sharpening = false;
    this.failed = null;
    this.closed = false;
  }

  /** Displayed width; null until the viewport is measured. */
  width() {
    if (!this.box) return null;
    const aw = Math.max(40, this.box.width - 2 * PAD), ah = Math.max(40, this.box.height - 2 * PAD);
    return Math.min(aw, (ah * this.d.w) / this.d.h) * this.z;
  }

  act(a, cx) {
    if (a === "in") this.z = Math.min(MAX, this.z * STEP);
    else if (a === "out") this.z = Math.max(MIN, this.z / STEP);
    else if (a === "fit") this.z = 1;
    this.sharpen(cx);
  }

  sized(box, cx) {
    const w = Math.round(box.width), h = Math.round(box.height);
    if (this.box && this.box.width === w && this.box.height === h) return;
    this.box = { width: w, height: h };
    this.sharpen(cx);
    cx.notify();
  }

  /** Asks once for the -s 4 PNG when the shown one would be upscaled; swaps it in when it exists. */
  sharpen(cx) {
    const w = this.width();
    if (w === null || this.img.scale >= SHARP || this.sharpening || this.failed || this.closed) return;
    if (w * DEVICE <= this.img.w) return;
    this.sharpening = true;
    this.mermaid.request({ key: scaledKey(this.d.key, SHARP), source: this.d.source, config: this.d.config, scale: SHARP }, {
      alive: () => !this.closed,
      done: (res, cx) => {
        this.sharpening = false;
        if (res.ok) this.img = { path: res.path, w: res.w, scale: SHARP };
        else this.failed = res.error;
        cx.notify();
      },
    }, cx);
  }

  render(t, focus, { onKey, onClose, onEscape }) {
    const w = this.width(), pct = w === null ? "" : `${Math.round((100 * w) / this.natural)}%`;
    const h = w === null ? 0 : (w * this.d.h) / this.d.w;
    const box = this.box ?? { width: 0, height: 0 };
    return v_flex().id("pv-zoom").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .key_context(ZOOM_CONTEXT).on_action(ZOOM_ESCAPE, (_e, cx) => onEscape(cx))
      .track_focus(focus).on_key_down(onKey)
      .child(h_flex().h(SIZE.subheader).flex_none().px(SIZE.pad).gap(4).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(svg(ui("expand")).size(SIZE.icon).flex_none().text_color(t.accent))
        .child(div().flex_1().min_w(0).pl(2).truncate().text_size(SIZE.small).text_color(t.muted).child(this.label))
        .when(this.sharpening, (el) => el.child(div().w(10).flex_none().text_color(t.accent).frames(SPIN, 90).child(SPIN[0])))
        .child(div().flex_none().pr(4).text_size(SIZE.small).text_color(t.dim)
          .child(this.sharpening ? "sharpening…" : this.failed ? "sharper render failed" : "+ − zoom · 0 fit · Esc close"))
        .child(iconButton(t, "pv-zoom-out", "zoom-out", (_e, cx) => { this.act("out", cx); cx.notify(); }))
        .child(div().w(42).flex_none().text_center().text_size(SIZE.small).text_color(this.z === 1 ? t.muted : t.foreground).child(pct))
        .child(iconButton(t, "pv-zoom-in", "zoom-in", (_e, cx) => { this.act("in", cx); cx.notify(); }))
        .child(iconButton(t, "pv-zoom-fit", "fit", (_e, cx) => { this.act("fit", cx); cx.notify(); }))
        .child(iconButton(t, "pv-zoom-close", "close", (_e, cx) => onClose(cx))))
      // Native overflow on both axes plus a Scrollbar paired by id.
      .child(div().flex_1().min_h(0).w_full().relative()
        .child(div().id(VIEW).size_full().overflow_scroll()
          .on_size_change((b, cx) => this.sized(b, cx))
          .when(w !== null, (el) => el.child(h_flex().flex_none()
            .w(Math.max(box.width, w + 2 * PAD)).h(Math.max(box.height, h + 2 * PAD)).items_center().justify_center()
            .child(image(this.img.path).w(w)))))
        .child(Scrollbar.new(VIEW).absolute().inset_0()));
  }
}
