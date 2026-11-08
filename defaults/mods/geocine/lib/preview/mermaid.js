// Mermaid fences rendered to PNG with mermaid-cli (mmdc), always on this computer.
// One render at a time (each starts a browser); results live in the mod's hidden .cache/ folder,
// which doesn't reload the mod. On Windows mmdc is found with `where mmdc` and npm's global
// folder, run as `node <its cli.js>` (no .cmd shim, no shell), and draws with Chrome or Edge.
// Diagrams use the Geocine theme's own colors.
// Adapted from bohumil/herdr-file-preview `mermaid.js` (MIT). See NOTICE.md.
import { exec, home, appHome } from "herdr";
import * as fs from "fs/promises";
import { slash } from "../where.js";
import { fnv1a, ps, psq, isWindows, unbase64, imageSize } from "./source.js";

// Set to an absolute mmdc (or mermaid-cli cli.js) path to skip the lookup.
const MMDC = "";

const REL = "mods/geocine/.cache/mermaid/";   // image() paths are relative to the app's folder
const TIMEOUT = 60000, KEEP = 200;

export const MISSING = "Mermaid diagrams need mermaid-cli: npm install -g @mermaid-js/mermaid-cli";
export const NO_BROWSER = "Mermaid diagrams need Google Chrome or Microsoft Edge";

const WIN_BROWSERS = () => [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${slash(home())}/AppData/Local/Google/Chrome/Application/chrome.exe`,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
  `${slash(home())}/AppData/Local/Chromium/Application/chrome.exe`,
];
const UNIX_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const FIND_BROWSER = 'for p in "$PUPPETEER_EXECUTABLE_PATH" "$@"; do [ -n "$p" ] && [ -x "$p" ] && { printf %s "$p"; exit 0; }; done; ' +
  'for n in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge; do command -v "$n" && exit 0; done; exit 1';
const CLI = "node_modules/@mermaid-js/mermaid-cli/src/cli.js";

const dir = () => slash(appHome()).replace(/\/+$/, "") + "/" + REL;
const strip = (c) => (typeof c === "string" && /^#[0-9a-f]{8}$/i.test(c) ? c.slice(0, 7) : c);

/** mmdc's config for the theme now: Mermaid's "base" theme in the Geocine colors. */
export function config(t, dark, font) {
  const v = {
    darkMode: dark, background: strip(t.background), fontFamily: font ?? "Geist, sans-serif", fontSize: "14px",
    primaryColor: strip(t.raised), primaryTextColor: strip(t.foreground), primaryBorderColor: strip(t.accent),
    secondaryColor: strip(t.surface), secondaryTextColor: strip(t.foreground), secondaryBorderColor: strip(t.input),
    tertiaryColor: strip(t.surface), tertiaryTextColor: strip(t.foreground), tertiaryBorderColor: strip(t.border),
    lineColor: strip(t.muted), textColor: strip(t.foreground), mainBkg: strip(t.raised), nodeBorder: strip(t.accent),
    clusterBkg: strip(t.surface), clusterBorder: strip(t.input), titleColor: strip(t.foreground),
    edgeLabelBackground: strip(t.surface), noteBkgColor: strip(t.popover), noteTextColor: strip(t.foreground), noteBorderColor: strip(t.border),
    actorBkg: strip(t.raised), actorBorder: strip(t.accent), actorTextColor: strip(t.foreground), signalColor: strip(t.muted), signalTextColor: strip(t.foreground),
  };
  return JSON.stringify({ theme: "base", themeVariables: v });
}

export const cacheKey = (source, cfg) => fnv1a(source + "|" + cfg);
export const imagePath = (key) => REL + key + ".png";
export const scaledKey = (key, scale) => (scale === 2 ? key : `${key}-s${scale}`);

/** mmdc's stderr without the stack: the message and the parser's pointer lines. */
function trimError(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (/^\s+at /.test(line) || /\((https?|file):\/\//.test(line)) break;
    if (line.trim() || out.length) out.push(line.replace(/\s+$/, ""));
  }
  while (out.length && !out[out.length - 1]) out.pop();
  const msg = out.slice(0, 8).join("\n").trim();
  return (msg.length > 600 ? msg.slice(0, 600) + "…" : msg) || "Mermaid could not render this diagram";
}

/** The first bytes of a file here: fs when the app's folder is in home, else PowerShell. */
async function head(abs) {
  try { const b = await fs.readFile(abs); return b.subarray(0, 64); } catch {}
  if (!isWindows(null)) return null;
  const r = await ps(`$f = [IO.File]::OpenRead(${psq(abs)}); try { $b = New-Object byte[] 64; $n = $f.Read($b, 0, 64) } finally { $f.Close() }; [Console]::Out.Write([Convert]::ToBase64String($b, 0, $n))`).catch(() => null);
  return r?.code === 0 ? unbase64(r.stdout) : null;
}

async function exists(abs) {
  try { if (await fs.exists(abs)) return true; } catch {}
  if (!isWindows(null)) return false;
  const r = await ps(`[Console]::Out.Write((Test-Path -LiteralPath ${psq(abs)}))`).catch(() => null);
  return r?.stdout === "True";
}

/**
 * One per Preview. request() answers through each waiter's done(result, cx), where result is
 * { ok: true, path, w, h } | { error, setup?: true }. Waiters whose alive() turns false are skipped.
 */
export class Mermaid {
  constructor() {
    this.tool = null;          // Promise<{ cmd, pre, pp } | { error }>, resolved once
    this.known = new Map();    // key -> result (renders and real errors; never timeouts)
    this.jobs = new Map();     // key -> job, queued or running
    this.queue = [];
    this.busy = false;
    this.closed = false;
  }

  close() { this.closed = true; this.queue = []; this.jobs.clear(); }

  cached(key) { return this.known.get(key) ?? null; }

  /** A setup notice's Retry: look for mmdc and a browser again. */
  retrySetup() {
    this.tool = null;
    for (const [k, v] of this.known) if (v.setup) this.known.delete(k);
  }

  /** A render error's Retry: render again. */
  forget(key) { if (this.known.get(key)?.error) this.known.delete(key); }

  /** d = { key, source, config, scale? } (scale defaults to 2) */
  request(d, waiter, cx) {
    if (this.closed) return;
    const hit = this.known.get(d.key);
    if (hit) return waiter.done(hit, cx);
    const job = this.jobs.get(d.key);
    if (job) { job.waiters.push(waiter); return; }
    const j = { ...d, waiters: [waiter] };
    this.jobs.set(d.key, j);
    this.queue.push(j);
    this.pump(cx);
  }

  pump(cx) {
    if (this.busy || this.closed) return;
    let job;
    while ((job = this.queue.shift()) && !job.waiters.some((w) => w.alive())) this.jobs.delete(job.key);
    if (!job) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      const answer = (res) => {
        if (!this.jobs.has(job.key)) return;
        this.jobs.delete(job.key);
        if (!res.timeout) this.known.set(job.key, res);
        for (const w of job.waiters) if (w.alive()) w.done(res, cx);
      };
      try { answer(await this.run(job)); }
      catch (e) { answer({ error: String(e?.message ?? e) }); }
      this.busy = false;
      this.pump(cx);
    });
  }

  async run(job) {
    const done = await this.load(job.key);
    if (done) return done;
    const tool = await (this.tool ??= this.resolve());
    if (tool.error) return { error: tool.error, setup: true };
    const base = dir() + job.key, png = base + ".png", cfg = dir() + "config-" + fnv1a(job.config) + ".json";
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(base + ".mmd", job.source);
    await fs.writeFile(cfg, job.config);
    const args = [...tool.pre, "-i", base + ".mmd", "-o", png, "-c", cfg, "-b", "transparent", "-s", String(job.scale ?? 2), "-q", "-p", tool.pp];
    let r;
    try { r = await exec(tool.cmd, args, { timeout: TIMEOUT }); }
    catch (e) {
      const m = String(e?.message ?? e);
      return /time/i.test(m) ? { error: `Rendering took longer than ${TIMEOUT / 1000} s`, timeout: true } : { error: `Cannot run mmdc: ${m}` };
    }
    if (r.code !== 0) return { error: trimError(r.stderr || r.stdout) };
    return (await this.load(job.key)) ?? { error: "mmdc finished without writing a PNG" };
  }

  /** A PNG already in the cache, with its size; null when absent. */
  async load(key) {
    const abs = dir() + key + ".png";
    if (!(await exists(abs))) return null;
    const size = imageSize(await head(abs), "png");
    return size ? { ok: true, path: imagePath(key), w: size.w, h: size.h } : null;
  }

  /** node + mermaid-cli, then a browser for puppeteer. */
  async resolve() {
    const tool = MMDC ? await runs(MMDC, null) : isWindows(null) ? await findWindows() : await findUnix();
    if (!tool) return { error: MISSING };
    const browser = isWindows(null) ? await windowsBrowser() : await unixBrowser();
    if (!browser) return { error: NO_BROWSER };
    await fs.mkdir(dir(), { recursive: true });
    const pp = dir() + "puppeteer.json";
    await fs.writeFile(pp, JSON.stringify({ executablePath: browser, headless: "shell", args: ["--disable-gpu"] }));
    prune();
    return { ...tool, pp, browser };
  }
}

/** { cmd, pre } that runs mermaid-cli (verified with --version), or null. `path`: mmdc, a .cmd shim or cli.js. */
async function runs(path, node) {
  const p = slash(path);
  let tries;
  if (/\.js$/i.test(p)) tries = [{ cmd: node ?? "node", pre: [p] }];
  else if (/\.(cmd|ps1)$/i.test(p) || (isWindows(null) && !/\.exe$/i.test(p))) {
    // npm's Windows shims sit next to node_modules: run the package's cli.js with node directly.
    const d = p.replace(/\/[^/]*$/, "");
    tries = [{ cmd: `${d}/node.exe`, pre: [`${d}/${CLI}`] }, { cmd: node ?? "node", pre: [`${d}/${CLI}`] }];
  } else tries = [{ cmd: p, pre: [] }];
  for (const t of tries) {
    const v = await exec(t.cmd, [...t.pre, "--version"], { timeout: 20000 }).catch(() => null);
    if (v?.code === 0) return { ...t, version: v.stdout.trim() };
  }
  return null;
}

async function findWindows() {
  const dirs = [];
  const w = await exec("where", ["mmdc"]).catch(() => null);
  if (w?.code === 0) for (const l of w.stdout.split(/\r?\n/)) if (l.trim()) dirs.push(slash(l.trim()).replace(/\/[^/]*$/, ""));
  dirs.push(`${slash(home())}/AppData/Roaming/npm`);
  const n = await exec("cmd", ["/d", "/c", "npm", "prefix", "-g"], { timeout: 15000 }).catch(() => null);
  if (n?.code === 0 && n.stdout.trim()) dirs.push(slash(n.stdout.trim().split(/\r?\n/).pop()));
  const seen = new Set();
  for (const d of dirs) {
    if (seen.has(d.toLowerCase())) continue;
    seen.add(d.toLowerCase());
    if (!(await exists(`${d}/${CLI}`))) continue;
    const t = await runs(`${d}/mmdc.cmd`, null);
    if (t) return t;
  }
  return null;
}

async function findUnix() {
  const r = await exec("sh", ["-c", 'command -v mmdc || ls "$HOME/.local/share/fnm/aliases/default/bin/mmdc" 2>/dev/null']).catch(() => null);
  const p = r?.code === 0 ? r.stdout.trim().split("\n")[0] : "";
  return p ? runs(p, null) : null;
}

async function windowsBrowser() {
  const list = WIN_BROWSERS().map((p) => psq(p)).join(", ");
  const r = await ps(`$x = @(${list}) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1; if ($env:PUPPETEER_EXECUTABLE_PATH) { $x = $env:PUPPETEER_EXECUTABLE_PATH }; [Console]::Out.Write("$x")`).catch(() => null);
  return r?.code === 0 && r.stdout.trim() ? slash(r.stdout.trim()) : null;
}

async function unixBrowser() {
  const b = await exec("sh", ["-c", FIND_BROWSER, "fp", ...UNIX_BROWSERS]).catch(() => null);
  return b?.code === 0 ? b.stdout.trim().split("\n")[0] : null;
}

/** Keeps the KEEP newest PNGs (and their sources). */
function prune() {
  if (isWindows(null)) {
    ps(`Get-ChildItem -LiteralPath ${psq(dir())} -Filter *.png | Sort-Object LastWriteTime -Descending | Select-Object -Skip ${KEEP} | ForEach-Object { Remove-Item -LiteralPath $_.FullName, ($_.FullName -replace '\\.png$', '.mmd') -Force -ErrorAction SilentlyContinue }`).catch(() => {});
  } else {
    exec("sh", ["-c", 'cd "$1" 2>/dev/null || exit 0; ls -t -- *.png 2>/dev/null | tail -n +$(($2 + 1)) | while IFS= read -r f; do rm -f -- "$f" "${f%.png}.mmd"; done', "fp", dir(), String(KEEP)]).catch(() => {});
  }
}
