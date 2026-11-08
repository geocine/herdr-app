// Runs a View class as part of another view's render: same copy, same cx, so Herdr's live
// updates reach it. (A nested entity from cx.new isn't redrawn when focus or spaces change.)
export function inline(Class, props, cx) {
  const view = new Class(props);
  view.init?.(props, cx);
  return view;
}
