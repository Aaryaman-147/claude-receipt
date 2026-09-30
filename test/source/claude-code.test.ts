// Production parser tests. Each pins a behaviour verified in M0 (docs/research/M0_FINDINGS.md)
// against the anonymized fixtures, plus invariants that must hold for any input.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJsonl } from "../../src/source/claude-code/jsonl.ts";
import {
  findSession, liveSessionIds, loadProject, loadSessions, projectKey, reconcile, refForFile, tokensByModel,
  type CostState, type Session,
} from "../../src/source/claude-code/index.ts";

const DIR = join("fixtures", "claude-code", "2.1.283");
const SUB = join("subagent", readdirSync(join(DIR, "subagent")).find((f) => f.endsWith(".jsonl"))!);
const MAIN_FIXTURES = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).concat(SUB);
const fx = (name: string) => join(DIR, name);
const raw = (name: string) => readFileSync(fx(name), "utf8");
const load = (...names: string[]) => loadSessions(names.map((n) => refForFile(fx(n))));
const one = async (name: string) => (await load(name))[0]!;
const tmp = () => mkdtempSync(join(tmpdir(), "claude-receipt-"));
const fromText = async (text: string, id = "00000000-0000-4000-8000-0000000000ff") => {
  const path = join(tmp(), `${id}.jsonl`);
  writeFileSync(path, text);
  return (await loadSessions([refForFile(path)]))[0]!;
};
const lines = (name: string) => raw(name).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const csTokens = (s: Session) => Object.fromEntries(Object.entries(s.costState!.byModel).map(([m, u]) =>
  [m, { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, thinking: u.thinking }]));
const withoutSource = (s: Session) => ({ ...s, source: null, id: null });

// ---- token deduplication (M0 §5) ----

test("duplicate assistant lines become one ApiCall per message.id", async () => {
  const s = await one("ordinary.jsonl");
  assert.equal(lines("ordinary.jsonl").filter((r) => r.type === "assistant").length, 10);
  assert.equal(s.apiCalls.length, 5);
  assert.equal(new Set(s.apiCalls.map((c) => c.key)).size, 5);
  assert.deepEqual(tokensByModel(s.apiCalls), csTokens(s), "deduplicated tokens equal cost-state exactly");
  assert.deepEqual(s.reconciliation, []);
});

test("last line wins: a partial mid-stream line is superseded by the final one", async () => {
  const s = await one(SUB);
  const subFile = s.source.subagents[0]!.path;
  const byId = Map.groupBy(readFileSync(subFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === "assistant"), (r) => r.message.id);
  const partial = [...byId.values()].find((ls) => new Set(ls.map((l) => l.message.usage.output_tokens)).size > 1);
  assert.ok(partial, "fixture has a message whose lines disagree");
  const call = s.apiCalls.find((c) => c.key === partial[0].message.id)!;
  assert.equal(call.usage.output, partial.at(-1).message.usage.output_tokens);
  assert.equal(call.final, true);
  assert.equal(call.ts, partial[0].timestamp, "position comes from the first line");
});

test("invariant: a transcript repeated twice parses to the same calls, tools and prompts", async () => {
  for (const name of MAIN_FIXTURES.filter((n) => raw(n).length)) {
    const text = raw(name).endsWith("\n") ? raw(name) : `${raw(name)}\n`;
    const once = await fromText(text), twice = await fromText(text + text);
    assert.deepEqual(twice.apiCalls, once.apiCalls, name);
    assert.deepEqual(twice.toolCalls, once.toolCalls, name);
    assert.deepEqual(twice.prompts, once.prompts, name);
  }
});

// ---- resumed sessions and runs (M0 §1, addendum) ----

test("resumed: one session, three runs, cumulative cost-states, items tagged with their run", async () => {
  const s = await one("resumed.jsonl");
  assert.equal(s.runs.length, 3);
  assert.ok(s.runs.every((r) => r.closed && r.costState));
  const totals = s.runs.map((r) => r.costState!.totalCostUSD);
  assert.ok(totals[0]! < totals[1]! && totals[1]! < totals[2]!);
  assert.ok(s.runs.every((r) => r.costState!.startTime === s.runs[0]!.costState!.startTime));
  for (let i = 1; i < 3; i++) assert.ok(s.runs[i]!.startedAt! > s.runs[i - 1]!.endedAt!, "runs don't overlap");
  assert.deepEqual(s.prompts.map((p) => p.run), [0, 1, 2]);
  assert.deepEqual([...new Set(s.apiCalls.map((c) => c.run))], [0, 1, 2]);
  assert.equal(s.costState, s.runs[2]!.costState);
  assert.deepEqual(s.reconciliation, []);
  assert.equal(s.status.complete, true);
});

test("interactive exit writes two cost-states with no activity between: still one run", async () => {
  const text = raw("ordinary.jsonl");
  const cs = lines("ordinary.jsonl").findLast((r) => r.type === "cost-state");
  const s = await fromText(`${text}{"type":"last-prompt","lastPrompt":"x"}\n${JSON.stringify({ ...cs, totalDuration: cs.totalDuration + 15 })}\n`);
  assert.equal(s.runs.length, 1);
  assert.equal(s.costState!.totalDurationMs, cs.totalDuration + 15, "the later snapshot wins");
});

test("activity after the last cost-state opens a new, unclosed run", async () => {
  const s = await fromText(`${raw("ordinary.jsonl")}{"type":"queue-operation","operation":"enqueue","timestamp":"2099-01-01T00:00:00.000Z"}\n`);
  assert.equal(s.runs.length, 2);
  assert.equal(s.runs[1]!.closed, false);
  assert.equal(s.status.complete, false);
});

test("killed: open run, no cost-state, nothing to reconcile, the prompt survives", async () => {
  const s = await one("killed.jsonl");
  assert.deepEqual(s.runs.map((r) => r.closed), [false]);
  assert.equal(s.costState, null);
  assert.equal(s.reconciliation, null);
  assert.equal(s.apiCalls.length, 0);
  assert.equal(s.prompts.length, 1);
  assert.equal(s.status.complete, false);
});

// ---- forks and cross-file deduplication (M0 §1) ----

test("fork: parent detected, copied history excluded, own activity kept", async () => {
  const [resumed, forked] = await load("resumed.jsonl", "forked.jsonl");
  assert.equal(resumed!.fork, null);
  assert.equal(forked!.fork?.parentSessionId, "resumed");
  assert.equal(forked!.fork?.inheritedApiCalls, 7);
  assert.equal(forked!.apiCalls.length, 1);
  assert.equal(forked!.prompts.length, 1);
  assert.ok(forked!.startedAt! > resumed!.endedAt!, "a fork's bounds exclude inherited records");
});

test("cross-file dedupe: parent + fork own calls count each API call once and equal the fork's cost-state", async () => {
  const [resumed, forked] = await load("resumed.jsonl", "forked.jsonl");
  const keys = [...resumed!.apiCalls, ...forked!.apiCalls].map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(tokensByModel([...resumed!.apiCalls, ...forked!.apiCalls]), csTokens(forked!));
  assert.deepEqual(forked!.reconciliation, [], "reconciliation compares inherited usage too");
});

test("a fork parsed without its parent is not detected (parent transcript absent)", async () => {
  const s = await one("forked.jsonl");
  assert.equal(s.fork, null);
  assert.equal(s.apiCalls.length, 8);
});

// ---- subagents (M0 §2) ----

test("subagent: separate file joined to the session, attributed, and included in cost-state", async () => {
  const s = await one(SUB);
  assert.equal(s.subagents.length, 1);
  const agent = s.subagents[0]!;
  assert.equal(agent.agentType, "general-purpose");
  assert.equal(agent.model, "haiku");
  const spawn = s.toolCalls.find((t) => t.id === agent.parentToolUseId)!;
  assert.equal(spawn.name, "Agent");
  assert.equal(spawn.agentType, "general-purpose");
  const subCalls = s.apiCalls.filter((c) => c.agentId === agent.agentId);
  assert.ok(subCalls.length > 0 && subCalls.length < s.apiCalls.length);
  const subTools = s.toolCalls.filter((t) => t.agentId === agent.agentId);
  assert.deepEqual(subTools.map((t) => [t.name, t.file?.op, t.promptIndex]), [["Read", "read", spawn.promptIndex]]);
  assert.deepEqual(s.reconciliation, [], "main + subagent equals cost-state");
});

// ---- tools and files ----

test("Write/Edit normalization: ops, paths and line counts", async () => {
  const ordinary = await one("ordinary.jsonl");
  assert.deepEqual(ordinary.toolCalls.filter((t) => t.file).map((t) => [t.name, t.file!.op, t.file!.added, t.file!.removed]),
    [["Write", "create", 2, 0], ["Edit", "edit", 1, 1]]);
  const s = await one("write-update-replaceall.jsonl");
  const ops = s.toolCalls.map((t) => t.file!);
  assert.deepEqual(ops.map((f) => f.op), ["create", "read", "update", "edit"]);
  assert.deepEqual(ops.map((f) => [f.added, f.removed]), [[3, 0], [null, null], [1, 1], [1, 1]]);
  assert.equal(new Set(ops.map((f) => f.path)).size, 1);
  assert.match(ops[0]!.path, /\.txt$/);
  assert.deepEqual(s.reconciliation, [], "line totals equal cost-state");
});

test("Bash success and error are normalized without keeping the command", async () => {
  const s = await one("ordinary.jsonl");
  const bash = s.toolCalls.filter((t) => t.name === "Bash");
  assert.deepEqual(bash.map((t) => [t.command!.program, t.command!.category, t.status]), [["echo", "other", "ok"], ["ls", "fs", "error"]]);
  const json = JSON.stringify(s);
  for (const c of lines("ordinary.jsonl").flatMap((r) => r.message?.content ?? []).filter((b: any) => b?.name === "Bash")) {
    assert.ok(!json.includes(JSON.stringify(c.input.command)), "raw command string absent");
  }
});

// ---- prompts (M0 §7) ----

test("prompt classification: only human prompts count", async () => {
  const expected = lines("prompt-kinds.jsonl").map((r) => r._expect).filter(Boolean);
  const s = await one("prompt-kinds.jsonl");
  assert.deepEqual(s.prompts.map((p) => p.kind), expected);
  assert.ok(s.prompts.every((p) => p.chars > 0));
  assert.deepEqual((await one("resumed.jsonl")).prompts.map((p) => p.kind), ["sdk", "sdk", "sdk"]);
});

test("slash commands keep the command name only", async () => {
  const s = await fromText(`${JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "<command-name>/model</command-name>\n<command-args>secret args</command-args>" } })}\n`);
  assert.deepEqual(s.slashCommands.map((c) => c.name), ["/model"]);
  assert.equal(s.prompts.length, 0);
  assert.ok(!JSON.stringify(s).includes("secret args"));
});

// ---- incomplete input (M0 §3) ----

test("truncated final record is dropped and flagged; the session is incomplete", async () => {
  const s = await one("truncated-tail.jsonl");
  assert.equal(s.status.truncatedTail, true);
  assert.equal(s.status.complete, false);
  assert.equal(s.costState, null, "the torn line was the cost-state");
  assert.equal(s.apiCalls.length, 5);
  assert.ok(s.warnings.some((w) => w.code === "truncated-tail"));
});

test("invariant: truncating at any byte never throws and only removes data", async () => {
  const text = raw("ordinary.jsonl");
  const full = await fromText(text);
  const fullKeys = new Set(full.apiCalls.map((c) => c.key));
  const fullTokens = tokensByModel(full.apiCalls);
  const cuts = new Set<number>();
  for (let i = 0; i <= 60; i++) cuts.add(Math.floor((text.length * i) / 60));
  for (let i = text.indexOf("\n"); i > 0; i = text.indexOf("\n", i + 1)) cuts.add(i).add(i + 1);
  for (const cut of cuts) {
    const s = await fromText(text.slice(0, cut));
    assert.equal(s.status.truncatedTail, !(cut === 0 || text[cut - 1] === "\n" || text[cut] === "\n"), `cut ${cut}`);
    assert.ok(s.apiCalls.every((c) => fullKeys.has(c.key)));
    for (const [model, t] of Object.entries(tokensByModel(s.apiCalls))) {
      for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) assert.ok(t[k] <= fullTokens[model]![k]);
    }
    assert.ok(s.prompts.length <= full.prompts.length && s.toolCalls.length <= full.toolCalls.length);
    assert.ok(!JSON.stringify(s).includes("xxx"), "no text leaks from partial records");
  }
});

test("missing final newline on a complete record is not truncation", async () => {
  assert.deepEqual(withoutSource(await one("no-final-newline.jsonl")), withoutSource(await one("ordinary.jsonl")));
});

test("a bad line mid-file is skipped and counted", async () => {
  const [a, , c] = raw("ordinary.jsonl").split("\n");
  const s = await fromText(`${a}\n{"type":\n${c}\n`);
  assert.equal(s.status.badLines, 1);
  assert.equal(s.status.truncatedTail, false);
});

test("records appended while parsing are ignored: the snapshot size bounds the read", async () => {
  const path = join(tmp(), "live.jsonl");
  writeFileSync(path, raw("ordinary.jsonl"));
  const size = statSync(path).size;
  appendFileSync(path, '{"type":"user","uuid":"late"}\n{"type":"assistant","uu');
  const stats = { badLines: 0, truncatedTail: false };
  let n = 0;
  for await (const _ of readJsonl(path, size, stats)) n++;
  assert.equal(n, lines("ordinary.jsonl").length);
  assert.deepEqual(stats, { badLines: 0, truncatedTail: false });
});

test("empty transcript: an empty, incomplete session", async () => {
  const s = await one("empty.jsonl");
  assert.equal(s.status.empty, true);
  assert.equal(s.status.complete, false);
  assert.deepEqual([s.runs, s.prompts, s.apiCalls, s.toolCalls, s.warnings], [[], [], [], [], []]);
});

test("no-tools session: one prompt, zero tool calls, reconciles", async () => {
  const s = await one("no-tools.jsonl");
  assert.equal(s.prompts.length, 1);
  assert.equal(s.toolCalls.length, 0);
  assert.deepEqual(s.reconciliation, []);
});

test("unknown record types are counted, not fatal, and change nothing else", async () => {
  const s = await one("unknown-record.jsonl"), o = await one("ordinary.jsonl");
  assert.deepEqual(s.warnings, [{ code: "unknown-record-type:from-the-future", count: 1 }]);
  assert.deepEqual(s.apiCalls, o.apiCalls);
  assert.deepEqual(s.prompts, o.prompts);
});

// ---- reconciliation (M0 §6) ----

test("reconcile: auxiliary usage is info; excess in the transcript and line mismatches are warnings", () => {
  const ours = { m: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 } };
  const cs = (output: number, linesAdded = 0): CostState => ({
    totalCostUSD: 0, totalDurationMs: 0, totalApiDurationMs: 0, totalToolDurationMs: 0, linesAdded, linesRemoved: 0,
    hasUnknownModelCost: false, startTime: null,
    byModel: { m: { input: 10, output, thinking: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, costUSD: 0 }, haiku: { input: 900, output: 1, thinking: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, costUSD: 0 } },
  });
  assert.deepEqual(reconcile(ours, cs(5)).map((f) => [f.level, f.code]), [["info", "only-in-cost-state"]]);
  assert.ok(reconcile(ours, cs(9)).every((f) => f.level === "info"));
  assert.ok(reconcile(ours, cs(4)).some((f) => f.level === "warning" && f.code === "transcript-exceeds-cost-state"));
  assert.ok(reconcile({ ...ours, x: ours.m }, cs(5)).some((f) => f.code === "only-in-transcript" && f.level === "warning"));
  assert.ok(reconcile(ours, cs(5, 3), { added: 2, removed: 0 }).some((f) => f.code === "lines-mismatch" && f.level === "warning"));
});

// ---- discovery, live sessions, Windows paths (M0 §3, §4) ----

test("discovery: project identity from record cwd, subagents found, live needs a running PID", async () => {
  const home = tmp();
  const project = join(home, "projects", "not-a-decodable-name");
  const liveId = "00000000-0000-4000-8000-00000000aaaa", deadId = "00000000-0000-4000-8000-00000000bbbb";
  mkdirSync(join(project, "memory"), { recursive: true });
  writeFileSync(join(project, `${liveId}.jsonl`), raw("killed.jsonl"));
  writeFileSync(join(project, `${deadId}.jsonl`), raw("ordinary.jsonl"));
  writeFileSync(join(project, `${deadId}.jsonl.wakatime`), "{}");
  mkdirSync(join(home, "sessions"));
  writeFileSync(join(home, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: liveId }));
  writeFileSync(join(home, "sessions", "2.json"), JSON.stringify({ pid: 2 ** 30, sessionId: deadId, status: "busy" }));
  writeFileSync(join(home, "sessions", "2.key"), "not json, never read");
  writeFileSync(join(home, "sessions", "3.json"), "{ torn");

  assert.deepEqual([...liveSessionIds(home)], [liveId]);
  const sessions = await loadProject(project, home);
  assert.equal(sessions.length, 2);
  const live = sessions.find((s) => s.id === liveId)!, dead = sessions.find((s) => s.id === deadId)!;
  assert.deepEqual([live.status.live, live.status.complete], [true, false]);
  assert.deepEqual([dead.status.live, dead.status.complete], [false, true], "a stale busy entry is not live");
  assert.equal(dead.project.cwd, "C:\\fixture\\project");
  assert.equal(dead.project.name, "project");
  assert.equal((await findSession("00000000-0000-4000-8000-00000000b", home))?.id, deadId);
  await assert.rejects(findSession("00000000", home), /ambiguous/);
  assert.equal(await findSession("ffff", home), null);
});

test("project key: Windows paths group case-insensitively; POSIX paths keep case", () => {
  assert.equal(projectKey("C:\\Users\\Me\\OneDrive\\Proj\\"), projectKey("c:/users/me/onedrive/proj"));
  assert.notEqual(projectKey("/home/Me/Proj"), projectKey("/home/me/proj"));
  assert.equal(projectKey("/home/me/proj/"), "/home/me/proj");
});

// ---- privacy and contract invariants ----

const FORBIDDEN_KEYS = new Set(["content", "text", "thinking_text", "command", "stdout", "stderr", "patch", "structuredPatch", "lines", "description", "prompt", "message", "oldString", "newString", "toolUseResult"]);
// keys whose value is a string (a raw text field would be one); `command` as a CommandInfo object is fine
const keysOf = (v: unknown): string[] =>
  v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [...(!Array.isArray(v) && typeof x === "string" ? [k] : []), ...keysOf(x)]) : [];

test("invariant: Sessions carry no text (fixture placeholders, tags, raw fields) and round-trip as JSON", async () => {
  const groups = [...MAIN_FIXTURES.map((n) => [n]), ["resumed.jsonl", "forked.jsonl"]];
  for (const group of groups) {
    for (const s of await load(...group)) {
      const json = JSON.stringify(s);
      assert.ok(!/x{3,}/.test(json), `${group}: placeholder text leaked`);
      assert.ok(!/<(command|local-command|bash|task-notification|system-reminder)/.test(json), `${group}: tag leaked`);
      assert.deepEqual(keysOf(s).filter((k) => FORBIDDEN_KEYS.has(k)), [], `${group}: raw field present`);
      assert.equal(s.schemaVersion, 1);
      assert.deepEqual(JSON.parse(json), s, "plain serializable data");
    }
  }
});
