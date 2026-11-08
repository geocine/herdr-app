# Geocine mod: credits

The Geocine panels port and adapt other people's open-source work. Their licences apply to
those parts, and their copyright notices are kept here as the licences require. Each adapted
file names its origin in a comment at its top.

| Part | Based on | Licence | Copyright |
|---|---|---|---|
| `icons/files/`, `lib/icon-table.js` | [Symbols](https://github.com/miguelsolorio/vscode-symbols) 0.0.26, as packed by herdr-roundup | MIT (`icons/files/LICENSE`) | (c) 2020-22 Miguel Solorio |
| `lib/icons.js` (icon matching), `lib/git.js` (finding git on Windows) | [carstenlucke/herdr-roundup](https://github.com/carstenlucke/herdr-roundup) `roundup-files` | Apache-2.0 | (c) carstenlucke |
| the same, through roundup | `filetree` and `file-icons` from [cybertron288/herdr-mods](https://github.com/cybertron288/herdr-mods) | MIT | (c) 2026 cybertron288 |
| `icons/ui/` (most) | [Lucide](https://lucide.dev) | ISC (`icons/ui/LICENSE-lucide.txt`) | (c) Lucide Contributors 2022, portions (c) Cole Bemis 2013-2022 (Feather, MIT) |
| `views/tabs.js` | Herdr App's shipped `tabs` mod | Apache-2.0 | Herdr |
| `views/files/` (tree, git state, Changed, search, keys, context menu, actions) | [carstenlucke/herdr-roundup](https://github.com/carstenlucke/herdr-roundup) `roundup-files`, itself modified from Herdr's `files` mod 0.1.13 | Apache-2.0 | (c) 2026 Carsten Lucke |
| the same parts (git status parsing, folder index, actions, keys, menu), through roundup | `filetree` from [cybertron288/herdr-mods](https://github.com/cybertron288/herdr-mods), a port of claude-code-filetree | MIT | (c) 2026 cybertron288; (c) 2026 Kurt Buhler |
| `views/files/memory.js` (per-folder memory) | [bborrero14/herdr-file-preview](https://github.com/bborrero14/herdr-file-preview) `memory.js` | MIT | (c) 2026 Bohumil Borrero |
| `views/graph/` (lanes, ref labels, repository list, right-click menus, action dialogs, git actions) | [rabeeh-ta/herdr-git-graph](https://github.com/rabeeh-ta/herdr-git-graph) `git-graph`; the repository list after [rabeeh-ta/manygit](https://github.com/rabeeh-ta/manygit) | MIT | (c) 2026 Rabeeh T A |
| `views/graph/ops.js`, `load.js` (All/Current switch, Remotes, paging, refs checksum, name-status/numstat parsing) | [bborrero14/herdr-file-preview](https://github.com/bborrero14/herdr-file-preview) `commits.js`, `graph.js` | MIT | (c) 2026 Bohumil Borrero |
| `icons/ui/` cherry, cloud, fetch, push, plus, git-merge, git-rebase, rename, reset, revert, stash, tag, trash, collapse | herdr-git-graph's icons, drawn after Lucide; `collapse` is Lucide `minimize-2` | MIT / ISC | (c) 2026 Rabeeh T A; Lucide Contributors |
| `lib/diff/index.js`, `lib/diff/rows.js` (stacked file sections, sticky header, viewed marks, fold menu, split pairs, virtual list runs, ligature-safe spans) | [JinJieBeWater/herdr-t3](https://github.com/JinJieBeWater/herdr-t3) `extras/mods/review`, fed from plain git instead of its daemon | Apache-2.0 | (c) 2026 JinJieBeWater |
| `lib/diff/parse.js` (hunk line numbers, per-section uncommitted diffs) | [bborrero14/herdr-file-preview](https://github.com/bborrero14/herdr-file-preview) `commits.js` | MIT | (c) 2026 Bohumil Borrero |
| `views/changes/` | Herdr App's shipped `changes` mod | Apache-2.0 | Herdr |
| `lib/preview/` (markdown.js, find.js, lang.js, zoom.js, mermaid.js, marks.js, parts of source.js and index.js) | [bborrero14/herdr-file-preview](https://github.com/bborrero14/herdr-file-preview) `file-preview` | MIT | (c) 2026 Bohumil Borrero |

## MIT licence text

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## ISC licence text (Lucide)

Permission to use, copy, modify, and/or distribute this software for any purpose with or
without fee is hereby granted, provided that the above copyright notice and this permission
notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
