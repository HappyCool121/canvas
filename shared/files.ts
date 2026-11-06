// Code and text files are sent inline, as a fenced block per file before the
// prompt. Canvas gives the model no tools, so nothing in a file can run.

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", lua: "lua", r: "r", scala: "scala", dart: "dart", ex: "elixir", exs: "elixir",
  hs: "haskell", ml: "ocaml", clj: "clojure", zig: "zig", sol: "solidity", vue: "vue", svelte: "svelte",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish", ps1: "powershell", bat: "batch",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf",
  html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less", svg: "svg", xml: "xml",
  json: "json", jsonc: "jsonc", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", env: "dotenv",
  md: "markdown", mdx: "mdx", tex: "latex", csv: "csv", tsv: "tsv", diff: "diff", patch: "diff",
  dockerfile: "dockerfile", makefile: "makefile", tf: "hcl",
};

export function languageOf(name: string) {
  const base = name.split(/[\\/]/).pop()!.toLowerCase();
  if (base === "dockerfile" || base === "makefile") return base;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? LANGUAGES[base.slice(dot + 1)] ?? "" : "";
}

// The fence is longer than any run of backticks in the file, so a file that
// contains fences can't close the block early.
export function fileBlock(name: string, text: string) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const label = name.replace(/[\r\n]+/g, " ");
  return `File: ${label}\n${fence}${languageOf(name)}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

// A prompt with files: each file's block, then the prompt itself.
export function withFiles(content: string, files: { name: string; text: string }[]) {
  return [...files.map((file) => fileBlock(file.name, file.text)), content].filter((part) => part.trim()).join("\n\n");
}

export const countLines = (text: string) => (text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0);

// Text with no NUL bytes that decodes as UTF-8; anything else is binary.
export function decodeText(bytes: ArrayBuffer | Uint8Array) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}
