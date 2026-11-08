// A commit's details: subject, ref labels, hash, author, dates, parents, the message body and the
// files it changed. The header comes from the history already loaded, so it shows the moment the
// commit is picked; what git adds (body, files) lands below it.
// After rabeeh-ta/herdr-git-graph's details pane and file-preview's commit view (both MIT).
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar } from "gpui-base";
import { SIZE, ui, row, section, badge, counts, iconButton, textButton } from "../../lib/ui.js";
import { iconFor } from "../../lib/icons.js";
import { statusColor, statusLetter } from "../../lib/git.js";
import { baseName, dirName } from "../../lib/where.js";
import { labelsOf, stamp, relative } from "./ops.js";
import { label, laneColors } from "./table.js";

const meta = (t, key, value) => h_flex().w_full().min_w(0).gap(10).items_start().text_size(SIZE.small)
  .child(div().w(64).flex_none().pt(1).text_color(t.dim).child(key))
  .child(div().flex_1().min_w(0).child(value));

// A render has about 50 ms (400 file rows took 30-40 ms): past this many files, the header scrolls
// on its own above a virtual list of the files.
const MANY = 100;

/** The overview column. g: the graph view (state and handlers); commit: a table row's commit. */
export function overview(g, t, commit, mono) {
  const d = g.detailsFor(commit);
  const body = commit.uncommitted ? v_flex().px(14).pt(12).pb(4).gap(8)
    .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Uncommitted changes"))
    .child(h_flex().gap(6).child(textButton(t, "graph-open-changes", "Open in Changes", (_e, cx) => g.showChanges(cx), { icon: "changes" })))
    : header(g, t, commit, mono, d);
  if (d && !d.error && d.files.length > MANY) {
    return v_flex().size_full().min_h(0)
      .child(v_flex().id("graph-overview").flex_none().max_h_1_2().overflow_y_scroll().child(body))
      .child(manyFiles(g, t, commit, d));
  }
  return v_flex().id("graph-overview").size_full().min_h(0).overflow_y_scrollbar().pb(12).child(body).child(files(g, t, commit, d));
}

function header(g, t, commit, mono, d) {
  const lane = g.laneOf(commit.hash), color = laneColors(t)[lane % 12];
  const body = v_flex().px(14).pt(12).pb(4).gap(8);
  const labels = labelsOf(commit, true);
  const hashLine = h_flex().gap(4).items_center().min_w(0)
    .child(div().min_w(0).truncate().font_family(mono).text_size(11.5).text_color(t.accent).child(commit.hash))
    .child(iconButton(t, "graph-copy-hash", "copy", (_e, cx) => g.copy(commit.hash, cx), { size: 20 }));
  const parents = commit.parents.length
    ? h_flex().flex_wrap().gap(4).children(commit.parents.map((p, i) => h_flex().id(`graph-parent-${i}`).h(18).px(6).gap(4).items_center().rounded(4)
        .bg(t.surface).border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover).border_color(t.accent))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => g.goTo(p, cx))
        .child(svg(ui("git-commit")).size(11).text_color(t.muted))
        .child(div().font_family(mono).text_size(11).text_color(t.foreground).child(p.slice(0, 8)))))
    : div().text_color(t.dim).child("none (root commit)");
  const who = (name, email) => h_flex().min_w(0).gap(4).child(div().flex_none().text_color(t.foreground).child(name ?? ""))
    .when(Boolean(email), (e) => e.child(div().min_w(0).truncate().text_color(t.dim).child(`<${email}>`)));
  const when = (s) => h_flex().gap(6).child(div().text_color(t.foreground).child(stamp(s))).child(div().text_color(t.dim).child(relative(s)));
  return body
    .child(div().text_size(14).font_semibold().text_color(t.foreground).child(commit.subject || "(no subject)"))
    .when(labels.length > 0, (e) => e.child(h_flex().flex_wrap().gap(5).children(labels.map((l) => label(l, color, t, mono, { fixed: false })))))
    .child(v_flex().pt(2).gap(6)
      .child(meta(t, "Commit", hashLine))
      .child(meta(t, "Author", who(commit.author, commit.email)))
      .child(meta(t, "Date", when(commit.time)))
      .when(Boolean(d?.committer) && (d.committer !== commit.author || Math.abs(d.committed - commit.time) > 60), (e) => e
        .child(meta(t, "Committer", v_flex().gap(2).child(who(d.committer, d.committerEmail)).child(when(d.committed)))))
      .child(meta(t, "Parents", parents)))
    .when(Boolean(d?.body), (e) => e.child(v_flex().mt(4).p(10).rounded(SIZE.radius).bg(t.surface).border_1().border_color(t.border)
      .text_size(SIZE.small).text_color(t.muted).children(d.body.split(/\r?\n/).map((line) => div().min_h(16).child(line || " ")))));
}

// The files' header, with the line counts summed once per commit (not every frame).
function filesHeader(t, d) {
  d.sums ??= { add: d.files.reduce((n, f) => n + f.add, 0), del: d.files.reduce((n, f) => n + f.del, 0) };
  return section(t, "graph-files", "Changed files", { count: d.files.length + d.more, actions: [counts(t, d.sums.add, d.sums.del)] }).px(14);
}

// One file's row. Without onClick it holds no handler, so a virtual list can draw it.
function fileRow(g, t, commit, f, i, onClick) {
  const dir = dirName(f.path), selected = g.file?.path === f.path && g.tab === "file";
  return row(t, `graph-file-${i}`, { selected, onClick })
    .px(14)
    .child(badge(t, statusLetter(f.status), statusColor(t, f.status)))
    .child(image(iconFor(f.path)).size(SIZE.icon + 1).flex_none())
    .child(h_flex().flex_1().min_w(0).gap(6).items_center()
      .child(div().flex_none().max_w_full().truncate().text_color(f.status === "D" ? t.muted : t.foreground).child(baseName(f.path)))
      .when(Boolean(f.from), (e) => e.child(div().flex_none().text_size(SIZE.small).text_color(t.dim).child(`← ${baseName(f.from)}`)))
      .when(Boolean(dir) && dir !== ".", (e) => e.child(div().min_w(0).truncate().text_size(SIZE.small).text_color(t.dim).child(dir))))
    .child(f.binary ? div().text_size(SIZE.small).text_color(t.dim).child("bin") : counts(t, f.add, f.del));
}

const more = (t, d) => div().px(14).py(4).text_size(SIZE.small).text_color(t.dim).child(`and ${d.more} more`);

function files(g, t, commit, d) {
  if (!d) return div().px(14).pt(6).text_size(SIZE.small).text_color(t.dim).child("Loading files…");
  if (d.error) return div().px(14).pt(6).text_size(SIZE.small).text_color(t.ansi1).child(d.error);
  const n = d.files.length + d.more;
  return v_flex().pt(6)
    .child(filesHeader(t, d))
    .when(n === 0, (e) => e.child(div().px(SIZE.pad).text_size(SIZE.small).text_color(t.dim).child("No file changes")))
    .children(d.files.map((f, i) => fileRow(g, t, commit, f, i, (_e, cx) => g.openFile(commit, f, cx))))
    .when(d.more > 0, (e) => e.child(more(t, d)));
}

// Many files: a virtual list (only the rows on screen are drawn); the list takes the clicks.
function manyFiles(g, t, commit, d) {
  const id = `${g.listId}-files`;
  return v_flex().flex_1().min_h(0).pt(6)
    .child(filesHeader(t, d))
    .child(div().flex_1().min_h(0).relative()
      .child(v_virtual_list(id, d.files.length, SIZE.row, (i) => String(i),
        (range) => d.files.slice(range.start, range.end).map((f, k) => fileRow(g, t, commit, f, range.start + k)))
        .on_item_click((key, cx) => { const f = d.files[Number(key)]; if (f) g.openFile(commit, f, cx); })
        .size_full())
      .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0()))
    .when(d.more > 0, (e) => e.child(more(t, d)));
}
