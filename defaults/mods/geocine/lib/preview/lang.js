// File extension / fence info string -> the Editor's language, and names for people.
// The Editor highlights with syntect's default set, found by token or by extension ("rs",
// "py", "go", "cpp", "rb", "lua", "sql", "xml", "bat", ...). Languages it lacks map to the
// nearest one it has (TypeScript as JavaScript, TOML as YAML), as Herdr's own Files panel does.
// Adapted from bohumil/herdr-file-preview `lang.js` (MIT). See NOTICE.md.

const ALIAS = {
  js: "js", javascript: "js", jsx: "js", ts: "js", tsx: "js", typescript: "js", mjs: "js", cjs: "js", mts: "js", cts: "js",
  sh: "bash", bash: "bash", shell: "bash", zsh: "bash", console: "bash", fish: "bash", dockerfile: "bash", docker: "bash",
  py: "python", python: "python", pyi: "python", pyw: "python",
  rs: "rust", rust: "rust",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", "c++": "cpp",
  cs: "cs", csharp: "cs", "c#": "cs",
  go: "go", golang: "go",
  java: "java", kt: "java", kts: "java", kotlin: "java", groovy: "groovy", gradle: "groovy", scala: "scala",
  rb: "ruby", ruby: "ruby", php: "php", lua: "lua", pl: "perl", perl: "perl", r: "r",
  json: "json", jsonc: "json", jsonl: "json", ndjson: "json", json5: "json", geojson: "json", lock: "yaml",
  yaml: "yaml", yml: "yaml", toml: "yaml",
  ini: "properties", cfg: "properties", conf: "properties", properties: "properties", env: "properties", editorconfig: "properties",
  html: "html", htm: "html", xhtml: "html", vue: "html", svelte: "html", astro: "html",
  xml: "xml", svg: "xml", xaml: "xml", csproj: "xml", props: "xml", plist: "xml",
  css: "css", scss: "css", less: "css",
  sql: "sql", diff: "diff", patch: "diff", bat: "bat", cmd: "bat", makefile: "make", make: "make", mk: "make",
  hs: "haskell", haskell: "haskell", ml: "ocaml", erl: "erlang", ex: "elixir", exs: "elixir", clj: "clojure",
  tex: "tex", latex: "tex", d: "d", m: "objc", mm: "objc", tcl: "tcl", dot: "dot", graphviz: "dot",
};

const NAMES = {
  js: "JavaScript", bash: "Shell", python: "Python", rust: "Rust", c: "C", cpp: "C++", cs: "C#", go: "Go", java: "Java",
  groovy: "Groovy", scala: "Scala", ruby: "Ruby", php: "PHP", lua: "Lua", perl: "Perl", r: "R", json: "JSON", yaml: "YAML",
  properties: "Properties", html: "HTML", xml: "XML", css: "CSS", sql: "SQL", diff: "Diff", bat: "Batch", make: "Makefile",
  haskell: "Haskell", ocaml: "OCaml", erlang: "Erlang", elixir: "Elixir", clojure: "Clojure", tex: "LaTeX", d: "D",
  objc: "Objective-C", tcl: "Tcl", dot: "Graphviz",
};

// More precise names than the language they highlight as.
const EXACT = {
  ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", jsx: "JSX", mts: "TypeScript", cts: "TypeScript", toml: "TOML",
  sh: "Shell", zsh: "Zsh", fish: "Fish", console: "Console", jsonc: "JSONC", json5: "JSON5", jsonl: "JSON Lines",
  ndjson: "NDJSON", geojson: "GeoJSON", kt: "Kotlin", kts: "Kotlin", kotlin: "Kotlin", scss: "SCSS", less: "Less",
  vue: "Vue", svelte: "Svelte", astro: "Astro", svg: "SVG", ps1: "PowerShell", psm1: "PowerShell", powershell: "PowerShell",
  pwsh: "PowerShell", dockerfile: "Dockerfile", docker: "Dockerfile", mermaid: "Mermaid", ini: "INI", env: "Env",
  text: "Text", txt: "Text", plain: "Text", plaintext: "Text", lock: "Lockfile", csproj: "MSBuild",
};

const MARKDOWN = new Set(["md", "markdown", "mdx", "mdown", "mkd"]);
// Names without an extension that still have a language.
const BARE = { dockerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile", justfile: "makefile", rakefile: "rb", gemfile: "rb", ".bashrc": "sh", ".zshrc": "sh", ".profile": "sh", ".gitignore": "ini", ".gitattributes": "ini", ".npmrc": "ini" };

export const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

export function extension(path) {
  const name = (String(path).split("/").pop() ?? "").toLowerCase();
  if (BARE[name]) return BARE[name];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

export const isMarkdown = (path) => MARKDOWN.has(extension(path));
export const isImage = (path) => IMAGES.has(extension(path));

/** Editor language for a file path, or null (plain text). */
export const forPath = (path) => ALIAS[extension(path)] ?? null;

/** Editor language for a fence info string (first word), or null (plain text). */
export const forFence = (info) => ALIAS[(info ?? "").toLowerCase()] ?? null;

/** JSON is often one minified line: soft-wrapped by default. */
export const wraps = (id) => id === "json";

/** A fence's header: "Python", "TypeScript", the info string as written, or "Text". */
export function fenceLabel(info) {
  const k = (info ?? "").toLowerCase();
  if (!k) return "Text";
  return EXACT[k] ?? NAMES[ALIAS[k]] ?? info;
}

/** For people: "Markdown", "Rust", "Plain text". */
export function label(path) {
  if (isMarkdown(path)) return "Markdown";
  const e = extension(path);
  if (IMAGES.has(e)) return e === "svg" ? "SVG image" : `${e.toUpperCase()} image`;
  return EXACT[e] ?? NAMES[ALIAS[e]] ?? "Plain text";
}

/**
 * Visual rows of soft-wrapped text at `cols` columns. Mirrors the Editor's wrap, calibrated on
 * minified JSON: a row breaks before `{` or `[` or after a space, else mid-token.
 */
export function wrappedRows(text, cols) {
  let rows = 0;
  for (const line of text.split("\n")) {
    let start = 0;
    rows++;
    while (line.length - start > cols) {
      let cut = -1;
      for (let i = start + cols; i > start; i--) {
        const c = line[i];
        if (c === "{" || c === "[" || line[i - 1] === " ") { cut = i; break; }
      }
      start = cut > start ? cut : start + cols;
      while (line[start] === " ") start++;
      rows++;
    }
  }
  return rows;
}
