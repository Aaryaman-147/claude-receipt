// Extension → language. Ambiguous (.h) and unknown extensions are "Other" (METRICS.md `languages`).
const BY_EXT: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", pyi: "Python", ipynb: "Jupyter Notebook",
  rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", kts: "Kotlin", scala: "Scala", swift: "Swift",
  rb: "Ruby", php: "PHP", cs: "C#", fs: "F#", c: "C", cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++",
  dart: "Dart", lua: "Lua", r: "R", ex: "Elixir", exs: "Elixir", erl: "Erlang", hs: "Haskell", clj: "Clojure", zig: "Zig",
  sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell", psm1: "PowerShell", bat: "Batch", cmd: "Batch",
  sql: "SQL", html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", sass: "SCSS", less: "Less",
  vue: "Vue", svelte: "Svelte", astro: "Astro",
  md: "Markdown", mdx: "Markdown", rst: "reStructuredText", txt: "Text",
  json: "JSON", jsonc: "JSON", jsonl: "JSON Lines", yaml: "YAML", yml: "YAML", toml: "TOML", xml: "XML", ini: "INI",
  graphql: "GraphQL", proto: "Protocol Buffers", tf: "Terraform", prisma: "Prisma",
};
const BY_NAME: Record<string, string> = { dockerfile: "Dockerfile", makefile: "Makefile" };

export function languageOf(path: string): string {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (BY_EXT[name.slice(dot + 1)] ?? "Other") : "Other";
}
