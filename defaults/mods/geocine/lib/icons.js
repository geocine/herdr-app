// File icons for every Geocine view: the Symbols set (MIT, icons/files/LICENSE), matched the
// way VS Code applies an icon theme. Adapted from carstenlucke/herdr-roundup `roundup-files/icon.js`
// (Apache-2.0), itself following cybertron288/herdr-mods `file-icons` (MIT). See NOTICE.md.
import ICONS from "./icon-table.js";

const path = (id) => `mods/geocine/icons/files/${id}.svg`;
const own = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);

// rel: "/"-separated path (only the last parts matter); dir: a folder; open: an open folder.
export function iconFor(rel, dir = false, open = false) {
  const parts = String(rel).toLowerCase().split(/[\\/]/).filter(Boolean), name = parts[parts.length - 1] ?? "";
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

export const rootIcon = (open = true) => path(open ? ICONS.rootFolderExpanded : ICONS.rootFolder);
