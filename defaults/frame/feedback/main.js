import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, feedbackClearImages } from "herdr";

// Feedback isn't supported in this forked build (src/feedback.rs): this
// window, opened wherever feedback was offered (app.feedback), only says so.
const NOT_SUPPORTED = "Feedback is not supported in this forked build.";

export default class Feedback extends View {
  init(_props, cx) {
    // Screenshots an earlier build kept for its form.
    feedbackClearImages();
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  close() { closeOverlay(props()?.overlay); }

  render(_cx) {
    const t = theme();
    return v_flex().id("feedback").track_focus(this.handle).w_full().bg(t.popover)
      .on_key_down((e, cx) => { if (e.key === "escape" || e.key === "enter") { this.close(); cx.stop_propagation(); } })
      // The title drags the window.
      .child(div().flex_none().px(24).py(18).cursor_grab().text_size(19).font_semibold().text_color(t.foreground).child("Feedback"))
      .child(div().px(24).text_size(14).text_color(t.muted).child(NOT_SUPPORTED))
      .child(h_flex().flex_none().px(24).py(16).justify_end().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().id("feedback-close").px(14).py(7).rounded(7).border_1().border_color(t.border).bg(t.raised).text_color(t.muted)
          .cursor_pointer().on_click(() => this.close()).child("Close")));
  }
}
