// File icons for every Geocine view: the Symbols set (MIT, icons/files/LICENSE), matched the
// way VS Code applies an icon theme. Adapted from carstenlucke/herdr-roundup `roundup-files/icon.js`
// (Apache-2.0), itself following cybertron288/herdr-mods `file-icons` (MIT). See NOTICE.md.
import ICONS from "./icon-table.js";

const path = (id) => `mods/geocine/icons/files/${id}.svg`;
const own = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);

// Every row of every list asks for its icon on every render, so answers are remembered (shared by
// all copies; the table never changes while the module lives). When no name or folder key has a
// "/" (true of the shipped table), only the last part decides, so the cache is keyed by it.
const nested = [ICONS.fileNames, ICONS.folderNames, ICONS.folderNamesExpanded].some((t) => Object.keys(t ?? {}).some((k) => k.includes("/")));
const memo = new Map();
const MEMO_MAX = 4000;

function lookup(parts, dir, open) {
  const name = parts[parts.length - 1] ?? "";
  const find = (table) => {
    let id;
    for (let i = 0; !id && i < parts.length - 1; i++) id = own(table, parts.slice(i).join("/"));
    return id ?? own(table, name);
  };
  if (dir) return path((open ? find(ICONS.folderNamesExpanded) : undefined) ?? find(ICONS.folderNames) ?? (open ? ICONS.folderExpanded : ICONS.folder));
  const extensions = [name];
  for (let dot = name.indexOf("."); dot !== -1; dot = name.indexOf(".", dot + 1)) extensions.push(name.slice(dot + 1));
  let id = find(ICONS.fileNames);
  for (const e of extensions) id ??= own(ICONS.fileExtensions, e);
  return path(id ?? ICONS.file);
}

// rel: "/"-separated path (only the last parts matter); dir: a folder; open: an open folder.
export function iconFor(rel, dir = false, open = false) {
  const s = String(rel).toLowerCase();
  let key;
  if (nested) key = s;
  else {
    let end = s.length;
    while (end > 0 && (s[end - 1] === "/" || s[end - 1] === "\\")) end--;
    const cut = Math.max(s.lastIndexOf("/", end - 1), s.lastIndexOf("\\", end - 1));
    key = s.slice(cut + 1, end);
  }
  key = (dir ? (open ? "o" : "d") : "f") + key;
  let hit = memo.get(key);
  if (hit === undefined) {
    if (memo.size >= MEMO_MAX) memo.clear();
    hit = lookup((nested ? s : key.slice(1)).split(/[\\/]/).filter(Boolean), dir, open);
    memo.set(key, hit);
  }
  return hit;
}

export const rootIcon = (open = true) => path(open ? ICONS.rootFolderExpanded : ICONS.rootFolder);
