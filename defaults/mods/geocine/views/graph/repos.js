// Manygit: the repositories under a folder that isn't one itself, after github.com/rabeeh-ta/manygit.
// Ported from rabeeh-ta/herdr-git-graph `repos.js` (MIT, (c) 2026 Rabeeh T A). See NOTICE.md.
// The reference walks with `find`, which Windows doesn't have (its find.exe searches text): here a
// folder on this computer is walked with Herdr's subfolders() and readTextFile(), and `find` is kept
// for spaces on other (Unix) machines.
import { exec, subfolders, readTextFile } from "herdr";
import { gitRead } from "../../lib/git.js";
import { slash } from "../../lib/where.js";

export const DEPTH = { min: 1, max: 5, default: 3 };
// Never descended into: manygit's list, plus every hidden folder and macOS's Library.
const PRUNE = ["node_modules", "vendor", "venv", "__pycache__", "dist", "build", "target", "site-packages", "Library", "$RECYCLE.BIN", "System Volume Information"];
const MAX = 500;

const norm = (p) => slash(p).replace(/\/+$/, "") || "/";
const same = (a, b) => (/^[a-z]:/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);

// A home folder, a drive or a folder above a home isn't searched: too big to walk. home: this
// machine's, or null for another machine, whose usual places count instead.
export function unsearched(cwd, home) {
  const dir = norm(cwd);
  if (dir === "/" || dir === "/root" || /^[a-z]:$/i.test(dir) || /^\/(home|Users)(\/[^/]+)?$/.test(dir) || /^[a-z]:\/Users(\/[^/]+)?$/i.test(dir)) return true;
  if (!home) return false;
  const h = norm(home);
  return same(dir, h) || (/^[a-z]:/i.test(h) ? h.toLowerCase().startsWith(dir.toLowerCase() + "/") : h.startsWith(dir + "/"));
}

export const depthOf = (value) => (Number.isInteger(value) && value >= DEPTH.min && value <= DEPTH.max ? value : DEPTH.default);

const isRepo = async (dir) => {
  const head = await readTextFile(`${dir}/.git/HEAD`).catch(() => null);
  if (head !== null && head !== undefined) return true;
  const file = await readTextFile(`${dir}/.git`).catch(() => null);
  return typeof file === "string" && file.startsWith("gitdir:");
};

const pruned = (name) => name.startsWith(".") || PRUNE.includes(name);

// This computer: level by level, a repository's folder isn't descended into.
async function walkHere(root, depth) {
  const found = [];
  let level = [root];
  for (let d = 1; d <= depth && level.length && found.length < MAX; d++) {
    const next = [];
    for (const dir of level) {
      let subs = [];
      try { subs = subfolders(dir) ?? []; } catch { subs = []; }
      for (const s of subs) {
        const name = slash(s).split("/").pop();
        if (!name || pruned(name)) continue;
        next.push(/[\\/]/.test(s) ? norm(s) : `${dir}/${name}`);
      }
    }
    const repos = await Promise.all(next.map((dir) => isRepo(dir)));
    level = [];
    next.forEach((dir, i) => (repos[i] ? found.push(dir) : level.push(dir)));
  }
  return found.slice(0, MAX);
}

// Another machine: one `find` walk. A repository `depth` folders down has its .git one further.
export function findArgs(root, depth) {
  return ["-H", root, "-mindepth", "1", "-maxdepth", String(depthOf(depth) + 1),
    "(", "-name", ".git", "-print", "-prune", ")", "-o",
    "(", "-type", "d", "(", "-name", ".*", ...PRUNE.flatMap((n) => ["-o", "-name", n]), ")", "-prune", ")"];
}

/** The repositories under root, grouped by the folder they sit in: [{ path, name, group }]. */
export async function findRepos(root, on, depth) {
  const base = norm(root);
  let paths;
  if (!on) paths = await walkHere(base, depthOf(depth));
  else {
    const r = await exec("find", findArgs(base, depth), { on }).catch(() => ({ stdout: "" }));
    paths = [...new Set(r.stdout.split("\n").filter((l) => /\/\.git$/.test(l)).map((l) => l.replace(/\/\.git$/, "")))];
  }
  return paths.filter((p) => p.startsWith(base + "/")).slice(0, MAX).map((path) => {
    const rel = path.slice(base.length + 1), cut = rel.lastIndexOf("/");
    return { path, name: cut < 0 ? rel : rel.slice(cut + 1), group: cut < 0 ? "" : rel.slice(0, cut) };
  }).sort((a, b) => (a.group === b.group ? a.name.localeCompare(b.name) : a.group.localeCompare(b.group)));
}

// Everything a row shows, in one git call: manygit needs six to eight.
const REPO_STATUS = ["status", "--porcelain=v2", "--branch", "-z", "--no-renames", "--untracked-files=normal"];

export function parseRepoStatus(stdout) {
  // head: HEAD's hash (null before the first commit); staged: changes already in the index.
  // gone: the upstream is configured but no longer exists (git prints no branch.ab).
  const s = { branch: null, detached: false, head: null, upstream: null, gone: false, ahead: 0, behind: 0, dirty: 0, staged: 0 };
  let counted = false;
  for (const rec of stdout.split("\0")) {
    if (!rec) continue;
    if (!rec.startsWith("# ")) { s.dirty++; if (/^[12] [^.]/.test(rec)) s.staged++; continue; }
    const [key, ...rest] = rec.slice(2).split(" "), value = rest.join(" ");
    if (key === "branch.oid") s.head = /^[0-9a-f]{40,64}$/.test(value) ? value : null;
    else if (key === "branch.head") { s.detached = value === "(detached)"; s.branch = s.detached ? null : value; }
    else if (key === "branch.upstream") s.upstream = value;
    else if (key === "branch.ab") {
      const m = /^\+(\d+) -(\d+)$/.exec(value);
      if (m) { s.ahead = +m[1]; s.behind = +m[2]; counted = true; }
    }
  }
  s.gone = Boolean(s.upstream) && !counted;
  return s;
}

/** A row's status: one git call, and `git remote` only when the branch has no upstream. */
export async function readRepo(path, on) {
  const r = await gitRead(REPO_STATUS, path, { on });
  if (r.code !== 0) return { error: (r.stderr || "git status failed").trim().split(/\r?\n/).pop() };
  const st = parseRepoStatus(r.stdout);
  if (!st.upstream) st.hasRemote = Boolean((await gitRead(["remote"], path, { on })).stdout.trim());
  return st;
}

/** A repository's remotes and their URLs, for the row's menu. */
export async function readRemotes(path, on) {
  const r = await gitRead(["config", "--get-regexp", "^remote\\..*\\.url$"], path, { on });
  return r.stdout.split(/\r?\n/).map((l) => /^remote\.(.+)\.url (.+)$/.exec(l.trim())).filter(Boolean).map((m) => ({ name: m[1], url: m[2] }));
}

// A remote's page in the browser: http(s) without its credentials, and ssh:// or scp-style URLs on
// their host. A host must have a dot, so paths, ssh aliases and `..` have none.
const HOST = "([a-zA-Z0-9][a-zA-Z0-9-]*(?:\\.[a-zA-Z0-9-]+)+)";
export function webUrl(url) {
  const tail = "\\/(.+?)(?:\\.git)?\\/?$";
  let m = new RegExp(`^(https?):\\/\\/(?:[^/]*@)?${HOST}(:\\d+)?${tail}`).exec(url);
  if (m) return `${m[1]}://${m[2]}${m[3] ?? ""}/${m[4]}`;
  m = new RegExp(`^ssh:\\/\\/(?:[^@/]+@)?${HOST}(?::\\d+)?${tail}`).exec(url)
    ?? new RegExp(`^(?:[^@/:]+@)?${HOST}:(?!\\/)(.+?)(?:\\.git)?\\/?$`).exec(url);
  return m ? `https://${m[1]}/${m[2]}` : null;
}

// What a row says of its upstream (manygit's states, in Herdr's colors).
export function syncOf(st) {
  if (!st) return { kind: "loading", text: "…" };
  if (st.error) return { kind: "error", text: "error" };
  if (st.detached) return { kind: "ok", text: "" };
  if (!st.upstream) return st.hasRemote ? { kind: "unpushed", text: "not pushed" } : { kind: "local", text: "no remote" };
  if (st.gone) return { kind: "gone", text: "upstream gone" };
  if (st.ahead || st.behind) return { kind: "counts", text: "" };
  return { kind: "ok", text: "" };
}

/** Runs fn over items, at most `limit` at a time. */
export async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await fn(items[next++]); }));
}
