// Reads one file for the preview: from this computer's disk (Windows first: no shell, only
// readTextFile and, for what it can't read, one PowerShell call), from another machine (a Unix
// shell there, as file-preview did), or as of a commit (git, through lib/git.js).
// Images are copied into the mod's hidden .cache/ folder, because image() only reads inside
// the app's folder.
// Adapted from bohumil/herdr-file-preview `source.js` and `commits.js` (MIT). See NOTICE.md.
import { exec, readTextFile, appHome, window } from "herdr";
import * as fs from "fs/promises";
import { gitRead } from "../git.js";
import { slash, dirName } from "../where.js";
import { isMarkdown, isImage, extension } from "./lang.js";

export const LIMIT = 1000000;                      // characters shown; more is cut off with a notice
export const CACHE = "mods/geocine/.cache/preview/"; // image() paths are relative to the app's folder
const IMAGE_MAX = 16 * 1024 * 1024;                 // image() refuses bigger assets
const REMOTE_IMAGE_MAX = 6 * 1024 * 1024;           // base64 through exec's 8 MiB output
const REV_MAX = 7 * 1024 * 1024;                    // a blob read through exec's 8 MiB output
const KEEP = 120;                                   // cached image copies kept

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

/** A new name in the cache for a copy of `abs` (new each time, so a changed image shows changed). */
function cacheName(abs, ext) {
  return `${fnv1a(abs)}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}.${ext}`;
}

// Copies a file into the cache; prints "<size>\n<base64 of its first 64 KiB>". "big <size>" when over the limit.
const COPY = (src, dst, prune) => `$s = ${psq(winPath(src))}; $d = ${psq(winPath(dst))}
if (-not (Test-Path -LiteralPath $s -PathType Leaf)) { [Console]::Out.Write('missing'); exit 0 }
$i = Get-Item -LiteralPath $s; if ($i.Length -gt ${IMAGE_MAX}) { [Console]::Out.Write("big $($i.Length)"); exit 0 }
$dir = Split-Path -Parent $d; New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item -LiteralPath $s -Destination $d -Force; (Get-Item -LiteralPath $d).CreationTime = Get-Date
$f = [IO.File]::OpenRead($d); try { $b = New-Object byte[] 65536; $r = $f.Read($b, 0, 65536) } finally { $f.Close() }
${prune ? `Get-ChildItem -LiteralPath $dir -File | Sort-Object CreationTime -Descending | Select-Object -Skip ${KEEP} | Remove-Item -Force -ErrorAction SilentlyContinue` : ""}
[Console]::Out.Write("$($i.Length)" + [char]10 + [Convert]::ToBase64String($b, 0, $r))`;

async function localImage(abs) {
  const ext = extension(abs), name = cacheName(abs, ext);
  if (!isWindows(null)) return remoteImage(abs, null);
  const r = await ps(COPY(abs, cacheDir() + name, !pruned)).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
  if (r.code !== 0) return { kind: "error", message: firstLine(r.stderr) || "Cannot read this image" };
  pruned = true;
  if (r.stdout === "missing") return { kind: "missing", message: "This file no longer exists" };
  if (r.stdout.startsWith("big ")) return { kind: "error", message: `Image too large to preview (${mb(Number(r.stdout.slice(4)))})` };
  const nl = r.stdout.indexOf("\n"), size = Number(r.stdout.slice(0, nl));
  return { kind: "image", src: CACHE + name, size, ...(imageSize(unbase64(r.stdout.slice(nl + 1)), ext) ?? {}) };
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
  return { kind: "image", src: CACHE + name, size: bytes.length, ...(imageSize(bytes.subarray(0, 65536), ext) ?? {}) };
}

/** An image as of a commit: git archive into the cache, then tar out (Windows ships bsdtar). */
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
  const key = `${fnv1a(abs + "@" + rev)}-${Date.now().toString(36)}`, dir = cacheDir() + key, tar = dir + ".tar";
  try { await fs.mkdir(dir, { recursive: true }); } catch (e) { return { kind: "error", message: `Cannot cache this image: ${String(e?.message ?? e)}` }; }
  const a = await gitRead(["archive", "--format=tar", "-o", tar, rev, "--", rel], top).catch(() => null);
  if (!a || a.code !== 0) return { kind: "error", message: firstLine(a?.stderr) || "Cannot read this image at that commit" };
  let x = null;
  for (const t of ["C:\\Windows\\System32\\tar.exe", "tar"]) {
    x = await exec(t, ["-xf", winPath(tar), "-C", winPath(dir)]).catch(() => null);
    if (x?.code === 0) break;
  }
  fs.unlink(tar).catch(() => {});
  if (!x || x.code !== 0) return { kind: "error", message: firstLine(x?.stderr) || "Cannot unpack this image (tar)" };
  // Moved next to the other copies, so the cache prune sees it.
  const ext = extension(abs), name = cacheName(abs + "@" + rev, ext);
  const r = await ps(COPY(dir + "/" + rel, cacheDir() + name, true) + `; Remove-Item -LiteralPath ${psq(winPath(dir))} -Recurse -Force -ErrorAction SilentlyContinue`).catch(() => null);
  if (!r || r.code !== 0 || !/^\d+\n/.test(r.stdout)) return { kind: "error", message: firstLine(r?.stderr) || "Cannot read this image at that commit" };
  const nl = r.stdout.indexOf("\n");
  return { kind: "image", src: CACHE + name, size, ...(imageSize(unbase64(r.stdout.slice(nl + 1)), ext) ?? {}) };
}
