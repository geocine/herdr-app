// Git for the graph, with no herdr imports: reading the history, the labels on each row and
// where they sit, and the actions behind the menus. Commands are argv arrays, never a shell line.
// Ported from rabeeh-ta/herdr-git-graph `git.js` (MIT, (c) 2026 Rabeeh T A). See NOTICE.md.

export const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"];
export const UNCOMMITTED = "*";
// Git's pretty fields are NUL-free strings; -z terminates each seven-field record.
const FORMAT = "%H%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s";
export const objectId = (s) => typeof s === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s);
export const refName = (s) => typeof s === "string" && s.length > 0 && !/^[-/]/.test(s)
  && !/[\x00-\x20\x7f~^:?*\[\\]/.test(s) && !s.includes("..") && !s.includes("@{")
  && s !== "@" && !s.endsWith(".") && s.split("/").every((p) => p && !p.startsWith(".") && !p.endsWith(".lock"));

function checkCommit(commit) {
  if (!objectId(commit?.hash) || !Array.isArray(commit.parents) || !commit.parents.every(objectId)) throw new Error("Invalid commit identity");
}

// all: every local branch, tag (and with remotes, remote branch) and HEAD. Not `--all`: that also walks
// other tools' private refs (refs/t3/checkpoints/*), which show up as orphan commits. Current branch:
// HEAD, plus its upstream when remotes show (what isn't pulled or pushed yet, as file-preview does).
// `--ignore-missing` keeps a repository with no commits an empty log.
export function logArgs({ all, remotes, limit, upstream }) {
  const scope = all ? ["--branches", "--tags", ...(remotes ? ["--remotes"] : []), "--ignore-missing", "HEAD"]
    : ["--ignore-missing", "HEAD", ...(remotes && upstream ? [upstream] : [])];
  return ["log", "-z", ...scope, "--date-order", "--decorate=full", `-n${limit}`, `--format=${FORMAT}`];
}

export function parseRefs(text) {
  const refs = [];
  for (let name of text ? text.split(", ") : []) {
    const head = name.startsWith("HEAD -> ");
    if (head) name = name.slice(8);
    if (name === "HEAD") refs.push({ kind: "detached", name: "HEAD" });
    else if (name.startsWith("refs/heads/") && refName(name.slice(11))) refs.push({ kind: "branch", name: name.slice(11), head });
    else if (name.startsWith("tag: refs/tags/") && refName(name.slice(15))) refs.push({ kind: "tag", name: name.slice(15) });
    else if (name.startsWith("refs/remotes/") && !name.endsWith("/HEAD") && refName(name.slice(13))) refs.push({ kind: "remote", name: name.slice(13) });
  }
  return refs;
}

export function parseLog(text) {
  if (!text) return [];
  const fields = text.split("\0");
  if (fields.pop() !== "" || fields.length % 7 !== 0) throw new Error("Invalid history framing");
  const commits = [];
  for (let i = 0; i < fields.length; i += 7) {
    const [hash, parents, author, email, time, refs, subject] = fields.slice(i, i + 7);
    const parsed = parseRefs(refs);
    const commit = { hash: hash.replace(/^\n/, ""), parents: parents ? parents.split(" ") : [], author, email, time: Number(time), refs: parsed, subject,
      head: parsed.some((r) => r.head || r.kind === "detached") };
    checkCommit(commit);
    if (!/^\d+$/.test(time) || !Number.isSafeInteger(commit.time)) throw new Error("Invalid commit time");
    commits.push(commit);
  }
  return commits;
}

// `git status --porcelain=v1 -z --no-renames`: one NUL-terminated "XY path" per file.
export function parseStatus(text) {
  return text.split("\0").filter(Boolean).map((entry) => {
    const xy = entry.slice(0, 2), path = entry.slice(3);
    const status = xy === "??" ? "?" : xy.includes("U") || xy === "AA" || xy === "DD" ? "U" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
    // staged: the index differs from HEAD (conflicts aren't staged changes).
    return { path, status, untracked: xy === "??", staged: status !== "U" && xy[0] !== " " && xy[0] !== "?" };
  });
}

// The working tree's changes as the newest row, drawn dashed to HEAD.
export function withUncommitted(commits, changes, head) {
  if (!changes) return commits;
  return [{ hash: UNCOMMITTED, parents: head ? [head] : [], uncommitted: true, dashed: true, refs: [], head: false,
    subject: `Uncommitted changes (${changes})`, author: "", email: "", time: null }, ...commits];
}

// Labels are drawn at these exact widths (monospace text, fixed padding and icon), so a press can be
// matched to the label under it: a virtual list's rows can't hold their own handlers.
export const LABEL = { CHAR: 6.6, PAD: 5, ICON: 13, GAP: 6, MAX: 22, FONT: 11, H: 18 };
const fit = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const partWidth = (part) => Math.ceil(LABEL.PAD * 2 + (part.icon ? LABEL.ICON : 0) + part.text.length * LABEL.CHAR) + 1;

export function labelsOf(commit, remotesShown = true) {
  const labels = [], remotes = remotesShown ? commit.refs.filter((r) => r.kind === "remote") : [], paired = new Set();
  for (const ref of commit.refs) {
    if (ref.kind === "detached") labels.push({ kind: "head", head: true, parts: [{ kind: "head", name: "HEAD", text: "HEAD" }] });
    if (ref.kind !== "branch") continue;
    // A remote branch with the same name rides on its local branch's label, as in Git Graph.
    const parts = [{ kind: "branch", name: ref.name, text: fit(ref.name, LABEL.MAX), icon: true, head: ref.head }];
    for (const remote of remotes) {
      const slash = remote.name.indexOf("/");
      if (remote.name.slice(slash + 1) !== ref.name || paired.has(remote.name)) continue;
      paired.add(remote.name);
      parts.push({ kind: "remote", name: remote.name, text: fit(remote.name.slice(0, slash), 12) });
    }
    labels.push({ kind: "branch", head: ref.head, parts });
  }
  for (const remote of remotes) if (!paired.has(remote.name)) labels.push({ kind: "remote", parts: [{ kind: "remote", name: remote.name, text: fit(remote.name, LABEL.MAX), icon: true }] });
  for (const ref of commit.refs) if (ref.kind === "tag") labels.push({ kind: "tag", parts: [{ kind: "tag", name: ref.name, text: fit(ref.name, LABEL.MAX), icon: true }] });
  // What's checked out comes first.
  labels.sort((a, b) => Number(Boolean(b.head)) - Number(Boolean(a.head)));
  for (const label of labels) {
    for (const part of label.parts) part.width = partWidth(part);
    label.width = label.parts.reduce((n, p) => n + p.width, 2); // + a 1 px border each side
  }
  return labels;
}

// The label part at `x` in a row whose labels start after a `start`-wide graph and are cut off at
// `limit` (the description column's right edge).
export function hitLabel(labels, x, start, limit = Infinity) {
  if (x >= limit) return null;
  let left = start;
  for (const label of labels ?? []) {
    left += LABEL.GAP;
    if (x >= left && x < left + label.width) {
      let at = left + 1;
      for (const part of label.parts) {
        if (x < at + part.width) return { label, part };
        at += part.width;
      }
      return { label, part: label.parts[label.parts.length - 1] };
    }
    left += label.width;
  }
  return null;
}

const shortHash = (hash) => hash.slice(0, 8);
const currentName = (ctx) => ctx.current ?? "HEAD";
const section = (...items) => items.filter(Boolean);
const item = (label, icon, action) => ({ label, icon, action });
export const isDanger = (a) => a.type.startsWith("delete");

// The right-click menu for a commit, a label part or the uncommitted row: Git Graph's menus.
// Sections are separated.
export function menuFor(target, ctx) {
  if (target.kind === "repo") return repoMenu(target, ctx);
  const cur = currentName(ctx), c = target.commit;
  let sections;
  if (target.kind === "uncommitted") {
    sections = [
      section(item("Commit…", "git-commit", { type: "commit", staged: Boolean(target.staged) })),
      section(item("Stash uncommitted changes…", "stash", { type: "stash" })),
      section(item("Reset uncommitted changes…", "reset", { type: "resetUncommitted" })),
      section(item("Show in Changes", "changes", { type: "showChanges" })),
    ];
  } else if (target.kind === "branch") {
    const name = target.name, current = name === ctx.current;
    sections = [
      section(!current && item("Checkout branch", "git-branch", { type: "checkout", name }),
        item("Rename branch…", "rename", { type: "renameBranch", name }),
        !current && item("Delete branch…", "trash", { type: "deleteBranch", name })),
      section(!current && item(`Merge into ${cur}…`, "git-merge", { type: "merge", ref: name, what: `branch ${name}` }),
        !current && item(`Rebase ${cur} on this branch…`, "git-rebase", { type: "rebase", ref: name, what: `branch ${name}` })),
      section(ctx.remotes.length > 0 && item("Push branch…", "push", { type: "push", name })),
      section(item("Copy branch name", "copy", { type: "copy", text: name })),
    ];
  } else if (target.kind === "remote") {
    const name = target.name, slash = name.indexOf("/"), remote = name.slice(0, slash), branch = name.slice(slash + 1);
    const local = ctx.branches.includes(branch);
    sections = [
      section(branch !== ctx.current && (local
        ? item(`Checkout ${branch}`, "git-branch", { type: "checkout", name: branch })
        : item("Checkout branch…", "git-branch", { type: "checkoutRemote", name, remote, branch }))),
      section(item(`Merge into ${cur}…`, "git-merge", { type: "merge", ref: name, what: `remote branch ${name}` })),
      section(item("Delete remote branch…", "trash", { type: "deleteRemoteBranch", name, remote, branch })),
      section(item("Copy branch name", "copy", { type: "copy", text: name })),
    ];
  } else if (target.kind === "tag") {
    const name = target.name;
    sections = [
      section(item("Delete tag…", "trash", { type: "deleteTag", name })),
      section(ctx.remotes.length > 0 && item("Push tag…", "push", { type: "pushTag", name })),
      section(item("Copy tag name", "copy", { type: "copy", text: name })),
    ];
  } else {
    const hash = c.hash, short = shortHash(hash), here = hash === ctx.head, merge = c.parents.length > 1;
    sections = [
      section(item("Add tag…", "tag", { type: "addTag", hash, short }),
        item("Create branch…", "plus", { type: "createBranch", hash, short })),
      section(!here && item("Checkout…", "git-commit", { type: "checkoutCommit", hash, short }),
        !here && item("Cherry pick…", "cherry", { type: "cherryPick", hash, short, merge }),
        item("Revert…", "revert", { type: "revert", hash, short, merge })),
      section(!here && item(`Merge into ${cur}…`, "git-merge", { type: "merge", ref: hash, what: `commit ${short}` }),
        !here && item(`Rebase ${cur} on this commit…`, "git-rebase", { type: "rebase", ref: hash, what: `commit ${short}` }),
        item(`Reset ${cur} to this commit…`, "reset", { type: "reset", hash, short })),
      section(item("Copy commit hash", "copy", { type: "copy", text: hash }),
        item("Copy commit subject", "copy", { type: "copy", text: c.subject })),
    ];
  }
  const out = [];
  for (const s of sections.filter((s) => s.length)) { if (out.length) out.push({ separator: true }); out.push(...s); }
  return out;
}

// A Manygit row's menu: a terminal tab there, what the row's ↑/↓ asks for first, its uncommitted
// changes, and its links.
function repoMenu(r, ctx) {
  const st = r.status ?? {}, branch = st.branch, remote = ctx.remotes.length > 0;
  const pull = remote && st.upstream && !st.gone && item("Pull…", "fetch", { type: "pull", upstream: st.upstream });
  const push = remote && branch && item(st.upstream ? "Push…" : "Push and set upstream…", "push", { type: "push", name: branch });
  const fetch = remote && item("Fetch", "rotate-cw", { type: "fetch" });
  const sync = st.behind && !st.ahead ? [pull, fetch, push] : st.ahead && !st.behind ? [push, fetch, pull]
    : !st.upstream ? [push, fetch] : [fetch, pull, push];
  return [
    [item("New terminal tab", "plus", { type: "newTab", folder: r.path })],
    section(...sync),
    st.dirty > 0 ? section(item("Commit…", "git-commit", { type: "commit", staged: st.staged > 0 }),
      item("Stash uncommitted changes…", "stash", { type: "stash" }),
      item("Reset uncommitted changes…", "reset", { type: "resetUncommitted" })) : [],
    section(r.web && item(`Open on ${r.web.split("/")[2]}`, "cloud", { type: "openUrl", url: r.web }),
      item("Copy path", "copy", { type: "copy", text: r.path }),
      branch && item("Copy branch name", "copy", { type: "copy", text: branch })),
  ].filter((s) => s.length).flatMap((s, i) => (i ? [{ separator: true }, ...s] : s));
}

export const MENU = { ROW: 28, SEP: 9, PAD: 5, W: 260 };
export const menuHeight = (items) => MENU.PAD * 2 + items.reduce((n, i) => n + (i.separator ? MENU.SEP : MENU.ROW), 0);

const remoteChoice = (ctx) => ({ id: "remote", label: "Remote", value: ctx.remotes.includes("origin") ? "origin" : ctx.remotes[0],
  options: ctx.remotes.map((r) => ({ value: r, label: r })) });
const mergeNote = (a) => (a.merge ? " It's a merge commit: its changes against its first parent are used." : "");

// The dialog an action asks first, or null when it runs at once.
export function dialogFor(action, ctx) {
  const cur = currentName(ctx), a = action;
  switch (a.type) {
    case "checkoutRemote": return { title: "Checkout remote branch", detail: `Create a local branch that tracks ${a.name}, and check it out.`,
      inputs: [{ id: "name", label: "Local branch name", value: a.branch }], confirm: "Checkout" };
    case "checkoutCommit": return { title: "Checkout commit", detail: `Check out commit ${a.short}? You'll be on a detached HEAD: new commits belong to no branch until you create one.`, confirm: "Checkout" };
    case "createBranch": return { title: "Create branch", detail: `At commit ${a.short}.`,
      inputs: [{ id: "name", label: "Branch name", value: "" }], checks: [{ id: "checkout", label: "Check out the new branch", value: false }], confirm: "Create" };
    case "addTag": return { title: "Add tag", detail: `At commit ${a.short}.`,
      inputs: [{ id: "name", label: "Tag name", value: "" }, { id: "message", label: "Message (makes an annotated tag)", value: "", optional: true, text: true }], confirm: "Add tag" };
    case "renameBranch": return { title: "Rename branch", detail: `Rename ${a.name}.`, inputs: [{ id: "name", label: "New name", value: a.name }], confirm: "Rename" };
    case "deleteBranch": return { title: "Delete branch", detail: `Delete the local branch ${a.name}?`,
      checks: [{ id: "force", label: "Force delete, even if it isn't merged", value: false }], confirm: "Delete", danger: true };
    case "deleteRemoteBranch": return { title: "Delete remote branch", detail: `Delete ${a.branch} on ${a.remote}? This changes the remote for everyone who uses it.`, confirm: "Delete", danger: true };
    case "deleteTag": return { title: "Delete tag", detail: `Delete the local tag ${a.name}?`, confirm: "Delete", danger: true };
    case "merge": return { title: "Merge", detail: `Merge ${a.what} into ${cur}?`,
      checks: [{ id: "noff", label: "Create a merge commit even if it could fast-forward", value: false }], confirm: "Merge" };
    case "rebase": return { title: "Rebase", detail: `Rebase ${cur} on ${a.what}?`, confirm: "Rebase" };
    case "cherryPick": return { title: "Cherry pick", detail: `Apply commit ${a.short} on top of ${cur}?${mergeNote(a)}`, confirm: "Cherry pick" };
    case "revert": return { title: "Revert", detail: `Add a commit to ${cur} that undoes ${a.short}?${mergeNote(a)}`, confirm: "Revert" };
    case "reset": return { title: "Reset", detail: `Move ${cur} to commit ${a.short}.`, confirm: "Reset",
      choice: { id: "mode", label: "Mode", value: "mixed", options: [
        { value: "soft", label: "Soft", detail: "Keep every change, staged" },
        { value: "mixed", label: "Mixed", detail: "Keep every change, unstaged" },
        { value: "hard", label: "Hard", detail: "Discard every change", danger: true }] } };
    case "push": return { title: "Push branch", detail: `Push ${a.name}.`, choice: remoteChoice(ctx),
      checks: [{ id: "upstream", label: "Set as upstream", value: true }, { id: "force", label: "Force (with lease): overwrite what the remote has", value: false, danger: true }], confirm: "Push" };
    case "pushTag": return { title: "Push tag", detail: `Push the tag ${a.name}.`, choice: remoteChoice(ctx), confirm: "Push" };
    case "commit": return { title: "Commit", detail: ctx.current ? `Commit to ${ctx.current}.` : "You're on a detached HEAD: the commit belongs to no branch until you create one.",
      inputs: [{ id: "message", label: "Message", value: "", text: true }],
      // With changes already staged, commit just those unless the person ticks this.
      checks: [{ id: "all", label: "Stage every change first (untracked too)", value: !a.staged }], confirm: "Commit" };
    case "pull": return { title: "Pull", detail: `Fast-forward ${cur} to ${a.upstream}? A pull that can't fast-forward changes nothing.`, confirm: "Pull" };
    case "stash": return { title: "Stash uncommitted changes", inputs: [{ id: "message", label: "Message", value: "", optional: true, text: true }],
      checks: [{ id: "untracked", label: "Include untracked files", value: true }], confirm: "Stash" };
    case "resetUncommitted": return { title: "Reset uncommitted changes", detail: "Reset the working tree to HEAD.", confirm: "Reset",
      choice: { id: "mode", label: "Mode", value: "mixed", options: [
        { value: "mixed", label: "Mixed", detail: "Unstage everything, keep the changes" },
        { value: "hard", label: "Hard", detail: "Discard every change to tracked files", danger: true }] } };
    default: return null;
  }
}

// The dialog's height from what it holds (it doesn't size to its content).
export function dialogHeight(spec) {
  const detail = spec.detail ? Math.ceil(spec.detail.length / 56) * 18 + 8 : 0;
  return Math.ceil(18 * 2 + 24 + detail + (spec.inputs ?? []).length * 62 + (spec.checks ?? []).length * 30
    + (spec.choice ? 30 + spec.choice.options.length * 40 : 0) + 40 + 56);
}

const values = (spec) => {
  const v = {};
  for (const i of spec?.inputs ?? []) v[i.id] = i.value ?? "";
  for (const c of spec?.checks ?? []) v[c.id] = c.value;
  if (spec?.choice) v[spec.choice.id] = spec.choice.value;
  return v;
};
export const initialValues = (action, ctx) => values(dialogFor(action, ctx));

// What's wrong with the typed values, or null. A name never reaches git as an option.
export function validate(action, v, ctx) {
  const spec = dialogFor(action, ctx);
  for (const input of spec?.inputs ?? []) {
    const text = String(v[input.id] ?? "").trim();
    if (input.optional) continue;
    if (!text) return `${input.label} is empty.`;
    if (input.text) continue; // free text, passed as one argument after its option
    if (text.startsWith("-") || /\s/.test(text)) return `${input.label} can't start with "-" or contain spaces.`;
    if (!refName(text)) return `${input.label} isn't a valid git name.`;
  }
  if (spec?.choice && !spec.choice.options.some((o) => o.value === v[spec.choice.id])) return `Pick a ${spec.choice.label.toLowerCase()}.`;
  return null;
}

// Whether the chosen values destroy something (the confirm button turns red).
export function destroys(action, v, ctx) {
  const spec = dialogFor(action, ctx);
  if (!spec) return false;
  if (spec.danger) return true;
  if (spec.choice?.options.find((o) => o.value === v[spec.choice.id])?.danger) return true;
  return (spec.checks ?? []).some((c) => c.danger && v[c.id]);
}

// The git commands an action runs, in order.
export function commandsFor(a, v = {}, ctx = {}) {
  // Validate again at the execution boundary, including actions without dialogs.
  const hashes = ["checkoutCommit", "createBranch", "addTag", "cherryPick", "revert", "reset"];
  const names = ["checkout", "checkoutRemote", "renameBranch", "deleteBranch", "deleteRemoteBranch", "deleteTag", "push", "pushTag"];
  if (hashes.includes(a.type) && !objectId(a.hash)) throw new Error("Invalid commit identity");
  if (names.includes(a.type) && !refName(a.name)) throw new Error("Invalid ref name");
  if (["merge", "rebase"].includes(a.type) && !refName(a.ref)) throw new Error("Invalid ref name");
  if (a.type === "deleteRemoteBranch" && (!refName(a.remote) || !refName(a.branch))) throw new Error("Invalid remote branch");
  if (["checkoutRemote", "createBranch", "addTag", "renameBranch"].includes(a.type) && !refName(String(v.name ?? "").trim())) throw new Error("Invalid ref name");
  if (["push", "pushTag"].includes(a.type) && (!refName(v.remote) || !ctx.remotes?.includes(v.remote))) throw new Error("Invalid remote");
  if (a.type === "reset" && !["soft", "mixed", "hard"].includes(v.mode)) throw new Error("Invalid reset mode");
  if (a.type === "resetUncommitted" && !["mixed", "hard"].includes(v.mode)) throw new Error("Invalid reset mode");
  if (a.type === "commit" && !String(v.message ?? "").trim()) throw new Error("Empty commit message");
  const name = String(v.name ?? "").trim(), message = String(v.message ?? "").trim();
  switch (a.type) {
    case "checkout": return [["checkout", a.name]];
    case "checkoutRemote": return [["checkout", "-b", name, "--track", a.name]];
    case "checkoutCommit": return [["checkout", "--detach", a.hash]];
    case "createBranch": return [v.checkout ? ["checkout", "-b", name, a.hash] : ["branch", name, a.hash]];
    case "addTag": return [message ? ["tag", "-a", name, "-m", message, a.hash] : ["tag", name, a.hash]];
    case "renameBranch": return [["branch", "-m", a.name, name]];
    case "deleteBranch": return [["branch", v.force ? "-D" : "-d", a.name]];
    case "deleteRemoteBranch": return [["push", a.remote, "--delete", a.branch]];
    case "deleteTag": return [["tag", "-d", a.name]];
    case "merge": return [["merge", "--no-edit", ...(v.noff ? ["--no-ff"] : []), a.ref]];
    case "rebase": return [["rebase", a.ref]];
    case "cherryPick": return [["cherry-pick", ...(a.merge ? ["-m", "1"] : []), a.hash]];
    case "revert": return [["revert", "--no-edit", ...(a.merge ? ["-m", "1"] : []), a.hash]];
    case "reset": return [["reset", `--${v.mode}`, a.hash]];
    case "push": return [["push", ...(v.upstream ? ["--set-upstream"] : []), ...(v.force ? ["--force-with-lease"] : []), v.remote, a.name]];
    case "pushTag": return [["push", v.remote, `refs/tags/${a.name}`]];
    // The message is -m's own argument, so one starting with "-" stays a message.
    case "commit": return [...(v.all ? [["add", "--all"]] : []), ["commit", "-m", message]];
    // Fast-forward only: never a merge or a rebase.
    case "pull": return [["pull", "--ff-only", "--quiet"]];
    case "stash": return [["stash", "push", ...(v.untracked ? ["--include-untracked"] : []), ...(message ? ["-m", message] : [])]];
    case "resetUncommitted": return [["reset", `--${v.mode}`, "HEAD"]];
    case "fetch": return [["fetch", "--all", "--prune"]];
    default: throw new Error("Unknown Git action");
  }
}

// Actions that talk to a remote: a longer timeout, and no login prompt to wait on.
export const NETWORK = new Set(["fetch", "pull", "push", "pushTag", "deleteRemoteBranch"]);

export function doneText(a, v = {}) {
  const name = String(v.name ?? "").trim();
  switch (a.type) {
    case "checkout": return `Checked out ${a.name}`;
    case "checkoutRemote": return `Checked out ${name}, tracking ${a.name}`;
    case "checkoutCommit": return `Checked out ${a.short}`;
    case "createBranch": return `Created branch ${name}`;
    case "addTag": return `Tagged ${a.short} as ${name}`;
    case "renameBranch": return `Renamed ${a.name} to ${name}`;
    case "deleteBranch": return `Deleted branch ${a.name}`;
    case "deleteRemoteBranch": return `Deleted ${a.name}`;
    case "deleteTag": return `Deleted tag ${a.name}`;
    case "merge": return `Merged ${a.what}`;
    case "rebase": return `Rebased on ${a.what}`;
    case "cherryPick": return `Cherry-picked ${a.short}`;
    case "revert": return `Reverted ${a.short}`;
    case "reset": return `Reset to ${a.short} (${v.mode})`;
    case "push": return `Pushed ${a.name} to ${v.remote}`;
    case "pushTag": return `Pushed tag ${a.name} to ${v.remote}`;
    case "commit": return "Committed";
    case "pull": return `Pulled ${a.upstream}`;
    case "stash": return "Stashed uncommitted changes";
    case "resetUncommitted": return `Reset uncommitted changes (${v.mode})`;
    case "fetch": return "Fetched";
    default: return "Done";
  }
}

// Git's own words, without its hints.
export function gitError(result) {
  const lines = (result.stderr || result.stdout || "").split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l && !l.startsWith("hint:"));
  return lines.slice(-6).join("\n") || `git exited with ${result.code}`;
}

// ---- one commit's files (from file-preview `commits.js`, MIT) --------------------------------

/** `--name-status -z`: [{ status, path, from }]. */
export function nameStatus(s) {
  const f = s.split("\0"), out = [];
  for (let i = 0; i < f.length; i++) {
    const st = f[i].replace(/^\n+/, "");
    if (!st) continue;
    const k = st[0];
    if (k === "R" || k === "C") { out.push({ status: k, from: f[i + 1], path: f[i + 2] }); i += 2; }
    else { out.push({ status: k, path: f[i + 1], from: null }); i += 1; }
  }
  return out.filter((x) => x.path);
}

/** `--numstat -z`: [{ add, del, binary }] in the same order. */
export function numstat(s) {
  const f = s.split("\0"), out = [];
  for (let i = 0; i < f.length; i++) {
    const e = f[i].replace(/^\n+/, "");
    if (!e) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(e);
    if (!m) continue;
    out.push({ add: m[1] === "-" ? 0 : Number(m[1]), del: m[2] === "-" ? 0 : Number(m[2]), binary: m[1] === "-", path: m[3] || f[i + 2] });
    if (m[3] === "") i += 2;   // a rename: old and new path follow
  }
  return out;
}

// ---- dates -------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n) => String(n).padStart(2, "0");

/** The table's short date: now, 12m, 3h, 6d, Oct 3, Mar 2025. */
export function shortDate(seconds) {
  const s = Date.now() / 1000 - seconds;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  const d = new Date(seconds * 1000);
  return d.getFullYear() === new Date().getFullYear() ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "2026-11-03 14:05" in local time. */
export function stamp(seconds) {
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const UNITS = [[31536000, "year"], [2592000, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]];
/** "3 days ago". */
export function relative(seconds) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - seconds));
  for (const [n, w] of UNITS) if (s >= n) { const k = Math.floor(s / n); return `${k} ${w}${k === 1 ? "" : "s"} ago`; }
  return "just now";
}
