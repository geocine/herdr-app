// What the explorer had open per folder: the expanded folders, the selected row and the open
// file, kept in localStorage (files.memory) for the last MAX_ROOTS folders. Follows
// herdr-file-preview's memory.js (MIT). See NOTICE.md.
const KEY = "files.memory", MAX_ROOTS = 50, MAX_FOLDERS = 300;

const safe = (p) => typeof p === "string" && p && !p.split("/").some((x) => !x || x === "." || x === "..");

function all() {
  try { const m = JSON.parse(localStorage.getItem(KEY) ?? "{}"); return m && typeof m === "object" ? m : {}; } catch { return {}; }
}

// Windows paths ("C:/...") are the same folder in any case.
export const rootKey = (root, on) => (on ? `${on}:${root}` : /^[A-Za-z]:/.test(root) ? String(root).toLowerCase() : String(root));

// { folders: [], cursor, file } for a folder, or null.
export function recall(key) {
  const e = all()[key];
  if (!e || typeof e !== "object") return null;
  return {
    folders: Array.isArray(e.folders) ? e.folders.filter(safe) : [],
    cursor: safe(e.cursor) ? e.cursor : "",
    file: safe(e.file) ? e.file : null,
  };
}

export function remember(key, { folders, cursor, file }) {
  const m = all();
  const depth = (p) => p.split("/").length;
  const list = [...folders].sort((a, b) => depth(a) - depth(b)).slice(0, MAX_FOLDERS);
  if (!list.length && !file && !cursor) delete m[key];
  else m[key] = { folders: list, cursor: cursor || "", file: file || null, at: Date.now() };
  const keys = Object.keys(m).sort((a, b) => (m[b].at ?? 0) - (m[a].at ?? 0));
  for (const k of keys.slice(MAX_ROOTS)) delete m[k];
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch {}
}

export function pref(name, fallback) {
  try { const v = localStorage.getItem(`files.${name}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function setPref(name, value) {
  try { localStorage.setItem(`files.${name}`, JSON.stringify(value)); } catch {}
}
