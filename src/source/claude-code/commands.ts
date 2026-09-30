import type { CommandCategory, CommandInfo } from "./types.ts";

// Classifies a shell command in memory; the command string itself is never stored.
// Only allowlisted program names survive, so a custom script name ("./deploy-acme.sh")
// becomes "other". This is a heuristic: METRICS.md marks tests.runs as heuristic.

const PROGRAMS: Record<string, CommandCategory> = {
  git: "git", gh: "git",
  npm: "run", pnpm: "run", yarn: "run", bun: "run", npx: "run", pnpx: "run", bunx: "run", deno: "run",
  node: "run", python: "run", python3: "run", py: "run", uv: "run", ruby: "run", java: "run",
  cargo: "build", go: "build", dotnet: "build", mvn: "build", gradle: "build", make: "build", tsc: "build",
  vite: "build", webpack: "build", cmake: "build",
  pip: "install", pip3: "install", brew: "install", "apt-get": "install", apt: "install", winget: "install",
  pytest: "test", jest: "test", vitest: "test", mocha: "test", rspec: "test", phpunit: "test", tox: "test", playwright: "test",
  grep: "search", rg: "search", find: "search", fd: "search", ag: "search", "select-string": "search",
  ls: "fs", dir: "fs", cat: "fs", head: "fs", tail: "fs", wc: "fs", cp: "fs", mv: "fs", rm: "fs", mkdir: "fs", touch: "fs",
  pwd: "fs", chmod: "fs", du: "fs", tree: "fs", "get-childitem": "fs", "get-content": "fs", "set-content": "fs",
  "new-item": "fs", "remove-item": "fs", "copy-item": "fs", "move-item": "fs", "test-path": "fs", "get-item": "fs",
  echo: "other", printf: "other", curl: "other", wget: "other", docker: "other", kubectl: "other", sleep: "other",
};
const TEST_RUNNERS = new Set(["pytest", "jest", "vitest", "mocha", "playwright", "rspec"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const INSTALL_WORDS = new Set(["install", "i", "ci", "add"]);
const PREFIXES = new Set(["sudo", "time", "env", "nohup", "&", "exec"]);

const programName = (word: string) =>
  word.replace(/^["']|["']$/g, "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");

function classifySegment(words: string[]): { program: string; category: CommandCategory; gitKind: CommandInfo["git"] } | null {
  while (words.length && (PREFIXES.has(words[0]!) || /^\w+=/.test(words[0]!))) words.shift();
  if (!words.length) return null;
  const name = programName(words[0]!);
  if (name === "cd" || name === "set-location") return null;
  const category = PROGRAMS[name];
  if (!category) return { program: "other", category: "other", gitKind: null };
  const args = words.slice(1).filter((w) => !w.startsWith("-"));
  const [a0, a1] = args;
  if (name === "git") {
    // skip `-C <path>` / `-c <cfg>` values
    const sub = words.slice(1).find((w, i, all) => !w.startsWith("-") && !/^-[Cc]$/.test(all[i - 1] ?? ""));
    return { program: "git", category: "git", gitKind: sub === "commit" ? "commit" : sub === "push" ? "push" : "other" };
  }
  let cat: CommandCategory = category;
  if (PACKAGE_MANAGERS.has(name)) {
    if (a0 === "test" || (a0 === "run" && a1?.startsWith("test"))) cat = "test";
    else if (a0 && INSTALL_WORDS.has(a0)) cat = "install";
    else if (a0 === "run" && a1 === "build") cat = "build";
  } else if (["npx", "pnpx", "bunx"].includes(name)) {
    const tool = a0 ? programName(a0) : "";
    cat = TEST_RUNNERS.has(tool) ? "test" : tool === "tsc" ? "build" : "run";
  } else if (["python", "python3", "py", "uv"].includes(name)) {
    const m = words.indexOf("-m");
    const mod = m >= 0 ? words[m + 1] : undefined;
    cat = mod === "pytest" || mod === "unittest" ? "test" : mod === "pip" ? "install" : "run";
  } else if (name === "node") {
    cat = words.includes("--test") ? "test" : "run";
  } else if (["cargo", "go", "dotnet", "mvn", "gradle", "make"].includes(name)) {
    if (a0 === "test" || (name === "make" && a0 === "check")) cat = "test";
    else if (a0 === "run") cat = "run";
    else if (name !== "make" && ["add", "get", "install"].includes(a0 ?? "")) cat = "install";
    else cat = "build";
  }
  return { program: name, category: cat, gitKind: null };
}

export function classifyCommand(command: string, shell: CommandInfo["shell"]): CommandInfo {
  const segments = command.split(/&&|\|\||;|\||\n/).map((s) => s.trim().split(/\s+/).filter(Boolean));
  const classified = segments.map(classifySegment).filter((x) => x !== null);
  const first = classified[0];
  const kinds = classified.map((c) => c.gitKind);
  const git = kinds.includes("commit") ? "commit" : kinds.includes("push") ? "push" : kinds.includes("other") ? "other" : null;
  return { shell, program: first?.program ?? "other", category: first?.category ?? "other", git };
}
