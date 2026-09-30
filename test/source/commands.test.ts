import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand } from "../../src/source/claude-code/commands.ts";

// Synthetic commands only: classification is a heuristic (METRICS.md tests.runs).
const cases: [string, string, string, string | null][] = [
  ["npm test", "npm", "test", null],
  ["cd web && npm run test:unit", "npm", "test", null],
  ["pnpm install", "pnpm", "install", null],
  ["npm run build", "npm", "build", null],
  ["npm run dev", "npm", "run", null],
  ["FOO=1 pytest -q tests/", "pytest", "test", null],
  ["python -m pytest", "python", "test", null],
  ["python3 -m pip install x", "python3", "install", null],
  ["python script.py", "python", "run", null],
  ["npx vitest run", "npx", "test", null],
  ["npx tsc --noEmit", "npx", "build", null],
  ["node --test", "node", "test", null],
  ["cargo test", "cargo", "test", null],
  ["go build ./...", "go", "build", null],
  ["make check", "make", "test", null],
  ["git status", "git", "git", "other"],
  ["git add . && git commit -m \"msg; with | separators\"", "git", "git", "commit"],
  ["git -C some/path commit -m x", "git", "git", "commit"],
  ["git push origin main", "git", "git", "push"],
  ["grep -rn foo .", "grep", "search", null],
  ["ls -la", "ls", "fs", null],
  ["./deploy-acme-prod.sh --force", "other", "other", null],
  ["C:\\tools\\secret-internal-tool.exe run", "other", "other", null],
  ["Get-ChildItem -Recurse", "get-childitem", "fs", null],
  ["sudo apt-get install jq", "apt-get", "install", null],
  ["", "other", "other", null],
];

test("classifyCommand: program allowlist, category, git kind", () => {
  for (const [cmd, program, category, git] of cases) {
    const c = classifyCommand(cmd, "bash");
    assert.deepEqual([c.program, c.category, c.git], [program, category, git], cmd);
  }
});

test("classifyCommand never returns any part of the command beyond an allowlisted program name", () => {
  for (const [cmd] of cases) {
    const c = classifyCommand(cmd, "powershell");
    const allowed = new Set([c.program, c.category, c.git, c.shell]);
    const out = JSON.stringify(c);
    for (const word of cmd.split(/[^\w-]+/).filter((w) => w.length > 3 && !allowed.has(w.toLowerCase()))) {
      assert.ok(!out.toLowerCase().includes(word.toLowerCase()), `"${word}" leaked from "${cmd}"`);
    }
  }
});
