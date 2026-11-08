// A commit's details: subject, ref labels, hash, author, dates, parents, the message body and the
// files it changed. The header comes from the history already loaded, so it shows the moment the
// commit is picked; what git adds (body, files) lands below it.
// After rabeeh-ta/herdr-git-graph's details pane and file-preview's commit view (both MIT).
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { SIZE, ui, row, section, badge, counts, iconButton, textButton } from "../../lib/ui.js";
import { iconFor } from "../../lib/icons.js";
import { statusColor, statusLetter } from "../../lib/git.js";
import { baseName, dirName } from "../../lib/where.js";
import { labelsOf, stamp, relative } from "./ops.js";
import { label, laneColors } from "./table.js";

const meta = (t, key, value) => h_flex().w_full().min_w(0).gap(10).items_start().text_size(SIZE.small)
  .child(div().w(64).flex_none().pt(1).text_color(t.dim).child(key))
  .child(div().flex_1().min_w(0).child(value));

/** The overview column. g: the graph view (state and handlers); commit: a table row's commit. */
export function overview(g, t, commit, mono) {
  const d = g.detailsFor(commit), lane = g.laneOf(commit.hash), color = laneColors(t)[lane % 12];
  const scroll = v_flex().id("graph-overview").size_full().min_h(0).overflow_y_scrollbar().pb(12);
  const body = v_flex().px(14).pt(12).pb(4).gap(8);
  if (commit.uncommitted) {
    return scroll.child(body
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Uncommitted changes"))
      .child(h_flex().gap(6).child(textButton(t, "graph-open-changes", "Open in Changes", (_e, cx) => g.showChanges(cx), { icon: "changes" }))))
      .child(files(g, t, commit, d));
  }
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
  return scroll.child(body
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
      .text_size(SIZE.small).text_color(t.muted).children(d.body.split(/\r?\n/).map((line) => div().min_h(16).child(line || " "))))))
    .child(files(g, t, commit, d));
}

function files(g, t, commit, d) {
  if (!d) return div().px(14).pt(6).text_size(SIZE.small).text_color(t.dim).child("Loading files…");
  if (d.error) return div().px(14).pt(6).text_size(SIZE.small).text_color(t.ansi1).child(d.error);
  const add = d.files.reduce((n, f) => n + f.add, 0), del = d.files.reduce((n, f) => n + f.del, 0), n = d.files.length + d.more;
  const open = g.file;
  return v_flex().pt(6)
    .child(section(t, "graph-files", "Changed files", { count: n, actions: [counts(t, add, del)] }).px(14))
    .when(n === 0, (e) => e.child(div().px(SIZE.pad).text_size(SIZE.small).text_color(t.dim).child("No file changes")))
    .children(d.files.map((f, i) => {
      const dir = dirName(f.path), selected = open?.path === f.path && g.tab === "file";
      return row(t, `graph-file-${i}`, { selected, onClick: (_e, cx) => g.openFile(commit, f, cx) })
        .px(14)
        .child(badge(t, statusLetter(f.status), statusColor(t, f.status)))
        .child(image(iconFor(f.path)).size(SIZE.icon + 1).flex_none())
        .child(h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(div().flex_none().max_w_full().truncate().text_color(f.status === "D" ? t.muted : t.foreground).child(baseName(f.path)))
          .when(Boolean(f.from), (e) => e.child(div().flex_none().text_size(SIZE.small).text_color(t.dim).child(`← ${baseName(f.from)}`)))
          .when(Boolean(dir) && dir !== ".", (e) => e.child(div().min_w(0).truncate().text_size(SIZE.small).text_color(t.dim).child(dir))))
        .child(f.binary ? div().text_size(SIZE.small).text_color(t.dim).child("bin") : counts(t, f.add, f.del));
    }))
    .when(d.more > 0, (e) => e.child(div().px(14).py(4).text_size(SIZE.small).text_color(t.dim).child(`and ${d.more} more`)));
}
