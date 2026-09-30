// M0: each test pins one verified behaviour of Claude Code 2.1.283 transcripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonl, parseJsonl, dedupeApiCalls, tokensByModel, promptKind, lastCostState, reconcile } from "../scripts/m0/rules.mjs";

const dir = join("fixtures", "claude-code", "2.1.283");
const load = (name) => readJsonl(join(dir, name));
const sumTokens = (records) => tokensByModel(dedupeApiCalls(records));
const assertMatchesCostState = (records, costState) =>
  assert.deepEqual(reconcile(sumTokens(records), costState), [], "transcript totals should equal cost-state");

test("ordinary: each response is split over several lines that share message.id", () => {
  const { records } = load("ordinary.jsonl");
  const lines = records.filter((r) => r.type === "assistant");
  const calls = dedupeApiCalls(records);
  assert.equal(lines.length, 10);
  assert.equal(calls.size, 5);
  // naive summing would double count
  const naive = lines.reduce((s, r) => s + r.message.usage.output_tokens, 0);
  const deduped = sumTokens(records)["claude-haiku-4-5-20251001"].output;
  assert.equal(naive, 2 * deduped);
});

test("ordinary: deduplicated tokens equal cost-state exactly (headless session)", () => {
  const { records } = load("ordinary.jsonl");
  assertMatchesCostState(records, lastCostState(records));
});

// Line rule: Write create = all lines of content; Write update and Edit = structuredPatch +/- lines.
function patchLines(records) {
  let added = 0, removed = 0;
  for (const { toolUseResult: t } of records) {
    if (!t || typeof t !== "object" || !Array.isArray(t.structuredPatch)) continue;
    if (t.type === "create") { added += t.content.split("\n").length - (t.content.endsWith("\n") ? 1 : 0); continue; }
    for (const h of t.structuredPatch) for (const l of h.lines) { if (l[0] === "+") added++; if (l[0] === "-") removed++; }
  }
  return { added, removed };
}

for (const name of ["ordinary.jsonl", "write-update-replaceall.jsonl"]) {
  test(`${name}: Write/Edit patches give the same line counts as cost-state`, () => {
    const { records } = load(name);
    const cs = lastCostState(records);
    assert.deepEqual(patchLines(records), { added: cs.totalLinesAdded, removed: cs.totalLinesRemoved });
  });
}

test("write-update-replaceall: Write update carries a patch, Edit records replaceAll, Read result nests file", () => {
  const results = load("write-update-replaceall.jsonl").records.map((r) => r.toolUseResult).filter((t) => t && typeof t === "object");
  assert.deepEqual(results.filter((t) => t.type === "create" || t.type === "update").map((t) => t.type), ["create", "update"]);
  assert.ok(results.some((t) => t.replaceAll === true && t.structuredPatch.length > 0));
  assert.ok(results.some((t) => t.type === "text" && typeof t.file?.filePath === "string"));
  assertMatchesCostState(load("write-update-replaceall.jsonl").records, lastCostState(load("write-update-replaceall.jsonl").records));
});

test("no-tools: one prompt, zero tool calls, still reconciles", () => {
  const { records } = load("no-tools.jsonl");
  assert.equal(records.filter((r) => promptKind(r)).length, 1);
  assert.equal(records.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : [])).filter((b) => b.type === "tool_use").length, 0);
  assertMatchesCostState(records, lastCostState(records));
});

test("ordinary: Bash success and error shapes", () => {
  const { records } = load("ordinary.jsonl");
  const results = records.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []).filter((b) => b.type === "tool_result").map((b) => ({ b, r })));
  const errors = results.filter(({ b }) => b.is_error === true);
  assert.equal(errors.length, 1);
  assert.equal(typeof errors[0].r.toolUseResult, "string", "an errored tool result is a plain string, no exit code field");
  const ok = results.find(({ r }) => r.toolUseResult && typeof r.toolUseResult === "object" && "stdout" in r.toolUseResult);
  assert.ok(ok, "successful Bash result has structured stdout/stderr");
});

test("subagent: separate file, same sessionId, isSidechain, and parent cost-state includes it", () => {
  const sid = readdirSync(join(dir, "subagent")).find((f) => f.endsWith(".jsonl")).replace(".jsonl", "");
  const parent = load(`subagent/${sid}.jsonl`).records;
  const subFile = readdirSync(join(dir, "subagent", sid, "subagents")).find((f) => f.endsWith(".jsonl"));
  const sub = load(`subagent/${sid}/subagents/${subFile}`).records;
  assert.ok(sub.every((r) => r.isSidechain === true));
  const parentSid = parent.find((r) => r.sessionId).sessionId;
  assert.ok(sub.every((r) => r.sessionId === parentSid), "subagent records carry the parent's sessionId");
  assert.ok(sub.every((r) => typeof r.agentId === "string"));
  assert.ok(parent.filter((r) => "isSidechain" in r).every((r) => r.isSidechain === false));
  const parentIds = new Set(dedupeApiCalls(parent).keys());
  assert.ok([...dedupeApiCalls(sub).keys()].every((id) => !parentIds.has(id)), "no message ids shared: no double counting");
  // parent alone is short of cost-state; parent + subagent equals it
  assert.notDeepEqual(reconcile(sumTokens(parent), lastCostState(parent)), []);
  assertMatchesCostState([...parent, ...sub], lastCostState(parent));
});

test("subagent: a message's first line can carry partial streaming usage, so the last line must win", () => {
  const sid = readdirSync(join(dir, "subagent")).find((f) => f.endsWith(".jsonl")).replace(".jsonl", "");
  const subFile = readdirSync(join(dir, "subagent", sid, "subagents")).find((f) => f.endsWith(".jsonl"));
  const sub = load(`subagent/${sid}/subagents/${subFile}`).records.filter((r) => r.type === "assistant");
  const byId = Map.groupBy(sub, (r) => r.message.id);
  const partial = [...byId.values()].find((ls) => new Set(ls.map((l) => l.message.usage.output_tokens)).size > 1);
  assert.ok(partial, "fixture contains a message whose lines disagree on usage");
  assert.equal(partial[0].message.stop_reason, null);
  assert.ok(partial.at(-1).message.usage.output_tokens > partial[0].message.usage.output_tokens);
});

test("resumed: --resume and --continue append to the same file and sessionId; cost-state is cumulative", () => {
  const { records } = load("resumed.jsonl");
  assert.equal(new Set(records.map((r) => r.sessionId).filter(Boolean)).size, 1);
  const cs = records.filter((r) => r.type === "cost-state");
  assert.equal(cs.length, 3);
  assert.ok(cs[0].totalCostUSD < cs[1].totalCostUSD && cs[1].totalCostUSD < cs[2].totalCostUSD);
  assert.ok(cs.every((c) => c.startTime === cs[0].startTime), "startTime is the original start");
  assert.equal(records.filter((r) => promptKind(r)).length, 3);
  assertMatchesCostState(records, lastCostState(records));
});

test("forked: new sessionId, copies parent history with the same uuids and message ids, cost-state includes inherited usage", () => {
  const parent = load("resumed.jsonl").records, fork = load("forked.jsonl").records;
  const parentSid = parent.find((r) => r.sessionId).sessionId;
  assert.ok(fork.filter((r) => r.sessionId).every((r) => r.sessionId !== parentSid), "copied records are rewritten to the fork's sessionId");
  const parentUuids = new Set(parent.map((r) => r.uuid).filter(Boolean));
  assert.ok(fork.filter((r) => parentUuids.has(r.uuid)).length > 0, "fork shares record uuids with its parent");
  const pIds = new Set(dedupeApiCalls(parent).keys()), fIds = [...dedupeApiCalls(fork).keys()];
  assert.equal(fIds.filter((id) => pIds.has(id)).length, fIds.length - 1, "all but the fork's own new response are copies");
  assertMatchesCostState(fork, lastCostState(fork)); // fork cost-state = inherited + own
  // Summing both sessions double counts; global dedupe by message.id does not.
  const union = dedupeApiCalls([...parent, ...fork]);
  assert.equal(union.size, pIds.size + 1);
});

test("killed: no cost-state, the in-flight response is never written, file still ends cleanly", () => {
  const { records, truncatedTail } = load("killed.jsonl");
  assert.equal(truncatedTail, false);
  assert.equal(lastCostState(records), undefined);
  assert.equal(records.filter((r) => r.type === "assistant").length, 0);
  assert.equal(records.filter((r) => promptKind(r)).length, 1);
});

test("truncated tail: the torn final line is dropped and flagged, earlier records survive", () => {
  const full = load("ordinary.jsonl"), torn = load("truncated-tail.jsonl");
  assert.equal(torn.truncatedTail, true);
  assert.equal(torn.badLines, 0);
  assert.equal(torn.records.length, full.records.length - 1);
});

test("missing final newline on a complete record is not truncation", () => {
  const r = load("no-final-newline.jsonl");
  assert.equal(r.truncatedTail, false);
  assert.equal(r.records.length, load("ordinary.jsonl").records.length);
});

test("bad line in the middle is skipped and counted, not fatal", () => {
  const r = parseJsonl('{"type":"a"}\n{"type":\n{"type":"b"}\n');
  assert.deepEqual([r.records.length, r.badLines, r.truncatedTail], [2, 1, false]);
});

test("unknown record type is ignored by token and prompt rules", () => {
  const r = load("unknown-record.jsonl").records, o = load("ordinary.jsonl").records;
  assert.ok(r.some((x) => x.type === "from-the-future"));
  assert.deepEqual(sumTokens(r), sumTokens(o));
  assert.equal(r.filter((x) => promptKind(x)).length, o.filter((x) => promptKind(x)).length);
});

test("empty transcript (0 bytes, observed on disk) parses to nothing", () => {
  assert.deepEqual(load("empty.jsonl"), { records: [], badLines: 0, truncatedTail: false });
});

test("prompt kinds: only human prompts count", () => {
  for (const r of load("prompt-kinds.jsonl").records) assert.equal(promptKind(r), r._expect, `record ${r.uuid}`);
});

test("reconcile: auxiliary usage in cost-state is info, excess in transcript is a warning", () => {
  const ours = { m: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 } };
  const cs = (o) => ({ modelUsage: { m: { inputTokens: 10, outputTokens: o, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0 }, haiku: { inputTokens: 900 } } });
  assert.deepEqual(reconcile(ours, cs(5)).map((f) => f.level), ["info"]); // haiku only in cost-state
  assert.ok(reconcile(ours, cs(9)).every((f) => f.level === "info"));
  assert.ok(reconcile(ours, cs(4)).some((f) => f.level === "warning"));
  assert.ok(reconcile({ ...ours, x: ours.m }, cs(5)).some((f) => f.level === "warning" && f.reason === "only-in-transcript"));
});
