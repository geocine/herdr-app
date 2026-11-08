// What is on disk: one folder's entries (lazy, for the tree) and a list of every path below the
// shown folder (for search outside a repo, or with ignored files). Here, on another machine
// (`on`), and on Windows: PowerShell there (this computer, or a Windows machine without sh).
//
// listDir follows Herdr's `files` mod and carstenlucke/herdr-roundup `roundup-files/disk.js`
// (Apache-2.0); the sh index follows cybertron288/herdr-mods `filetree` (MIT), itself a port of
// claude-code-filetree (MIT). The PowerShell index is new here. See NOTICE.md.
import { exec, window } from "herdr";

export const PER_FOLDER = 500;
// listDir reads at most this many entries of a folder and sorts them before cutting.
const READ_AT_MOST = 10000;
// Search on disk: folders it never enters, how deep and how much it reads.
export const PRUNE = [".git", "node_modules", "target", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".nuxt", ".cache", ".gradle", ".idea", "vendor", "Pods", ".tox", ".mypy_cache", ".pytest_cache", "coverage", "$RECYCLE.BIN", "System Volume Information"];
const HOME_PRUNE = ["Library", "AppData", ".Trash", "scoop", "OneDrive"];
export const INDEX_DIRS = 20000, INDEX_PATHS = 40000;
const DEPTH = 12, HOME_DEPTH = 5;

const localWindows = (on) => !on && window()?.platform === "windows";
// PowerShell reads curly single quotes as quotes too, so they're doubled like '.
export const psQuote = (s) => "'" + String(s).replace(/['‘’‚‛]/g, "$&$&") + "'";
const noSh = (e) => String(e?.message ?? e).includes("cannot start sh");
const UTF8 = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);";
// Windows PowerShell 5.1 is always there; pwsh is faster to start when present, but optional.
async function powershell(script, on, timeout) {
  return exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `${UTF8} ${script}`], { on, timeout });
}

// Natural order, case-insensitive ("file2" before "file10").
export function compare(a, b) {
  const x = a.toLowerCase().match(/\d+|\D+/g) ?? [], y = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const nx = /^\d/.test(x[i]), ny = /^\d/.test(y[i]);
    if (nx && ny && (Number(x[i]) !== Number(y[i]) || x[i].length !== y[i].length)) return Number(x[i]) - Number(y[i]) || x[i].length - y[i].length;
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length || (a < b ? -1 : a > b ? 1 : 0);
}
const sortEntries = (list) => list.sort((a, b) => Number(b.dir) - Number(a.dir) || compare(a.name, b.name));

// One folder: { entries: [{ name, dir }] (folders first, natural order, the first PER_FOLDER),
// more: it held more }. `.git` is left out. A link to a folder is a folder.
export async function listDir(path, on) {
  const viaPowerShell = async () => {
    // Links keep directory attributes even when dangling: check their target. Other reparse
    // points (OneDrive's folders) have no LinkType and are folders.
    const r = await powershell(`& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First ${READ_AT_MOST} | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } ${psQuote(path)}`, on);
    if (r.code !== 0) throw new Error((r.stderr || "Cannot list this folder").trim().split(/\r?\n/)[0]);
    const out = JSON.parse(r.stdout || "[]");
    return Array.isArray(out) ? out : [out];
  };
  let list;
  if (localWindows(on)) list = await viaPowerShell();
  else {
    const script = `n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=\${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -ge ${READ_AT_MOST} ] && break; done; test -d "$1"`;
    let r;
    try { r = await exec("sh", ["-c", script, "geocine-files", path], { on }); }
    catch (e) { if (on && noSh(e)) list = await viaPowerShell(); else throw e; }
    if (!list) {
      if (r.code !== 0) throw new Error((r.stderr || "Cannot list this folder").trim());
      const f = r.stdout.split("\0");
      list = [];
      for (let i = 0; i + 1 < f.length; i += 2) list.push({ name: f[i + 1], dir: f[i] === "d" });
    }
  }
  return { entries: sortEntries(list.filter((e) => e && e.name)).slice(0, PER_FOLDER), more: list.length > PER_FOLDER };
}

const trim = (p) => String(p).replace(/[\\/]+$/, "");
const atHome = (root, homeDir) => {
  const r = trim(root).replace(/\\/g, "/").toLowerCase();
  return r === "" || /^[a-z]:$/.test(r) || (homeDir && r === trim(homeDir).replace(/\\/g, "/").toLowerCase());
};

// Every path below root from the disk: { dirs: Set, all: [rel], full, cut }. Skips PRUNE (and at
// home or a drive's top, HOME_PRUNE at its top level), DEPTH levels (HOME_DEPTH at home), at most
// INDEX_DIRS folders and INDEX_PATHS files. Links to folders are listed, not followed.
export async function diskIndex(root, on, homeDir) {
  const home = atHome(root, on ? null : homeDir);
  const depth = home ? HOME_DEPTH : DEPTH;
  if (localWindows(on)) return windowsIndex(root, on, depth, home);
  try { return await shIndex(root, on, depth, home); }
  catch (e) { if (on && noSh(e)) return windowsIndex(root, on, depth, home); throw e; }
}

// A breadth-first walk with .NET: a pruned or linked folder is listed but not entered.
// Lines: "d<rel>" or "f<rel>", "/"-separated; "!dirs" / "!files" when a limit cut it short.
async function windowsIndex(root, on, depth, home) {
  const prune = PRUNE.map(psQuote).join(","), top = home ? HOME_PRUNE.map(psQuote).join(",") : "";
  const script = `& { param($root)
    $prune = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); foreach ($n in @(${prune})) { [void]$prune.Add($n) }
    $top = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); foreach ($n in @(${top})) { [void]$top.Add($n) }
    $out = [Text.StringBuilder]::new(); $nd = 0; $nf = 0; $cutD = $false; $cutF = $false
    $queue = [Collections.Generic.Queue[object]]::new(); $queue.Enqueue(@([IO.DirectoryInfo]::new($root), '', 0))
    while ($queue.Count -gt 0) {
      $item = $queue.Dequeue(); $dir = $item[0]; $rel = $item[1]; $level = $item[2]
      try { $kids = $dir.EnumerateFileSystemInfos() } catch { continue }
      try {
        foreach ($k in $kids) {
          $name = $k.Name; $r = if ($rel) { $rel + '/' + $name } else { $name }
          if ($k -is [IO.DirectoryInfo]) {
            if ($name -eq '.git') { continue }
            if ($nd -ge ${INDEX_DIRS}) { $cutD = $true; continue }
            $nd++; [void]$out.Append('d').Append($r).Append([char]0)
            $link = ($k.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $k.LinkType
            if (-not $link -and -not $prune.Contains($name) -and -not ($level -eq 0 -and $top.Contains($name)) -and $level + 1 -lt ${depth}) { $queue.Enqueue(@($k, $r, ($level + 1))) }
          } else {
            if ($nf -ge ${INDEX_PATHS}) { $cutF = $true; continue }
            $nf++; [void]$out.Append('f').Append($r).Append([char]0)
          }
        }
      } catch { }
    }
    if ($cutD) { [void]$out.Append('!dirs').Append([char]0) }
    if ($cutF) { [void]$out.Append('!files').Append([char]0) }
    [Console]::Out.Write($out.ToString())
  } ${psQuote(root)}`;
  const r = await powershell(script.replace(/\n\s*/g, "\n"), on, 60000);
  if (r.code !== 0) throw new Error((r.stderr || "Cannot read this folder").trim().split(/\r?\n/)[0]);
  return parseIndex(r.stdout, "\0");
}

async function shIndex(root, on, depth, home) {
  const top = !home ? [] : HOME_PRUNE.map((n) => `-path './${n}'`);
  const names = [...PRUNE.map((n) => `-name '${n}'`), ...top].join(" -o ");
  const skip = `-type d \\( ${names} \\) -prune -o`;
  // NUL-separated (a name may hold a newline); head on NUL records via a tr swap.
  const cut = `cut() { tr '\\000\\n' '\\n\\000' | head -n "$1" | tr '\\n\\000' '\\000\\n'; }`;
  // Folders first, then a "//" record, then the rest.
  const script = `${cut}; cd "$1" || exit 3; find . -mindepth 1 -maxdepth ${depth} ${skip} -type d -print0 2>/dev/null | cut ${INDEX_DIRS + 1}; printf '//\\0'; find . -mindepth 1 -maxdepth ${depth} ${skip} ! -type d -print0 2>/dev/null | cut ${INDEX_PATHS + 1}`;
  const r = await exec("sh", ["-c", script, "geocine-files", root], { on, timeout: 60000 });
  if (r.code === 3) throw new Error("Cannot open this folder");
  let inDirs = true, nd = 0, nf = 0;
  const dirs = new Set(), all = [];
  for (const line of r.stdout.split("\0")) {
    if (line === "//") { inDirs = false; continue; }
    if (!line.startsWith("./")) continue;
    if (inDirs ? ++nd > INDEX_DIRS : ++nf > INDEX_PATHS) continue;
    const rel = line.slice(2);
    all.push(rel);
    if (inDirs) dirs.add(rel);
  }
  const cutBy = [...(nd > INDEX_DIRS ? ["dirs"] : []), ...(nf > INDEX_PATHS ? ["files"] : [])];
  return { dirs, all, full: !cutBy.length, cut: cutBy };
}

function parseIndex(stdout, sep) {
  const dirs = new Set(), all = [], cut = [];
  for (const rec of stdout.split(sep)) {
    if (!rec) continue;
    if (rec === "!dirs" || rec === "!files") { cut.push(rec.slice(1)); continue; }
    const rel = rec.slice(1);
    if (!rel) continue;
    all.push(rel);
    if (rec[0] === "d") dirs.add(rel);
  }
  return { dirs, all, full: !cut.length, cut };
}

// Which of rels (relative to root) exist: Map rel → "d" | "f"; missing ones are left out.
export async function kinds(root, rels, on) {
  const found = new Map();
  if (!rels.length) return found;
  const viaPowerShell = async () => {
    for (let i = 0; i < rels.length; i += 300) {
      const piece = rels.slice(i, i + 300).map(psQuote).join(",");
      const r = await powershell(`& { param($b) foreach ($r in @(${piece})) { $f = Join-Path $b $r; if (Test-Path -LiteralPath $f -PathType Container) { 'd' + $r } elseif (Test-Path -LiteralPath $f) { 'f' + $r } } } ${psQuote(root)}`, on);
      if (r.code !== 0) throw new Error(r.stderr || "Cannot open this folder");
      for (const line of r.stdout.split(/\r?\n/)) if (line.length > 1) found.set(line.slice(1), line[0]);
    }
    return found;
  };
  if (localWindows(on)) return viaPowerShell();
  const script = `cd "$1" || exit 3; shift; for p; do if [ -d "$p" ]; then printf 'd%s\\0' "$p"; elif [ -e "$p" ] || [ -L "$p" ]; then printf 'f%s\\0' "$p"; fi; done`;
  for (let i = 0; i < rels.length; i += 2000) {
    let r;
    try { r = await exec("sh", ["-c", script, "geocine-files", root, ...rels.slice(i, i + 2000)], { on }); }
    catch (e) { if (on && noSh(e)) return viaPowerShell(); throw e; }
    if (r.code !== 0) throw new Error(r.stderr || "Cannot open this folder");
    for (const rec of r.stdout.split("\0")) if (rec.length > 1) found.set(rec.slice(1), rec[0]);
  }
  return found;
}
