// Git enrichment against throwaway repositories (never the user's). Commits get fixed dates
// so the session window is deterministic. Signing and global hooks are disabled for these
// temporary repositories only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildReceipt } from "../../src/analytics/index.ts";
import { gitFacts } from "../../src/git/index.ts";
import type { Session, ToolCall } from "../../src/source/claude-code/index.ts";

// every temp dir this file makes is removed when the file finishes, pass or fail
const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "claude-receipt-git-")); made.push(d); return d; };
const git = (cwd: string, args: string[], date?: string) => execFileSync("git", [
  "-c", "user.name=Receipt Tester", "-c", "user.email=tester@example.invalid", "-c", "commit.gpgsign=false",
  "-c", `core.hooksPath=${join(cwd, ".no-hooks")}`, "-c", "init.defaultBranch=main", ...args,
], { cwd, stdio: "pipe", env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
const commit = (cwd: string, file: string, lines: number, date: string, ...message: string[]) => {
  writeFileSync(join(cwd, file), Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n") + "\n");
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", ...message.flatMap((m) => ["-m", m])], date);
};

const START = "2026-01-01T10:00:00.000Z", END = "2026-01-01T11:00:00.000Z";
const session = (cwd: string | null, toolCalls: ToolCall[] = []): Session => ({
  schemaVersion: 1, id: "git-session", source: { adapter: "claude-code", main: { path: "x", sizeBytes: 1, mtimeMs: 0 }, subagents: [], clientVersions: [] },
  entrypoint: "cli", project: { cwd, key: cwd, name: "repo", otherCwds: [], gitBranches: [] }, startedAt: START, endedAt: END,
  status: { live: false, complete: true, empty: false, truncatedTail: false, badLines: 0 }, fork: null, title: null,
  runs: [], prompts: [], turns: [], apiCalls: [], toolCalls, slashCommands: [], subagents: [], costState: null, reconciliation: null, warnings: [],
});
const metric = (s: Session, id: string, facts = gitFacts(s.project.cwd, s.startedAt, s.endedAt)) =>
  Object.values(buildReceipt(s, { git: facts, timeZone: "UTC" }).sections).flat().find((m) => m.id === id)!;

test("commits in the window: counted, co-authorship detected, lines from numstat; outside commits ignored", () => {
  const repo = tmp();
  git(repo, ["init", "-q"]);
  commit(repo, "before.txt", 7, "2026-01-01T09:00:00Z", "before the session");
  commit(repo, "a.ts", 10, "2026-01-01T10:30:00Z", "feat: secret commit subject", "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>");
  commit(repo, "b.ts", 4, "2026-01-01T10:45:00Z", "chore: human commit");
  commit(repo, "grace.ts", 2, "2026-01-01T11:03:00Z", "within the 5-minute grace");
  commit(repo, "after.txt", 3, "2026-01-01T12:00:00Z", "after the session");

  const facts = gitFacts(repo, START, END);
  assert.equal(facts.status, "ok");
  if (facts.status !== "ok") return;
  assert.equal(facts.hasCommits, true);
  assert.equal(facts.commits.length, 3);
  assert.deepEqual(facts.commits.map((c) => c.claudeCoAuthored).sort(), [false, false, true]);
  assert.equal(facts.commits.reduce((n, c) => n + c.added, 0), 16);
  assert.ok(facts.commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha)));
  const json = JSON.stringify(facts);
  for (const secret of ["secret commit subject", "Receipt Tester", "tester@example.invalid", "noreply@anthropic.com", "a.ts"]) {
    assert.ok(!json.includes(secret), `git facts must not keep "${secret}"`);
  }

  const s = session(repo);
  assert.deepEqual([metric(s, "commits.inWindow").value, metric(s, "commits.coAuthored").value], [3, 1]);
  assert.equal(metric(s, "commits.inWindow").provenance, "exact");
  assert.deepEqual(metric(s, "git.lines").value, { added: 16, removed: 0 });
});

test("Claude's own commit calls are confirmed against git when a commit lands right after the call", () => {
  const repo = tmp();
  git(repo, ["init", "-q"]);
  commit(repo, "a.ts", 1, "2026-01-01T10:30:05Z", "feat: x");
  const call = (ts: string): ToolCall => ({
    id: ts, name: "Bash", ts, run: 0, agentId: null, promptIndex: 0, status: "ok", interrupted: false, file: null,
    command: { shell: "bash", program: "git", category: "git", git: "commit" }, agentType: null, skill: null,
  });
  const m = metric(session(repo, [call("2026-01-01T10:30:00.000Z"), call("2026-01-01T10:50:00.000Z")]), "commits.byClaude");
  assert.equal(m.value, 2);
  assert.equal(m.detail?.confirmedByGit, 1);
});

test("commits on a detached HEAD and on other local branches are included, each once", () => {
  const repo = tmp();
  git(repo, ["init", "-q"]);
  commit(repo, "base.txt", 1, "2026-01-01T09:00:00Z", "base");
  git(repo, ["checkout", "-q", "-b", "feature"]);
  commit(repo, "f.ts", 2, "2026-01-01T10:10:00Z", "on feature");
  git(repo, ["checkout", "-q", "--detach"]);
  commit(repo, "d.ts", 3, "2026-01-01T10:20:00Z", "on detached HEAD");
  const facts = gitFacts(repo, START, END);
  assert.equal(facts.status === "ok" && facts.commits.length, 2);
});

test("an empty repository (no commits yet) is a true zero, not an error", () => {
  const repo = tmp();
  git(repo, ["init", "-q"]);
  const facts = gitFacts(repo, START, END);
  assert.deepEqual(facts.status === "ok" && [facts.hasCommits, facts.commits], [false, []]);
  const s = session(repo);
  assert.equal(metric(s, "commits.inWindow").value, 0);
  assert.deepEqual(metric(s, "git.lines").value, { added: 0, removed: 0 });
  assert.equal(metric(s, "commits.inWindow").detail?.hasCommits, false);
});

test("not a repository, a missing directory, or no timestamps: null with the reason", () => {
  const plain = tmp();
  assert.equal(gitFacts(plain, START, END).status, "not-a-repo");
  assert.equal(gitFacts(join(plain, "gone"), START, END).status, "no-cwd");
  assert.equal(gitFacts(null, START, END).status, "no-cwd");
  assert.equal(gitFacts(plain, null, END).status, "no-window");
  const m = metric(session(plain), "commits.inWindow");
  assert.deepEqual([m.value, m.unavailableReason], [null, "project is not a git repository"]);
});

test("git enrichment is read-only: the repository is byte-for-byte unchanged", () => {
  const repo = tmp();
  git(repo, ["init", "-q"]);
  commit(repo, "a.ts", 3, "2026-01-01T10:30:00Z", "x");
  const snapshot = () => execFileSync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain", "--ignored"], { cwd: repo, encoding: "utf8" })
    + execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
  const before = snapshot();
  const indexBefore = execFileSync("git", ["ls-files", "--stage", "--debug"], { cwd: repo, encoding: "utf8" });
  gitFacts(repo, START, END);
  assert.equal(snapshot(), before);
  assert.equal(execFileSync("git", ["ls-files", "--stage", "--debug"], { cwd: repo, encoding: "utf8" }), indexBefore);
});
