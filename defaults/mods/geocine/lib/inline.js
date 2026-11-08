// Runs a View class as part of another view's render: same copy, same cx, so Herdr's live
// updates reach it. (A nested entity from cx.new isn't redrawn when focus or spaces change.)
// Not `new Class(props)`: gpui-kit's View constructor already runs init (with an async cx), so
// init would run twice, doubling every timer, watch and refresh. The views have no class fields.
export function inline(Class, props, cx) {
  const view = Object.create(Class.prototype);
  view.init?.(props, cx);
  return view;
}
