// Cheap syntax colors for diff lines: one line at a time, no grammar. Comments, strings, numbers,
// keywords, calls and types, enough to read a diff by. A comment or string left open at the end of
// a line ends there (a diff shows pieces of a file, so there is no reliable state to carry).

const C_LIKE = new Set(["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "java", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "go", "rs", "swift", "kt", "kts", "scala", "dart", "php", "css", "scss", "less", "json", "jsonc", "json5", "zig", "groovy", "gradle", "proto", "glsl", "hlsl", "wgsl", "sol", "v", "vue", "svelte", "astro", "m", "mm"]);
const HASH = new Set(["py", "pyi", "rb", "sh", "bash", "zsh", "fish", "ps1", "psm1", "yaml", "yml", "toml", "r", "pl", "pm", "conf", "cfg", "nix", "ex", "exs", "cmake", "dockerfile", "makefile", "mk", "tf", "hcl", "gitignore", "gitattributes", "env", "properties", "jl", "nim", "cr", "coffee", "tcl"]);
const DASH = new Set(["sql", "lua", "hs", "elm", "ada", "vhd"]);
const SEMI = new Set(["ini", "lisp", "clj", "cljs", "el", "scm", "asm", "s"]);

const KEYWORDS = new Set(("abstract and as async await break case catch class const continue crate def default defer del delete do elif else enum except export extends extern false final finally fn for foreach from func function get global go goto if impl implements import in include instanceof interface is lambda let loop match mod module move mut namespace new nil none not null of or package pass private protected pub public raise readonly record ref return self set static struct super switch synchronized then this throw throws trait true try type typeof union unless unsafe until use using var virtual void volatile when where while with yield None True False end local require elseif begin rescue ensure undef echo fi esac done foreach param select from where join on group by order insert update into values create table drop alter").split(" "));

export function langOf(path) {
  const name = String(path ?? "").split("/").pop().toLowerCase();
  if (name === "dockerfile" || name === "makefile" || name.startsWith(".env")) return "hash";
  if (name.startsWith(".git")) return "hash";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (C_LIKE.has(ext)) return "c";
  if (HASH.has(ext)) return "hash";
  if (DASH.has(ext)) return "dash";
  if (SEMI.has(ext)) return "semi";
  if (ext === "html" || ext === "htm" || ext === "xml" || ext === "svg" || ext === "xaml" || ext === "csproj" || ext === "plist") return "markup";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "md";
  return null;
}

// Classes: k keyword, s string, n number, c comment, f call, t type, p punctuation (null: plain).
// → [[start, end, class]] covering the line.
export function tokenize(text, lang) {
  const out = [];
  if (!lang || text.length > 2000) return [[0, text.length, null]];
  const push = (a, b, cls) => {
    if (b <= a) return;
    const last = out[out.length - 1];
    if (last && last[2] === cls && last[1] === a) last[1] = b; else out.push([a, b, cls]);
  };
  if (lang === "md") {
    const t = text.trimStart();
    push(0, text.length, /^#{1,6}\s/.test(t) ? "k" : /^```/.test(t) ? "s" : /^>\s?/.test(t) ? "c" : /^([-*+]|\d+\.)\s/.test(t) ? "f" : null);
    return out;
  }
  if (lang === "markup") {
    const re = /(<!--.*?(-->|$))|(<\/?[\w:.-]+)|("[^"]*"?|'[^']*'?)|(\/?>)/g;
    let at = 0, m;
    while ((m = re.exec(text))) {
      push(at, m.index, null);
      push(m.index, m.index + m[0].length, m[1] ? "c" : m[3] ? "k" : m[4] ? "s" : "p");
      at = m.index + m[0].length;
    }
    push(at, text.length, null);
    return out;
  }
  const lineComment = lang === "c" ? "//" : lang === "hash" ? "#" : lang === "dash" ? "--" : ";";
  const trimmed = text.trimStart();
  // A block comment's middle line (" * text") reads as comment.
  if (lang === "c" && (trimmed.startsWith("* ") || trimmed === "*" || trimmed.startsWith("*/"))) { push(0, text.length, "c"); return out; }
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (text.startsWith(lineComment, i) && (lang !== "hash" || i === 0 || /\s/.test(text[i - 1]))) { push(i, n, "c"); break; }
    if (lang === "c" && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2), stop = end < 0 ? n : end + 2;
      push(i, stop, "c"); i = stop; continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      const stop = Math.min(n, j + 1);
      push(i, stop, "s"); i = stop; continue;
    }
    if (/[0-9]/.test(ch) && (i === 0 || !/[\w$]/.test(text[i - 1]))) {
      const m = /^(0x[0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?)[a-zA-Z]*/.exec(text.slice(i));
      const stop = i + (m ? m[0].length : 1);
      push(i, stop, "n"); i = stop; continue;
    }
    if (/[A-Za-z_$@]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(text[j])) j++;
      const word = text.slice(i, j);
      let k = j;
      while (k < n && text[k] === " ") k++;
      const cls = KEYWORDS.has(word) ? "k" : text[k] === "(" ? "f" : /^[A-Z][a-z0-9]/.test(word) ? "t" : null;
      push(i, j, cls); i = j; continue;
    }
    push(i, i + 1, /[{}()[\];,.:<>=+\-*/%!&|^~?]/.test(ch) ? "p" : null);
    i++;
  }
  return out;
}
