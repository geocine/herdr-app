// The graph's overlays, mounted by this same view with props.role: the right-click menu (a popup at
// the pointer), the dialog an action asks first, and the Manygit settings popup.
// Ported from rabeeh-ta/herdr-git-graph `menu.js`, `dialog.js` and `settings.js` (MIT,
// (c) 2026 Rabeeh T A), restyled with lib/ui.js. See NOTICE.md.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, notify, theme, run, shared, setShared } from "herdr";
import { SIZE, ui } from "../../lib/ui.js";
import { menuFor, dialogFor, initialValues, validate, destroys, isDanger, MENU } from "./ops.js";
import { perform, openDialog, showChanges } from "./act.js";
import { DEPTH, depthOf } from "./repos.js";

export const DEPTH_KEY = "graph.depth";
const stop = (_e, cx) => cx.stop_propagation();

// A check box, as every Geocine dialog draws one.
export const checkBox = (t, on, danger = false) => div().size(15).flex_none().rounded(4).border_1()
  .border_color(on ? (danger ? t.ansi1 : t.accent) : t.input).when(on, (e) => e.bg(danger ? t.ansi1 : t.accent))
  .flex().items_center().justify_center()
  .when(on, (e) => e.child(svg(ui("check")).size(11).text_color(t.accent_foreground)));

export class Menu {
  init(cx) {
    const { target, ctx } = props();
    this.items = menuFor(target, ctx);
    this.at = -1;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(i, cx) {
    const it = this.items[i], { overlay, ctx } = props();
    if (!it || it.separator || this.busy !== undefined) return;
    const a = it.action;
    if (a.type === "newTab") { closeOverlay(overlay); run("tab.new", { folder: a.folder }); }
    else if (a.type === "openUrl") { closeOverlay(overlay); cx.open_url(a.url); }
    else if (a.type === "copy") {
      cx.write_to_clipboard(a.text);
      closeOverlay(overlay);
      notify({ title: "Copied", body: a.text, level: "success", timeout: 2000 });
    } else if (a.type === "showChanges") { closeOverlay(overlay); showChanges(ctx.fullOverlay); }
    else if (openDialog(a, ctx)) closeOverlay(overlay);
    else {
      // Runs here, then closes: a closed popup's tasks would be cancelled.
      this.busy = i;
      cx.spawn(async (cx) => { await perform(a, {}, ctx); closeOverlay(overlay); cx.notify(); });
    }
    cx.notify();
  }

  move(step) {
    const n = this.items.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.at + step * k + n * 2) % n;
      if (!this.items[i].separator) { this.at = i; return; }
    }
  }

  render() {
    const t = theme();
    return v_flex().id("graph-menu").track_focus(this.handle).size_full().min_h(0).p(MENU.PAD).bg(t.popover).text_size(SIZE.text).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.move(1);
        else if (e.key === "up") this.move(-1);
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .children(this.items.map((it, i) => {
        if (it.separator) return div().mx(6).my(4).h(1).flex_none().bg(t.border);
        const danger = isDanger(it.action), lit = i === this.at || this.busy === i;
        return h_flex().id(`gm-${i}`).h(MENU.ROW).flex_none().px(8).gap(9).rounded(SIZE.radius).items_center().cursor_pointer()
          .text_color(danger ? t.ansi1 : t.foreground).when(lit, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_mouse_down("left", stop).on_click((_e, cx) => this.choose(i, cx))
          .child(svg(ui(it.icon)).size(SIZE.icon).flex_none().text_color(danger ? t.ansi1 : t.muted))
          .child(div().flex_1().min_w(0).truncate().child(this.busy === i ? "Working…" : it.label));
      }));
  }
}

export class Dialog {
  init(cx) {
    const { action, ctx } = props();
    this.spec = dialogFor(action, ctx);
    this.values = initialValues(action, ctx);
    this.focusedInput = 0;
    this.inputs = (this.spec.inputs ?? []).map((field, i) => {
      const state = InputState.new({ value: field.value ?? "" });
      state.on("change", (_e, cx) => { this.values[field.id] = state.value(); this.error = null; cx.notify(); });
      state.on("submit", (_e, cx) => this.confirm(cx));
      state.on("focus", (_e, cx) => { this.focusedInput = i; cx.notify(); });
      state.on("blur", (_e, cx) => { if (this.focusedInput === i) this.focusedInput = -1; cx.notify(); });
      return { field, state };
    });
    this.handle = cx.focus_handle();
    const first = this.inputs[0];
    if (first) {
      if (first.field.value) first.state.set_selected_range({ start: 0, end: first.field.value.length });
      first.state.focus();
      cx.timer.after(400, () => first.state.focus());
    } else { this.focusedInput = -1; this.handle.focus(); cx.timer.after(300, () => this.handle.focus()); }
  }

  confirm(cx) {
    if (this.busy) return;
    const { action, ctx, overlay } = props();
    const problem = validate(action, this.values, ctx);
    if (problem) { this.error = problem; cx.notify(); return; }
    this.busy = true; this.error = null;
    cx.spawn(async (cx) => {
      const result = await perform(action, this.values, ctx, { toast: false });
      this.busy = false;
      if (result.ok) closeOverlay(overlay);
      else { this.error = result.message; cx.notify(); }
    });
    cx.notify();
  }

  render() {
    const t = theme(), s = this.spec, { action, ctx } = props(), danger = destroys(action, this.values, ctx);
    const label = (text) => div().pt(12).pb(6).text_size(SIZE.small).text_color(t.dim).child(text);
    const button = (id, text, primary, onClick) => h_flex().id(id).h(30).px(14).items_center().rounded(SIZE.radius).border_1()
      .border_color(primary ? (danger ? t.ansi1 : t.solid) : t.input).bg(primary ? (danger ? t.ansi1 : t.solid) : t.raised)
      .text_color(primary ? (danger ? t.background : t.solid_foreground) : t.foreground).text_size(SIZE.text).font_medium().cursor_pointer()
      .hover((st) => st.opacity(0.88)).on_mouse_down("left", stop).on_click(onClick).child(text);
    return v_flex().id("graph-dialog").track_focus(this.handle).size_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground).text_size(SIZE.text)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props().overlay);
        else if (e.key === "enter" && this.focusedInput < 0) this.confirm(cx);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(14).font_semibold().child(s.title))
        .child(div().text_size(SIZE.small).text_color(t.dim).child("Esc")))
      .when(Boolean(s.detail), (el) => el.child(div().pt(8).text_color(t.muted).child(s.detail)))
      .children(this.inputs.map(({ field, state }, i) => v_flex()
        .child(label(field.label))
        .child(Input.new(state).h(32).px(10).rounded(SIZE.radius).border_1().border_color(this.focusedInput === i ? t.accent : t.input)
          .bg(t.background).text_size(SIZE.text).text_color(t.foreground))))
      .when(Boolean(s.choice), (el) => el.child(label(s.choice.label)).children(s.choice.options.map((o) => {
        const on = this.values[s.choice.id] === o.value, edge = o.danger ? t.ansi1 : t.accent;
        return h_flex().id(`gd-choice-${o.value}`).h(36).mb(4).px(10).gap(10).items_center().rounded(SIZE.card).border_1().cursor_pointer()
          .border_color(on ? edge : t.border).when(on, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => { this.values[s.choice.id] = o.value; this.error = null; cx.notify(); })
          .child(div().size(14).flex_none().rounded(7).border_1().border_color(on ? edge : t.input).flex().items_center().justify_center()
            .when(on, (e) => e.child(div().size(6).rounded(3).bg(edge))))
          .child(div().font_medium().child(o.label))
          .when(Boolean(o.detail), (e) => e.child(div().text_size(SIZE.small).text_color(o.danger ? t.ansi1 : t.dim).child(o.detail)));
      })))
      .children((s.checks ?? []).map((c) => {
        const on = Boolean(this.values[c.id]);
        return h_flex().id(`gd-check-${c.id}`).pt(12).gap(9).items_center().cursor_pointer()
          .on_click((_e, cx) => { this.values[c.id] = !on; cx.notify(); })
          .child(checkBox(t, on, c.danger))
          .child(div().text_color(c.danger && on ? t.ansi1 : t.foreground).child(c.label));
      }))
      .when(Boolean(this.error), (el) => el.child(div().pt(12).text_size(SIZE.small).text_color(t.ansi1).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().pt(16).gap(8).justify_end()
        .child(button("gd-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("gd-ok", this.busy ? "Working…" : s.confirm, true, (_e, cx) => this.confirm(cx))));
  }
}

// The gear's popup over the Manygit list: how deep to search for repositories.
export class Settings {
  init() {
    this.state = InputState.new({ value: String(depthOf(shared(DEPTH_KEY))) });
    this.valid = true;
    // A number from 1 to 5 applies as it's typed; anything else only turns the box red.
    this.state.on("change", (_e, cx) => {
      const text = this.state.value().trim(), n = Number(text);
      this.valid = /^\d+$/.test(text) && n >= DEPTH.min && n <= DEPTH.max;
      if (this.valid) setShared(DEPTH_KEY, n);
      cx.notify();
    });
    this.state.on("submit", () => { if (this.valid) closeOverlay(props().overlay); });
    this.state.set_selected_range({ start: 0, end: this.state.value().length });
    this.state.focus();
  }

  render() {
    const t = theme();
    return v_flex().id("graph-settings").size_full().p(12).gap(6).bg(t.popover).text_size(SIZE.text).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape" || e.key === "enter") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(h_flex().h(30).gap(10).items_center()
        .child(div().flex_1().font_medium().child("Search depth"))
        .child(Input.new(this.state).w(56).h(28).px(8).rounded(SIZE.radius).border_1().border_color(this.valid ? t.input : t.ansi1)
          .bg(t.background).text_size(SIZE.text).text_color(t.foreground)))
      .child(div().text_size(SIZE.small).text_color(t.dim).child(`Folders below this one, ${DEPTH.min} to ${DEPTH.max}`));
  }
}
