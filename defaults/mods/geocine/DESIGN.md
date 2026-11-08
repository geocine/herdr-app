# Geocine mod

The geocine fork's default layout draws its tab bar and side panel with this mod: **Files**,
**Changes** and **Graph**, each with a **full mode** (an overlay almost as big as the window,
list and detail side by side). It is one mod so the views share their git, icon, diff and
preview code and look like one tool. Credits for the parts ported from other projects are in
`NOTICE.md`.

Shipped mods are replaced on every start: to change this one, `mod.clone` it first.

## Layout of the folder

```
main.js            router: props.view picks the view
lib/ui.js          sizes and shared components (header, rows, buttons, empty states)
lib/git.js         gitRead / gitWrite / git / repoOf, STATUS colors (finds Git for Windows)
lib/where.js       location() of the focused terminal, path helpers
lib/icons.js       iconFor(rel, dir, open): Symbols file icons (icons/files/)
lib/nav.js         openFull(tab, start), closeFull()
lib/inline.js      runs a view inside another's render (live updates reach it)
lib/preview/       the Preview component (read and edit a file)
lib/diff/          parseDiff / loadDiff and the Diff component
views/tabs.js      the tab bar with the panel buttons
views/full.js      full mode
views/files/       the explorer
views/changes/     uncommitted changes
views/graph/       the commit graph, commit details and git actions
icons/ui/          Lucide UI icons
```

## Views, props and modes

Each view is a `View` class (`export default class ... extends View`) in
`views/<name>/index.js`. It is mounted with `cx.new(Class, props)`. Props are plain
objects and may hold functions (closures work).

Every view gets:

- `wide`: `false` in the side panel (one page at a time). `true` in full mode (master and
  detail side by side, with a draggable split).
- `full`: `true` in full mode.

Side panel (narrow, about 300–600 px):

- The view shows its list (the master).
- Opening an item shows the detail page with a header back button (`← Files`, `← Changes`,
  `← Graph`).
- `Esc` or `Backspace` goes back.

Full mode (wide):

- The list is on the left: resizable, default 320 px, kept in localStorage.
- The detail is on the right.

The header's expand button (icon `expand`) calls `openFull("<view>")` from `lib/nav.js`.
In full mode the same spot shows a collapse button that calls `closeFull()`. Read
`props().full` from the herdr import (router props) or your own `full` prop.

The view follows the focused terminal: use `location()` and `locationKey()` from
`lib/where.js`, and `repoOf(cwd)`. When the focus moves to another folder or repo, reload.
Keep the last place while focus is inside our own panel (`focused()` may point at nothing
useful then).

## Shared components (contracts)

### Preview — `lib/preview/index.js`

`export default class Preview extends View`. Mount it with `cx.new(Preview, props)` and
update it with `entity.set_props(props)`.

Props:

```
{ on: string|null,        // machine (null = this computer)
  root: string,           // folder paths are relative to ("/"-separated, absolute)
  path: string,           // the file, relative to root
  rev: string|null,       // show the file as of this commit (git show rev:path), else the disk
  repoTop: string|null,   // the repo top, when known (for gutters and rev reads)
  wide: boolean,
  onOpen?(rel, rev)       // a relative link was clicked (markdown link to another file)
}
```

It draws a thin bar with: the file icon and name, find, zoom −/%/+, and wrap for code.
The content is one of:

- Markdown: GFM, highlighted code fences, tables, task lists, links. Mermaid only if
  `mmdc` is found; otherwise show the source with a notice.
- Code: syntax highlighting. Use gpui-base `Editor`/`EditorState`, read-only, as
  `defaults/mods/files` does, or file-preview's approach.
- Images (png, jpg, gif, svg, webp): drawn with `image()`.
- Binary: "Binary file · no preview".
- Files over 1 MB: cut off, with a notice.

It reloads live: `watchFolder` locally, polling for remote machines.

For code files when `rev` is null: show git change marks against HEAD (a gutter and/or an
overview ruler), as file-preview does.

Find in document: `Ctrl+F` / `/`, a match count, next and previous. In a code file it runs in
the Editor (`EditorState.search`): matches highlighted in the text, the current one scrolled to.
Zoom: 70–200%, per view in localStorage.

Blame (`lib/preview/blame.js`): `git blame --porcelain` in the background once the file shows,
again only when its text or git status changes; never before the text is on screen. The cursor
line gets a GitLens-like note (`EditorState.set_line_hints`); full mode adds a blame column (the
history button hides or shows both), for files up to 1000 lines. Over 20000 lines: no blame. In
full mode a short file fills the view: the gutters run to the bottom.

### Diff — `lib/diff/index.js`

`export default class Diff extends View`. Props:

```
{ on, top,                       // repo top ("/"-separated)
  source: { kind: "unstaged" | "staged" | "untracked" | "head" | "commit", rev?: string },
  //  unstaged: worktree vs index · staged: index vs HEAD · untracked: whole file as added
  //  head: everything uncommitted vs HEAD (incl. untracked) · commit: rev vs its first parent
  paths?: string[],              // only these files (repo-relative); all when absent
  split?: boolean,               // side by side (default: unified; full mode may offer split)
  onOpenFile?(path, rev)         // "open file" on a file header (rev null = working tree)
}
```

It draws the files stacked. Each file has a header: icon, path (dir dimmed), status
letter, +/− counts, fold chevron, open-file button, and a "viewed" check as in t3. Viewed
state lives in localStorage, keyed by repo + path + blob hash. A viewed file folds.

The fold menu offers: expand all, collapse all, collapse viewed. Hunks show old and new
line numbers, tinted added and removed lines, a hunk header row, syntax colors if cheap,
and word-level changes if cheap. Large diffs use a virtual list. Text uses the person's
mono font (`settings().font`).

Also export from `lib/diff/parse.js`:

- `parseDiff(text) → [{ path, oldPath, status, binary, adds, dels, hunks:[{ header,
  oldStart, newStart, lines:[{ kind:"add"|"del"|"ctx"|"meta", text, old, new }] }] }]`
- `loadDiff({ on, top, source, paths }) → Promise<files>` (uses lib/git.js gitRead)

The Graph view uses both for commit details.

## The look (all views)

- Use `lib/ui.js` for everything that has a component there: `frame`, `header`, `subbar`,
  `row`, `section`, `iconButton`, `textButton`, `segmented`, `badge`, `counts`, `empty`,
  and `SIZE`. Don't invent other bar heights, radii or text sizes.
- Colors come only from `theme()` tokens: background, foreground, muted, dim, accent,
  selected, hover, border, surface, raised, popover, chrome, input, ansi1–ansi15. No hex.
  The theme is geocine green (`#89f50b` accent) on near-black; light mode exists too.
- Git status colors come from `STATUS` / `statusColor()` in lib/git.js, everywhere.
- File icons come from `iconFor()` in lib/icons.js, everywhere: tree, change lists,
  commit file lists, diff headers, the preview bar.
- Every view's header: `[back] icon Title · subtitle ........ actions [expand]`.
- Empty and error states use `empty()`. Say what is wrong in one line and offer one action.
- Right-click menus and confirms: look at how the references do them (roundup's menu,
  git-graph's dialog.js) and make them look the same in every view. Use
  `openOverlay({ kind: "popup" ... })` or in-view popovers. Destructive git actions
  (discard, reset --hard, delete branch, force push) always confirm first.
- Keyboard: arrows move the selection, Enter opens, Esc/Backspace goes back, `/` or
  Ctrl+F searches. The view must take focus when clicked.
- localStorage keys are prefixed with your view's name (`files.`, `changes.`, `graph.`,
  `preview.`, `diff.`), since all views share one mod copy's storage. Shared state keys
  are prefixed `geocine.`.

## Checking a change

`herdr-app check <this folder>` after every edit (it renders the first frame only), then try
it in the app. A render has about 50 ms: draw long lists through a virtual list (rows there
can't take their own mouse handlers; use `on_item_click`) or cap them.
