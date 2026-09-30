// M1b: Session → Receipt. Fixture sessions end to end, plus synthetic Sessions for cases the
// fixtures don't cover (multi-model, pricing edge cases, languages, local time).
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildReceipt } from "../../src/analytics/index.ts";
import { languageOf } from "../../src/analytics/languages.ts";
import { priceCalls, PRICING } from "../../src/analytics/pricing.ts";
import { METRIC_IDS, type Metric, type MetricId, type Receipt } from "../../src/receipt/types.ts";
import { validateReceipt } from "../../src/receipt/validate.ts";
import { renderJson } from "../../src/render/json.ts";
import { loadSessions, refForFile, type ApiCall, type Session, type ToolCall, type Usage } from "../../src/source/claude-code/index.ts";

const DIR = join("fixtures", "claude-code", "2.1.283");
const SUB = join("subagent", readdirSync(join(DIR, "subagent")).find((f) => f.endsWith(".jsonl"))!);
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).concat(SUB);
const NOW = new Date("2026-10-01T00:00:00.000Z");
const load = (...names: string[]) => loadSessions(names.map((n) => refForFile(join(DIR, n))));
const receiptOf = async (name: string, opts = {}) => buildReceipt((await load(name))[0]!, { now: NOW, timeZone: "UTC", ...opts });
const all = (r: Receipt) => Object.values(r.sections).flat();
const get = (r: Receipt, id: MetricId): Metric => all(r).find((m) => m.id === id)!;
const val = (r: Receipt, id: MetricId) => get(r, id).value;

// ---- synthetic Sessions ----
const usage = (u: Partial<Usage> = {}): Usage =>
  ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0, webSearches: 0, ...u });
let n = 0;
const call = (model: string, u: Partial<Usage>, extra: Partial<ApiCall> = {}): ApiCall => ({
  key: `msg_${n++}`, ts: "2026-01-01T10:00:00.000Z", run: 0, agentId: null, model, final: true, stopReason: "end_turn",
  serviceTier: "standard", speed: "standard", usage: usage(u), ...extra,
});
const tool = (t: Partial<ToolCall>): ToolCall => ({
  id: `toolu_${n++}`, name: "Read", ts: "2026-01-01T10:00:00.000Z", run: 0, agentId: null, promptIndex: 0, status: "ok",
  interrupted: false, file: null, command: null, agentType: null, skill: null, ...t,
});
const session = (s: Partial<Session> = {}): Session => ({
  schemaVersion: 1, id: "synthetic", source: { adapter: "claude-code", main: { path: "x.jsonl", sizeBytes: 1, mtimeMs: 0 }, subagents: [], clientVersions: [] },
  entrypoint: "cli", project: { cwd: null, key: null, name: null, otherCwds: [], gitBranches: [] },
  startedAt: "2026-01-01T10:00:00.000Z", endedAt: "2026-01-01T10:30:00.000Z",
  status: { live: false, complete: false, empty: false, truncatedTail: false, badLines: 0 }, fork: null, title: null,
  runs: [{ index: 0, startedAt: "2026-01-01T10:00:00.000Z", endedAt: "2026-01-01T10:30:00.000Z", closed: false, costState: null }],
  prompts: [{ ts: "2026-01-01T10:00:00.000Z", run: 0, kind: "typed", chars: 10 }], turns: [], apiCalls: [], toolCalls: [],
  slashCommands: [], subagents: [], costState: null, reconciliation: null, warnings: [], ...s,
});
const receipt = (s: Partial<Session>, opts = {}) => buildReceipt(session(s), { now: NOW, timeZone: "UTC", ...opts });

// ---- contract ----

test("every fixture yields a Receipt that passes the schema and round-trips as JSON", async () => {
  for (const name of FIXTURES) {
    const r = await receiptOf(name);
    assert.deepEqual(validateReceipt(r), [], name);
    assert.deepEqual(JSON.parse(renderJson(r)), r, name);
    assert.deepEqual(all(r).map((m) => m.id), METRIC_IDS, `${name}: every metric once, in registry order`);
  }
});

test("the validator rejects broken receipts", async () => {
  const r = await receiptOf("ordinary.jsonl");
  const broken = structuredClone(r) as any;
  broken.sections.hard[0].value = null; // null without a reason
  broken.sections.coding.pop(); // a missing metric
  broken.sections.lore[0].provenance = "guess";
  broken.sections.hard[1].label = "ACTIVE TIME"; // presentation copy is not part of the contract
  const errs = validateReceipt(broken);
  for (const re of [/null without reason/, /missing metric/, /provenance/, /unknown field/]) assert.ok(errs.some((e) => re.test(e)), `${re}`);
});

test("invariant: every null metric has a reason and no present metric has one", async () => {
  for (const name of FIXTURES) for (const m of all(await receiptOf(name))) {
    assert.equal(m.value === null, typeof m.unavailableReason === "string", `${name} ${m.id}`);
  }
});

// ---- provenance ----

test("exact: a completed session takes tokens, cost, models and times from cost-state", async () => {
  const r = await receiptOf("ordinary.jsonl");
  for (const id of ["tokens.input", "tokens.output", "tokens.cacheRead", "tokens.cacheWrite", "cost.apiEquivalent", "models.used", "session.duration.open", "api.duration", "prompts.count", "toolCalls.count", "errors.toolErrors"] as const) {
    assert.equal(get(r, id).provenance, "exact", id);
  }
  assert.deepEqual([val(r, "tokens.input"), val(r, "tokens.output"), val(r, "tokens.cacheRead"), val(r, "tokens.cacheWrite")], [42, 908, 139624, 15208]);
  assert.equal(val(r, "cost.apiEquivalent"), 0.0489604);
  assert.deepEqual(val(r, "models.used"), ["claude-haiku-4-5-20251001"]);
  assert.equal(get(r, "tokens.input").detail?.source, "cost-state");
});

test("derived: deterministic rules over recorded events", async () => {
  const r = await receiptOf("ordinary.jsonl");
  for (const id of ["session.duration.wall", "session.runs", "files.created", "files.edited", "lines.added", "lines.removed", "files.mostEdited", "languages", "commands.topPrograms", "lore.rabbitHole", "lore.errorStreak", "lore.cacheHitRate"] as const) {
    assert.equal(get(r, id).provenance, "derived", id);
  }
  assert.equal(val(r, "session.duration.wall"), Date.parse(r.session.endedAt!) - Date.parse(r.session.startedAt!));
});

test("heuristic: thresholds and classifications stay heuristic, and so does anything computed from them", async () => {
  const r = await receiptOf("ordinary.jsonl");
  assert.equal(get(r, "session.duration.active").provenance, "heuristic");
  assert.equal(get(r, "tests.runs").provenance, "heuristic");
  assert.equal(get(r, "commits.byClaude").provenance, "heuristic", "rests on command classification");
  // cost priced with an assumed cache TTL, or with an unpriced model, is heuristic
  const assumed = receipt({ apiCalls: [call("claude-haiku-4-5", { input: 10, cacheWrite: 100, cacheWrite5m: null, cacheWrite1h: null })] });
  assert.equal(get(assumed, "cost.apiEquivalent").provenance, "heuristic");
  assert.equal((get(assumed, "cost.apiEquivalent").detail as any).assumedCacheTtl, true);
  const partial = receipt({ apiCalls: [call("claude-haiku-4-5", { input: 10 }), call("claude-unknown-9", { input: 10 })] });
  assert.equal(get(partial, "cost.apiEquivalent").provenance, "heuristic");
  assert.deepEqual((get(partial, "cost.apiEquivalent").detail as any).unpriced, ["claude-unknown-9"]);
  assert.ok(partial.warnings.some((w) => w.code === "pricing:unpriced:claude-unknown-9"));
});

test("cache hit rate is never exact: it's a computation over token counts", async () => {
  assert.equal(get(await receiptOf("ordinary.jsonl"), "lore.cacheHitRate").provenance, "derived");
});

// ---- missing is not zero ----

test("killed session: everything that needs cost-state or API calls is null with a reason, not 0", async () => {
  const r = await receiptOf("killed.jsonl");
  for (const id of ["session.duration.open", "api.duration", "tokens.input", "tokens.output", "tokens.cacheRead", "tokens.cacheWrite", "cost.apiEquivalent", "models.used", "lore.cacheHitRate", "lore.errorStreak", "lore.rabbitHole", "files.mostEdited", "languages", "lore.readEditRatio"] as const) {
    assert.equal(val(r, id), null, id);
    assert.ok(get(r, id).unavailableReason, id);
  }
  assert.match(get(r, "session.duration.open").unavailableReason!, /no cost-state/);
  assert.equal(val(r, "prompts.count"), 1, "a recorded count is still a count");
});

test("headless sessions record no turn_duration: turns is null, not 0", async () => {
  const r = await receiptOf("ordinary.jsonl");
  assert.equal(val(r, "turns.count"), null);
  assert.match(get(r, "turns.count").unavailableReason!, /headless/);
  assert.equal(val(receipt({ turns: [{ ts: null, run: 0, durationMs: 5000, messageCount: 3 }] }), "turns.count"), 1);
  assert.equal(val(receipt({ prompts: [] }), "turns.count"), 0, "no prompts and no turns is a true zero");
});

test("git metrics are null with a reason when git wasn't run or can't apply", async () => {
  const r = await receiptOf("ordinary.jsonl");
  for (const id of ["commits.inWindow", "commits.coAuthored", "git.lines"] as const) {
    assert.equal(val(r, id), null);
    assert.equal(get(r, id).unavailableReason, "git enrichment not run");
  }
  const notRepo = await receiptOf("ordinary.jsonl", { git: { status: "not-a-repo" } });
  assert.equal(get(notRepo, "commits.inWindow").unavailableReason, "project is not a git repository");
  assert.equal(val(notRepo, "commits.byClaude"), 0, "Claude's commits come from the transcript, not git");
});

// ---- cost-state reconciliation and source selection ----

test("pricing table reproduces Claude Code's own cost-state on every completed fixture", async () => {
  for (const name of ["ordinary.jsonl", "resumed.jsonl", "write-update-replaceall.jsonl", "no-tools.jsonl", SUB]) {
    const [s] = await load(name);
    const p = priceCalls(s!.apiCalls);
    assert.deepEqual(p.unpriced, [], name);
    assert.ok(Math.abs(p.usd - s!.costState!.totalCostUSD) < 1e-9, `${name}: ${p.usd} vs ${s!.costState!.totalCostUSD}`);
  }
});

test("fork: tokens and cost come from the fork's own calls (derived), not its cost-state", async () => {
  const [, fork] = await load("resumed.jsonl", "forked.jsonl");
  const r = buildReceipt(fork!, { now: NOW, timeZone: "UTC" });
  assert.equal(r.session.forkOf, "resumed");
  assert.equal(get(r, "tokens.output").provenance, "derived");
  assert.equal(get(r, "tokens.output").detail?.source, "transcript");
  assert.equal(val(r, "tokens.output"), fork!.apiCalls.reduce((a, c) => a + c.usage.output, 0));
  assert.ok((val(r, "tokens.output") as number) < fork!.costState!.byModel["claude-haiku-4-5-20251001"]!.output);
  assert.equal(get(r, "cost.apiEquivalent").provenance, "derived");
  assert.equal(get(r, "cost.apiEquivalent").detail?.source, "pricing-table");
  assert.equal(val(r, "session.duration.open"), null);
  assert.match(get(r, "session.duration.open").unavailableReason!, /fork/);
  assert.equal(val(r, "prompts.count"), 1);
});

test("resumed: one receipt for the whole session; cost-state totals are the last run's cumulative ones", async () => {
  const [s] = await load("resumed.jsonl");
  const r = buildReceipt(s!, { now: NOW, timeZone: "UTC" });
  assert.equal(val(r, "session.runs"), 3);
  assert.equal(val(r, "session.duration.open"), s!.runs[2]!.costState!.totalDurationMs);
  assert.ok((val(r, "session.duration.wall") as number) > (val(r, "session.duration.open") as number), "wall clock includes the gaps between runs");
  assert.equal(val(r, "prompts.count"), 3);
  assert.equal(val(r, "cost.apiEquivalent"), s!.costState!.totalCostUSD);
});

test("interactive-style cost-state with an auxiliary model: tokens and models include it (exact)", () => {
  const cs = {
    totalCostUSD: 1.5, totalDurationMs: 1000, totalApiDurationMs: 500, totalToolDurationMs: 100, linesAdded: 0, linesRemoved: 0,
    hasUnknownModelCost: false, startTime: 0,
    byModel: {
      "claude-opus-5-5": { input: 100, output: 50, thinking: 10, cacheRead: 1000, cacheWrite: 200, webSearches: 0, costUSD: 1.4 },
      "claude-haiku-4-5-20251001": { input: 900, output: 14, thinking: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, costUSD: 0.1 },
    },
  };
  const r = receipt({ costState: cs, runs: [{ index: 0, startedAt: null, endedAt: null, closed: true, costState: cs }], apiCalls: [call("claude-opus-5-5", { input: 90, output: 40 })] });
  assert.deepEqual(val(r, "models.used"), ["claude-haiku-4-5-20251001", "claude-opus-5-5"]);
  assert.equal(val(r, "tokens.input"), 1000);
  assert.equal(val(r, "cost.apiEquivalent"), 1.5);
});

test("cost-state with an unknown model cost falls back to the pricing table and says so", () => {
  const cs = { totalCostUSD: 0, totalDurationMs: 1, totalApiDurationMs: 1, totalToolDurationMs: 0, linesAdded: 0, linesRemoved: 0, hasUnknownModelCost: true, startTime: 0,
    byModel: { "claude-haiku-4-5": { input: 1000, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, costUSD: 0 } } };
  const r = receipt({ costState: cs, runs: [{ index: 0, startedAt: null, endedAt: null, closed: true, costState: cs }], apiCalls: [call("claude-haiku-4-5", { input: 1000 })] });
  assert.equal(get(r, "cost.apiEquivalent").detail?.source, "pricing-table");
  assert.equal(get(r, "cost.apiEquivalent").detail?.costStateHasUnknownModelCost, true);
  assert.ok(Math.abs((val(r, "cost.apiEquivalent") as number) - 0.001) < 1e-12);
});

// ---- tokens, multi-model, pricing ----

test("multi-model transcript session: per-model detail and totals, priced per model and TTL", () => {
  const r = receipt({
    apiCalls: [
      call("claude-opus-5-5", { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 2_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }),
      call("claude-haiku-4-5-20251001", { input: 1_000_000, output: 1_000_000 }, { agentId: "a1" }),
    ],
  });
  assert.equal(get(r, "tokens.input").provenance, "derived");
  assert.equal(val(r, "tokens.input"), 2_000_000);
  assert.deepEqual(get(r, "tokens.input").detail?.byModel, { "claude-opus-5-5": 1_000_000, "claude-haiku-4-5-20251001": 1_000_000 });
  assert.deepEqual(val(r, "models.used"), ["claude-haiku-4-5-20251001", "claude-opus-5-5"]);
  // opus 5.5: 4 + 20×0.1 + 0.20 + 5 + 8 = 19.2 ; haiku: 1 + 5 = 6
  assert.ok(Math.abs((val(r, "cost.apiEquivalent") as number) - 25.2) < 1e-9);
  assert.equal(get(r, "cost.apiEquivalent").provenance, "derived");
});

test("fast mode and non-standard tiers are not priced from the standard table", () => {
  const p = priceCalls([call("claude-opus-5", { input: 100 }, { speed: "fast" }), call("claude-opus-5", { input: 100 }, { serviceTier: "priority" })]);
  assert.deepEqual(p.unpriced, ["claude-opus-5:fast", "claude-opus-5:priority"]);
  assert.equal(p.pricedCalls, 0);
  const r = receipt({ apiCalls: [call("claude-opus-5", { input: 100 }, { speed: "fast" })] });
  assert.equal(val(r, "cost.apiEquivalent"), null);
  assert.match(get(r, "cost.apiEquivalent").unavailableReason!, /no price for claude-opus-5:fast/);
  assert.ok(PRICING.date);
});

// ---- files, lines, languages ----

test("line counts and file statistics from Write/Edit results match cost-state", async () => {
  const r = await receiptOf("write-update-replaceall.jsonl");
  assert.deepEqual([val(r, "lines.added"), val(r, "lines.removed")], [5, 2]);
  assert.equal(get(r, "lines.added").detail?.matchesCostState, true);
  assert.deepEqual([val(r, "files.read"), val(r, "files.created"), val(r, "files.edited")], [1, 1, 1]);
  assert.deepEqual(get(r, "files.mostEdited").detail, { operations: 3, linesChanged: 7 });
  assert.equal(get(r, "files.mostEdited").sensitive, true);
});

test("file statistics: unique paths (Windows case-insensitive), failed ops excluded, unresolved writes flagged", () => {
  const f = (path: string, op: "read" | "create" | "update" | "edit" | "write", added: number | null, removed: number | null) => ({ path, op, added, removed });
  const r = receipt({
    toolCalls: [
      tool({ name: "Edit", file: f("C:\\Proj\\src\\App.ts", "edit", 3, 1) }),
      tool({ name: "Edit", file: f("c:/proj/src/app.ts", "edit", 2, 0) }),
      tool({ name: "Edit", file: f("C:\\Proj\\x.py", "edit", null, null), status: "error" }),
      tool({ name: "Write", file: f("C:\\Proj\\new.md", "write", null, null), status: "no-result" }),
      tool({ name: "Read", file: f("C:\\Proj\\README.md", "read", null, null) }),
    ],
  });
  assert.equal(val(r, "files.edited"), 1, "same file, different spelling");
  assert.equal(val(r, "files.read"), 1);
  assert.deepEqual([val(r, "lines.added"), val(r, "lines.removed")], [5, 1]);
  assert.deepEqual(get(r, "lines.added").detail, { partial: true, uncountedOps: 1 });
  assert.equal(get(r, "files.edited").detail?.unresolvedWrites, 1);
  assert.equal(val(r, "errors.toolErrors"), 1);
  assert.equal(val(r, "lore.readEditRatio"), 0.5);
});

test("languages: extension map, ambiguous and unknown as Other, weighted by lines changed", () => {
  const cases: [string, string][] = [
    ["a.ts", "TypeScript"], ["b.TSX", "TypeScript"], ["c.py", "Python"], ["d.h", "Other"], ["Dockerfile", "Dockerfile"],
    ["C:\\x\\Makefile", "Makefile"], ["noext", "Other"], [".env", "Other"], ["e.test.js", "JavaScript"], ["f.md", "Markdown"],
  ];
  for (const [path, lang] of cases) assert.equal(languageOf(path), lang, path);
  const edit = (path: string, added: number) => tool({ name: "Edit", file: { path, op: "edit", added, removed: 0 } });
  const r = receipt({ toolCalls: [edit("a.py", 5), edit("b.ts", 10), edit("c.ts", 1), edit("d.h", 2)] });
  assert.deepEqual(val(r, "languages"), [
    { language: "TypeScript", lines: 11, files: 2 }, { language: "Python", lines: 5, files: 1 }, { language: "Other", lines: 2, files: 1 },
  ]);
});

// ---- counts ----

test("prompt, tool, command, error and interruption counts", async () => {
  const r = await receiptOf("ordinary.jsonl");
  assert.equal(val(r, "prompts.count"), 1);
  assert.deepEqual(get(r, "prompts.count").detail, { byKind: { sdk: 1 } });
  assert.equal(val(r, "toolCalls.count"), 4);
  assert.deepEqual(val(r, "toolCalls.byName"), { Write: 1, Edit: 1, Bash: 2 });
  assert.equal(val(r, "commands.count"), 2);
  assert.deepEqual(val(r, "commands.topPrograms"), [{ program: "echo", count: 1 }, { program: "ls", count: 1 }]);
  assert.equal(val(r, "errors.toolErrors"), 1);
  assert.equal(val(r, "interruptions"), 0);
  const sub = await receiptOf(SUB);
  assert.deepEqual(val(sub, "toolCalls.byName"), { Agent: 1, Read: 1 }, "subagent tool calls are part of the session");
});

test("tests.runs counts test-category commands; git commit calls count as Claude's commits", () => {
  const cmd = (program: string, category: any, git: any = null, status: ToolCall["status"] = "ok") =>
    tool({ name: "Bash", status, command: { shell: "bash", program, category, git } });
  const r = receipt({ toolCalls: [cmd("npm", "test"), cmd("pytest", "test"), cmd("git", "git", "commit"), cmd("git", "git", "commit", "error"), cmd("ls", "fs")] });
  assert.equal(val(r, "tests.runs"), 2);
  assert.deepEqual(get(r, "tests.runs").detail, { byProgram: { npm: 1, pytest: 1 } });
  assert.equal(val(r, "commits.byClaude"), 1, "a failed commit isn't a commit");
});

// ---- lore ----

test("lore: rabbit hole, error streak, longest turn, peak hour in the receipt's time zone", () => {
  const at = (h: number, m = 0) => `2026-01-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
  const r = receipt({
    startedAt: at(10), endedAt: at(13),
    prompts: [{ ts: at(10), run: 0, kind: "typed", chars: 5 }, { ts: at(12), run: 0, kind: "typed", chars: 5 }],
    turns: [{ ts: at(11), run: 0, durationMs: 4000, messageCount: 2 }, { ts: at(13), run: 0, durationMs: 9000, messageCount: 5 }],
    toolCalls: [
      tool({ ts: at(10, 1), promptIndex: 0 }),
      tool({ ts: at(12, 1), promptIndex: 1, status: "error" }), tool({ ts: at(12, 2), promptIndex: 1, status: "error" }),
      tool({ ts: at(12, 3), promptIndex: 1 }), tool({ ts: at(12, 40), promptIndex: 1, status: "error" }),
    ],
  }, { timeZone: "Asia/Kolkata" });
  assert.deepEqual(val(r, "lore.rabbitHole"), { promptIndex: 1, toolCalls: 4, durationMs: 40 * 60_000 });
  assert.equal(val(r, "lore.errorStreak"), 2);
  assert.equal(val(r, "lore.longestTurn"), 9000);
  assert.equal(val(r, "lore.peakHour"), 17, "12:xx UTC is 17:xx in India (UTC+5:30)");
  assert.equal(get(r, "lore.peakHour").detail?.timeZone, "Asia/Kolkata");
  assert.equal(r.context.timeZone, "Asia/Kolkata");
  const short = receipt({ endedAt: "2026-01-01T11:00:00.000Z", toolCalls: [tool({})] });
  assert.equal(val(short, "lore.peakHour"), null);
  assert.ok(Array.isArray(get(short, "lore.peakHour").detail?.byHour), "the hour histogram stays available for aggregation");
});

// ---- privacy ----

test("invariant: no fixture text reaches any Receipt; string values are semantic only", async () => {
  for (const name of FIXTURES) {
    const json = renderJson(await receiptOf(name));
    assert.ok(!/x{3,}/.test(json), `${name}: placeholder text leaked`);
    assert.ok(!/<(command|local-command|bash|task-notification)/.test(json), `${name}: tag leaked`);
    assert.ok(!/"(content|text|command|stdout|stderr|patch|message|prompt|description|label)"\s*:/.test(json), `${name}: raw or presentation field`);
  }
});
