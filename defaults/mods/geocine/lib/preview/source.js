// Reads one file for the preview: from this computer's disk (Windows first: no shell, only
// readTextFile and, for what it can't read, a robocopy into the cache read back with
// fs/promises; PowerShell only as the last resort, it takes ~0.4 s to start), from another
// machine (a Unix shell there, as file-preview did), or as of a commit (git, through lib/git.js).
// Images are copied into the mod's hidden .cache/ folder, because image() only reads inside
// the app's folder.
// Adapted from bohumil/herdr-file-preview `source.js` and `commits.js` (MIT). See NOTICE.md.
import { exec, readTextFile, appHome, window } from "herdr";
import * as fs from "fs/promises";
import { gitRead } from "../git.js";
import { slash, dirName, baseName } from "../where.js";
import { isMarkdown, isImage, extension } from "./lang.js";

export const LIMIT = 1000000;                      // characters shown; more is cut off with a notice
export const CACHE = "mods/geocine/.cache/preview/"; // image() paths are relative to the app's folder
const IMAGE_MAX = 16 * 1024 * 1024;                 // image() refuses bigger assets
const REMOTE_IMAGE_MAX = 6 * 1024 * 1024;           // base64 through exec's 8 MiB output
const REV_MAX = 7 * 1024 * 1024;                    // a blob read through exec's 8 MiB output
const KEEP = 120;                                   // cached image copies kept
const PROBE_MAX = 16 * 1024 * 1024;                 // files read back from a cache copy; bigger ones ask PowerShell
// Never text: past PROBE_MAX these say "Binary" from their size alone.
const BINARY = new Set(["exe", "dll", "pdb", "lib", "obj", "o", "a", "so", "dylib", "rlib", "rmeta", "node", "wasm", "zip", "gz", "tgz", "xz", "bz2", "7z", "rar", "zst",
  "tar", "jar", "class", "pyc", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "woff", "woff2", "ttf", "otf", "ico", "mp3", "mp4", "wav", "ogg", "flac", "mov",
  "avi", "mkv", "webm", "psd", "db", "sqlite", "bin", "iso", "img", "msi", "cab", "dmg", "pack", "idx", "blend", "fbx", "glb", "exr", "hdr", "tif", "tiff", "dds"]);

export const isWindows = (on) => !on && window()?.platform === "windows";

// ---- small helpers ---------------------------------------------------------------------

/** A PowerShell single-quoted string (it also reads curly quotes as quotes, so those double too). */
export const psq = (s) => "'" + String(s).replace(/['‘’‚‛]/g, "$&$&") + "'";

/** Runs a PowerShell script here, UTF-8 out. No profile, no window, no execution policy. */
export function ps(script, timeout) {
  return exec("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " + script], { timeout });
}

const winPath = (p) => slash(p).replace(/\//g, "\\");

/** 32-bit FNV-1a as 8 hex digits. */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

const B64 = (() => { const t = new Int16Array(128).fill(-1); "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("").forEach((c, i) => { t[c.charCodeAt(0)] = i; }); return t; })();
/** Base64 (whitespace ignored) -> bytes. */
export function unbase64(s) {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4) + 3);
  let n = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i), v = c < 128 ? B64[c] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, n);
}

const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const le24 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Pixel size of an image from its first bytes: { w, h } or null. */
export function imageSize(b, ext) {
  if (!b || b.length < 10) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b.length >= 24) return { w: ((b[16] << 24) >>> 0) + (b[17] << 16) + (b[18] << 8) + b[19], h: ((b[20] << 24) >>> 0) + (b[21] << 16) + (b[22] << 8) + b[23] };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: le16(b, 6), h: le16(b, 8) };
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) return { w: le32(b, 18), h: Math.abs(le32(b, 22) | 0) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: be16(b, i + 5), w: be16(b, i + 7) };
      i += 2 + be16(b, i + 2);
    }
    return null;
  }
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 && b.length >= 30) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === "VP8 ") return { w: le16(b, 26) & 0x3fff, h: le16(b, 28) & 0x3fff };
    if (kind === "VP8L") return { w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    if (kind === "VP8X") return { w: 1 + le24(b, 24), h: 1 + le24(b, 27) };
    return null;
  }
  if (ext === "svg") {
    let text = "";
    for (let i = 0; i < Math.min(b.length, 8192); i++) text += String.fromCharCode(b[i]);
    const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? "";
    const num = (name) => { const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(tag); return m ? Number(m[1]) : null; };
    const box = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
    let w = num("width"), h = num("height");
    if (box && (!w || !h)) { const bw = Number(box[1]), bh = Number(box[2]); if (w && !h) h = (w * bh) / bw; else if (h && !w) w = (h * bw) / bh; else { w = bw; h = bh; } }
    return w && h ? { w: Math.round(w), h: Math.round(h) } : null;
  }
  return null;
}

// ---- documents ---------------------------------------------------------------------------

/** Text as a document: binary when it has a NUL, cut at LIMIT (at a line end when one is near). */
export function classify(path, text, cut, size) {
  if (text.includes("\0")) return { kind: "binary", message: "Binary file · no preview", size };
  // The text exactly as read: what a save must still find on disk; its line ends and BOM come back on save.
  const raw = text, crlf = text.includes("\r\n"), bom = text.charCodeAt(0) === 0xfeff;
  let truncated = cut;
  if (text.length > LIMIT) {
    const nl = text.lastIndexOf("\n", LIMIT);
    text = text.slice(0, nl > LIMIT / 2 ? nl : LIMIT);
    truncated = true;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes("\r")) text = text.replace(/\r\n?/g, "\n");   // Windows line ends: one row each
  return { kind: isMarkdown(path) ? "markdown" : "text", text, truncated, size, raw, crlf, bom };
}

/**
 * Reads a file.
 * -> { kind: "markdown" | "text", text, truncated, size?, note? }
 *  | { kind: "image", src, w, h, size }
 *  | { kind: "missing" | "binary" | "error", message }
 */
export async function readDoc({ on, abs, rev, repo }) {
  if (rev) return readAt({ on, abs, rev, repo });
  if (isImage(abs)) return on ? remoteImage(abs, on) : localImage(abs);
  let text;
  try { text = await readTextFile(abs, { on }); }
  catch {
    // Not UTF-8, or past readTextFile's 1 MiB: find out which (and read its head).
    return on ? probeRemote(abs, on) : probeLocal(abs);
  }
  if (text === null) return { kind: "missing", message: "This file no longer exists" };
  return classify(abs, text, false);
}

// One PowerShell run: "<size> <kind>\n<text>", kind utf8 | utf16le | utf16be | ansi | binary.
// The head is cut at a UTF-8 character boundary; a file that isn't valid UTF-8 is read in the
// system's ANSI code page instead.
const PROBE = (p) => `$p = ${psq(winPath(p))}; $L = ${LIMIT}
if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { [Console]::Out.Write('missing'); exit 0 }
$f = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite')
try { $n = $f.Length; $m = [int][Math]::Min($n, $L); $b = New-Object byte[] $m; $r = 0; while ($r -lt $m) { $k = $f.Read($b, $r, $m - $r); if ($k -le 0) { break }; $r += $k } } finally { $f.Close() }
$kind = 'utf8'; $o = 0
if ($r -ge 2 -and $b[0] -eq 0xFF -and $b[1] -eq 0xFE) { $kind = 'utf16le'; $o = 2 }
elseif ($r -ge 2 -and $b[0] -eq 0xFE -and $b[1] -eq 0xFF) { $kind = 'utf16be'; $o = 2 }
else { if ($r -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $o = 3 }; $z = [Math]::Min($r, 8192); for ($i = 0; $i -lt $z; $i++) { if ($b[$i] -eq 0) { $kind = 'binary'; break } } }
$t = ''
if ($kind -eq 'utf16le') { $t = [Text.Encoding]::Unicode.GetString($b, $o, ($r - $o) - (($r - $o) % 2)) }
elseif ($kind -eq 'utf16be') { $t = [Text.Encoding]::BigEndianUnicode.GetString($b, $o, ($r - $o) - (($r - $o) % 2)) }
elseif ($kind -eq 'utf8') {
  $e = $r; if ($r -lt $n) { while ($e -gt $o -and ($b[$e - 1] -band 0xC0) -eq 0x80) { $e-- }; if ($e -gt $o -and $b[$e - 1] -ge 0xC0) { $e-- } }
  try { $t = (New-Object Text.UTF8Encoding($false, $true)).GetString($b, $o, $e - $o) } catch { $kind = 'ansi'; $t = [Text.Encoding]::Default.GetString($b, $o, $r - $o) }
}
[Console]::Out.Write("$n $kind" + [char]10); [Console]::Out.Write($t)`;

async function probeLocal(abs) {
  if (!isWindows(null)) return probeRemote(abs, null);
  return (await probeCopy(abs).catch(() => null)) ?? probePs(abs);
}

/**
 * The fast probe (~30 ms): robocopy the file into the cache, read the copy's bytes back with
 * fs/promises and look at them here. null when it can't tell (the app's folder is outside the
 * home fs/promises reads, a big file that isn't known binary, a legacy code page): ask PowerShell.
 */
async function probeCopy(abs) {
  const dir = cacheDir() + cacheName(abs, "probe"), name = baseName(abs);
  const c = await robocopy(abs, dir, PROBE_MAX);
  if (!c) return null;
  if (c.missing) { removeTree(dir); return { kind: "missing", message: "This file no longer exists" }; }
  try {
    if (!c.copied) return BINARY.has(extension(abs)) ? { kind: "binary", message: "Binary file · no preview", size: c.size } : null;
    const bytes = await fs.readFile(dir + "/" + name).catch(() => null);
    if (!bytes) return null;
    const size = c.size ?? bytes.length;
    const le = bytes[0] === 0xff && bytes[1] === 0xfe, be = bytes[0] === 0xfe && bytes[1] === 0xff;
    if (le || be) {
      const doc = classify(abs, utf16(bytes, 2, le, LIMIT + 1), false, size);
      doc.note = "Read as UTF-16";
      return doc;
    }
    const head = Math.min(bytes.length, 8192);
    for (let i = 0; i < head; i++) if (bytes[i] === 0) return { kind: "binary", message: "Binary file · no preview", size };
    // UTF-8, decoded natively; a legacy code page fails here and goes to PowerShell.
    const text = await fs.readFile(dir + "/" + name, "utf8").catch(() => null);
    if (text === null) return null;
    // Past LIMIT bytes it can't be edited (writeTextFile stops at 1 MiB), as PowerShell's probe said.
    return classify(abs, text.length > LIMIT ? text.slice(0, LIMIT + 1) : text, size > LIMIT, size);
  } finally { removeTree(dir); }
}

/** UTF-16 bytes from `at` -> a string of at most `max` chars, in native chunks. */
function utf16(bytes, at, le, max) {
  const n = Math.min(max, Math.floor((bytes.length - at) / 2)), parts = [];
  if (le && (bytes.byteOffset + at) % 2 === 0) {
    const u = new Uint16Array(bytes.buffer, bytes.byteOffset + at, n);
    for (let i = 0; i < n; i += 8192) parts.push(String.fromCharCode.apply(null, u.subarray(i, i + 8192)));
  } else {
    const u = new Uint16Array(n);
    for (let i = 0, o = at; i < n; i++, o += 2) u[i] = le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1];
    for (let i = 0; i < n; i += 8192) parts.push(String.fromCharCode.apply(null, u.subarray(i, i + 8192)));
  }
  return parts.join("");
}

async function probePs(abs) {
  const r = await ps(PROBE(abs)).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
  if (r.code !== 0) return { kind: "error", message: firstLine(r.stderr) || "Cannot read this file" };
  if (r.stdout === "missing") return { kind: "missing", message: "This file no longer exists" };
  const nl = r.stdout.indexOf("\n"), [size, kind] = r.stdout.slice(0, nl).split(" ");
  if (kind === "binary") return { kind: "binary", message: "Binary file · no preview", size: Number(size) };
  const doc = classify(abs, r.stdout.slice(nl + 1), Number(size) > LIMIT, Number(size));
  if (kind === "utf16le" || kind === "utf16be") doc.note = "Read as UTF-16";
  else if (kind === "ansi") doc.note = "Not UTF-8: shown in the system code page";
  return doc;
}

const firstLine = (s) => String(s ?? "").trim().split(/\r?\n/)[0].replace(/^.*?:\s*(?=[A-Z])/, "").slice(0, 200);

// Another machine: a Unix shell there. "<size> <bytes in the first 8 KiB> <same without NULs>"; exit 3 when unreadable.
const SH_PROBE = 'test -r "$1" || exit 3; s=$(wc -c < "$1"); n=$(head -c 8192 "$1" | wc -c); m=$(head -c 8192 "$1" | tr -d "\\000" | wc -c); echo $s $n $m';
const SH_HEAD = 'head -c "$2" "$1"';
const SH_STAT = 'stat -c "%Y %s" "$1" 2>/dev/null || stat -f "%m %z" "$1"';

async function probeRemote(abs, on) {
  const r = await exec("sh", ["-c", SH_PROBE, "fp", abs], { on }).catch(() => null);
  if (!r) return { kind: "error", message: on ? `Cannot read this file (is ${on} reachable?)` : "Cannot read this file" };
  if (r.code === 3) return { kind: "error", message: "No permission to read this file" };
  const [size, n, m] = r.stdout.trim().split(/\s+/).map(Number);
  if (r.code !== 0 || !Number.isFinite(size)) return { kind: "error", message: firstLine(r.stderr) || "Cannot read this file" };
  if (n !== m) return { kind: "binary", message: "Binary file · no preview", size };
  if (size <= LIMIT) return { kind: "binary", message: "Not UTF-8 text · no preview", size };
  const h = await exec("sh", ["-c", SH_HEAD, "fp", abs, String(LIMIT)], { on }).catch(() => null);
  if (!h || h.code !== 0) return { kind: "error", message: "Cannot read this file" };
  return classify(abs, h.stdout, true, size);
}

/** A cheap change stamp of a file on another machine: "<mtime> <size>" or "missing"; rejects when unreachable. */
export async function stamp(abs, on) {
  const r = await exec("sh", ["-c", SH_STAT, "fp", abs], { on });
  return r.code === 0 ? r.stdout.trim() : "missing";
}

// ---- at a commit -----------------------------------------------------------------------

/** Where git reads `abs` at a revision: { cwd, spec, rel } (rel from the repo top when known). */
export function revSpec(abs, rev, repo) {
  const top = repo?.top ? slash(repo.top).replace(/\/+$/, "") : null;
  if (top && abs.toLowerCase().startsWith(top.toLowerCase() + "/")) {
    const rel = abs.slice(top.length + 1);
    return { cwd: top, spec: `${rev}:${rel}`, rel };
  }
  return { cwd: dirName(abs), spec: `${rev}:./${abs.split("/").pop()}`, rel: null };
}

async function readAt({ on, abs, rev, repo }) {
  const { cwd, spec } = revSpec(abs, rev, repo);
  const s = await gitRead(["cat-file", "-s", spec], cwd, { on }).catch(() => null);
  if (!s) return { kind: "error", message: on ? `Cannot run git on ${on}` : "Cannot run git" };
  if (s.code !== 0) return { kind: "missing", message: "This file is not in that commit" };
  const size = Number(s.stdout.trim());
  if (isImage(abs)) return revImage({ on, abs, rev, repo, size });
  if (size > REV_MAX) return { kind: "error", message: `Too large to show at a commit (${mb(size)})` };
  const r = await gitRead(["cat-file", "blob", spec], cwd, { on, timeout: 30000 }).catch(() => null);
  if (!r || r.code !== 0) return { kind: "error", message: firstLine(r?.stderr) || "Cannot read this file at that commit" };
  const doc = classify(abs, r.stdout, size > LIMIT, size);
  if (doc.kind !== "binary" && bad(doc.text)) return { kind: "binary", message: "Not UTF-8 text · no preview", size };
  return doc;
}

/** Text that came through a UTF-8 decode with many replacement characters. */
function bad(text) {
  let n = 0;
  for (let i = text.indexOf("\ufffd"); i >= 0 && n < 9; i = text.indexOf("\ufffd", i + 1)) n++;
  return n > 8;
}

export const mb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

// ---- images ------------------------------------------------------------------------------

const cacheDir = () => slash(appHome()).replace(/\/+$/, "") + "/" + CACHE;
let pruned = false;

/** A new name in the cache for a copy of `abs` (new each time, so a changed image shows changed): "<hash>-<time>-<rand>[.ext]". */
function cacheName(abs, ext) {
  return `${fnv1a(abs)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}${ext ? "." + ext : ""}`;
}

/**
 * Copies one local file into `dir` (keeping its name) with robocopy: a real program, so no
 * shell parses the path (spaces, &, ^, %, parentheses, Unicode are safe), ~25 ms against
 * PowerShell's ~400. Files over `max` bytes are listed, not copied.
 * -> { copied, size, missing } | null when robocopy can't run or fails.
 */
async function robocopy(abs, dir, max) {
  let src = winPath(dirName(abs));
  const name = baseName(abs);
  if (!name) return null;
  if (/^[a-z]:$/i.test(src)) src += "\\";   // "C:" alone is the current folder on C:
  // /V lists a file skipped for its size; /BYTES /NC: "<size>\t<path>" per file, no localized words.
  const r = await exec("robocopy", [src, winPath(dir), name, "/COPY:D", "/R:0", "/W:0", "/NJH", "/NJS", "/NDL", "/NC", "/NP", "/BYTES", "/V", `/MAX:${max}`])
    .catch(() => null);
  if (!r) return null;
  if (r.code === 16) return { copied: false, size: null, missing: true };   // no such folder
  if (r.code >= 8) return null;
  const m = /^\s*(\d+)\t/m.exec(r.stdout);
  if (!m) return { copied: false, size: null, missing: true };
  return { copied: (r.code & 1) === 1, size: Number(m[1]), missing: false };
}

/** Deletes a cache entry (a file, or a folder and what's in it). Never throws. */
async function removeTree(path, depth = 0) {
  try { await fs.unlink(path); return; } catch {}
  if (depth > 16) return;
  try {
    for (const e of await fs.readdir(path, { withFileTypes: true })) await removeTree(path + "/" + e.name, depth + 1);
    await fs.rmdir(path);
  } catch {}
}

/** Keeps the newest KEEP cache entries (once per load of this module), in the background. */
function prune() {
  if (pruned) return;
  pruned = true;
  (async () => {
    const dir = cacheDir();
    const names = await fs.readdir(dir).catch(() => []);
    if (names.length <= KEEP) return;
    // Entries an older version made have no "-<time>-" part: oldest.
    const at = (n) => { const m = /^[0-9a-f]{8}-([0-9a-z]+)-/.exec(n); return m ? parseInt(m[1], 36) : 0; };
    const old = names.map((n) => [at(n), n]).sort((a, b) => b[0] - a[0]).slice(KEEP);
    for (const [, n] of old) await removeTree(dir + n);
  })().catch(() => {});
}

/**
 * The first bytes of a cached copy (for its pixel size); null when the app's folder can't be read.
 * fs/promises throws at once (not a rejection) for a path outside its read roots, so: try.
 */
async function headOf(path) {
  try { return (await fs.readFile(path)).subarray(0, 65536); } catch { return null; }
}

async function localImage(abs) {
  const ext = extension(abs);
  if (!isWindows(null)) return remoteImage(abs, null);
  const key = cacheName(abs, ""), c = await robocopy(abs, cacheDir() + key, IMAGE_MAX);
  if (!c) return { kind: "error", message: "Cannot read this image" };
  if (c.missing) { removeTree(cacheDir() + key); return { kind: "missing", message: "This file no longer exists" }; }
  if (!c.copied) { removeTree(cacheDir() + key); return { kind: "error", message: `Image too large to preview (${mb(c.size)})` }; }
  prune();
  const rel = key + "/" + baseName(abs);
  return { kind: "image", src: CACHE + rel, size: c.size, ...(imageSize(await headOf(cacheDir() + rel), ext) ?? {}) };
}

/** The bytes of a file on another machine (or here, off Windows), through base64. */
async function remoteImage(abs, on, read = null) {
  const ext = extension(abs);
  let r;
  if (read) r = await read();
  else {
    const s = await exec("sh", ["-c", 'test -r "$1" || exit 3; wc -c < "$1"', "fp", abs], { on }).catch(() => null);
    if (!s) return { kind: "error", message: on ? `Cannot reach ${on}` : "Cannot read this image" };
    if (s.code !== 0) return { kind: "missing", message: "This file no longer exists" };
    const size = Number(s.stdout.trim());
    if (size > REMOTE_IMAGE_MAX) return { kind: "error", message: `Image too large to preview from ${on ?? "here"} (${mb(size)})` };
    r = await exec("base64", [abs], { on }).catch(() => null);
  }
  if (!r || r.code !== 0) return { kind: "error", message: firstLine(r?.stderr) || "Cannot read this image" };
  const bytes = unbase64(r.stdout), name = cacheName((on ?? "") + ":" + abs, ext);
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(cacheDir() + name, bytes);
  } catch (e) { return { kind: "error", message: `Cannot cache this image: ${String(e?.message ?? e)}` }; }
  prune();
  return { kind: "image", src: CACHE + name, size: bytes.length, ...(imageSize(bytes.subarray(0, 65536), ext) ?? {}) };
}

/** An image as of a commit: git archive into the cache, then tar out (Windows ships bsdtar), drawn where tar put it. */
async function revImage({ on, abs, rev, repo, size }) {
  if (size > (on ? REMOTE_IMAGE_MAX : IMAGE_MAX)) return { kind: "error", message: `Image too large to preview (${mb(size)})` };
  const { cwd, spec } = revSpec(abs, rev, repo);
  if (on || !isWindows(null)) {
    const sh = 'cd "$1" && git --no-optional-locks cat-file blob "$2" | base64';
    return remoteImage(abs, on, () => exec("sh", ["-c", sh, "fp", cwd, spec], { on }).catch(() => null));
  }
  // `git archive` takes a tree path, so the path from the repo top.
  let top = repo?.top ?? null, rel = null;
  if (!top) {
    const t = await gitRead(["rev-parse", "--show-toplevel"], cwd).catch(() => null);
    top = t?.code === 0 ? slash(t.stdout.trim()) : null;
  }
  if (top && abs.toLowerCase().startsWith(top.toLowerCase() + "/")) rel = abs.slice(top.length + 1);
  if (!rel) return { kind: "error", message: "Cannot find this image in its repository" };
  const key = cacheName(abs + "@" + rev, ""), dir = cacheDir() + key, tar = dir + ".tar";
  try { await fs.mkdir(dir, { recursive: true }); } catch (e) { return { kind: "error", message: `Cannot cache this image: ${String(e?.message ?? e)}` }; }
  const a = await gitRead(["archive", "--format=tar", "-o", tar, rev, "--", rel], top).catch(() => null);
  if (!a || a.code !== 0) { removeTree(dir); return { kind: "error", message: firstLine(a?.stderr) || "Cannot read this image at that commit" }; }
  let x = null;
  for (const t of ["C:\\Windows\\System32\\tar.exe", "tar"]) {
    x = await exec(t, ["-xf", winPath(tar), "-C", winPath(dir)]).catch(() => null);
    if (x?.code === 0) break;
  }
  removeTree(tar);
  if (!x || x.code !== 0) { removeTree(dir); return { kind: "error", message: firstLine(x?.stderr) || "Cannot unpack this image (tar)" }; }
  // The folder is one cache entry, pruned as one.
  prune();
  return { kind: "image", src: CACHE + key + "/" + rel, size, ...(imageSize(await headOf(dir + "/" + rel), extension(abs)) ?? {}) };
}
