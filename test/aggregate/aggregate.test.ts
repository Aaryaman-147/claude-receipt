// v0.2 historical receipts, milestone 1: the pure aggregate module (Receipt[] + scope → HistoryReceipt).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { aggregate, localDate, periodBounds, startOfLocalDay, type AggregateOptions } from "../../src/aggregate/index.ts";
import { HISTORY_METRIC_IDS, type HistoryMetric, type HistoryMetricId, type HistoryReceipt } from "../../src/aggregate/types.ts";
import { validateHistory } from "../../src/aggregate/validate.ts";
import { buildReceipt } from "../../src/analytics/index.ts";
import type { Metric, MetricId, Provenance, Receipt } from "../../src/receipt/types.ts";
import { validateReceipt } from "../../src/receipt/validate.ts";
import { loadSessions, refForFile } from "../../src/source/claude-code/index.ts";

const DIR = join("fixtures", "claude-code", "2.1.283");
const SUB = join("subagent", readdirSync(join(DIR, "subagent")).find((f) => f.endsWith(".jsonl"))!);
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).concat(SUB);
const NOW = new Date("2026-10-01T12:00:00.000Z");
const fixtureReceipts = async () => (await loadSessions(FIXTURES.map((n) => refForFile(join(DIR, n))))).map((s) => buildReceipt(s, { now: NOW, timeZone: "UTC" }));
const all = (h: HistoryReceipt) => Object.values(h.sections).flat();
const get = <K extends HistoryMetricId>(h: HistoryReceipt, id: K) => all(h).find((m) => m.id === id)! as Extract<HistoryMetric, { id: K }>;
const run = (rs: Receipt[], o: Partial<AggregateOptions> = {}) => {
  const h = aggregate(rs, { period: "all", now: NOW, timeZone: "UTC", ...o });
  assert.deepEqual(validateHistory(h), [], "valid HistoryReceipt");
  assert.deepEqual(validateHistory(JSON.parse(JSON.stringify(h))), [], "valid after a JSON round trip");
  return h;
};

// A synthetic session Receipt built from a real fixture Receipt: same valid shape, chosen values.
let base: Receipt;
async function baseReceipt() { return (base ??= (await fixtureReceipts()).find((r) => r.session.id === "ordinary")!); }
type Over = { [K in MetricId]?: unknown | { value: unknown; provenance?: Provenance; detail?: Record<string, unknown> } };
function mk(id: string, startedAt: string | null, over: Over = {}, session: Partial<Receipt["session"]> = {}, tz = "UTC"): Receipt {
  const setTo = (m: Metric): Metric => {
    if (!(m.id in over)) return m;
    const o = over[m.id] as { value: unknown; provenance?: Provenance; detail?: Record<string, unknown> } | unknown;
    const spec = o !== null && typeof o === "object" && "value" in (o as object) ? (o as { value: unknown; provenance?: Provenance; detail?: Record<string, unknown> }) : { value: o };
    const { unavailableReason: _r, detail: _d, ...rest } = m as Metric & { unavailableReason?: string };
    return { ...rest, value: spec.value, ...(spec.provenance ? { provenance: spec.provenance } : {}), ...(spec.value === null ? { unavailableReason: "test" } : {}), ...(spec.detail ? { detail: spec.detail } : {}) } as Metric;
  };
  const r: Receipt = {
    ...base, context: { timeZone: tz },
    session: { ...base.session, id, startedAt, endedAt: startedAt, live: false, complete: true, ...session },
    sections: { hard: base.sections.hard.map(setTo), coding: base.sections.coding.map(setTo), lore: base.sections.lore.map(setTo) },
  };
  assert.deepEqual(validateReceipt(r), [], `synthetic ${id} is a valid Receipt`);
  return r;
}

// ---- calendar ----

test("calendar: local dates and local midnights, including DST days and a zone that skips midnight", () => {
  assert.equal(localDate("2026-09-30T20:00:00.000Z", "Asia/Kolkata"), "2026-10-01");
  assert.equal(startOfLocalDay("2026-10-01", "Asia/Kolkata").toISOString(), "2026-09-30T18:30:00.000Z");
  assert.equal(startOfLocalDay("2026-10-01", "UTC").toISOString(), "2026-10-01T00:00:00.000Z");
  // New York: spring forward (03-08) and fall back (11-01) happen at 02:00, so midnight is ordinary
  assert.equal(startOfLocalDay("2026-03-08", "America/New_York").toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(startOfLocalDay("2026-03-09", "America/New_York").toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal(startOfLocalDay("2026-11-02", "America/New_York").toISOString(), "2026-11-02T05:00:00.000Z");
  // Santiago skips local midnight when DST starts (2026-09-06: 00:00 → 01:00): the day starts at 01:00
  const sday = startOfLocalDay("2026-09-06", "America/Santiago");
  assert.equal(localDate(sday, "America/Santiago"), "2026-09-06");
  assert.equal(localDate(new Date(sday.getTime() - 1), "America/Santiago"), "2026-09-05");
  for (const tz of ["UTC", "Asia/Kolkata", "America/New_York", "America/Santiago", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
    for (const d of ["2026-01-01", "2026-03-08", "2026-03-29", "2026-09-06", "2026-10-04", "2026-11-01"]) {
      const t = startOfLocalDay(d, tz);
      assert.equal(localDate(t, tz), d, `${tz} ${d}: first instant is on the day`);
      assert.notEqual(localDate(new Date(t.getTime() - 1), tz), d, `${tz} ${d}: the instant before is not`);
    }
  }
});

test("periods: week = last 7 local calendar days including today, month = last 30; bounds from local midnights", () => {
  const now = new Date("2026-10-01T03:00:00.000Z"); // 08:30 on Oct 1 in Kolkata
  assert.deepEqual(periodBounds("week", now, "Asia/Kolkata"), { since: "2026-09-24T18:30:00.000Z", until: "2026-10-01T18:30:00.000Z", days: 7 });
  assert.deepEqual(periodBounds("month", now, "Asia/Kolkata"), { since: "2026-09-01T18:30:00.000Z", until: "2026-10-01T18:30:00.000Z", days: 30 });
  assert.deepEqual(periodBounds("week", now, "UTC"), { since: "2026-09-25T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z", days: 7 });
  assert.deepEqual(periodBounds("all", now, "UTC"), { since: null, until: null, days: null });
  // the same instant is a different local day in another zone, so the week differs
  assert.equal(periodBounds("week", new Date("2026-10-01T23:30:00.000Z"), "Asia/Kolkata").since, "2026-09-25T18:30:00.000Z");
});

test("period attribution: a session belongs to the period containing its startedAt (boundaries inclusive/exclusive)", async () => {
  await baseReceipt();
  const { since, until } = periodBounds("week", NOW, "Asia/Kolkata");
  const at = (ms: number) => new Date(ms).toISOString();
  const rs = [
    mk("a-first-instant", since), mk("b-before", at(Date.parse(since!) - 1)), mk("c-last-instant", at(Date.parse(until!) - 1)),
    mk("d-at-until", until), mk("e-undated", null), mk("f-live", since, {}, { live: true, complete: false }),
  ];
  const week = run(rs, { period: "week", timeZone: "Asia/Kolkata" });
  assert.equal(week.coverage.sessions, 2, "first and last instant of the 7 days only");
  assert.equal(week.coverage.undated, 1, "undated sessions stay visible");
  assert.equal(week.coverage.liveExcluded, 1, "live sessions stay visible");
  assert.equal(week.coverage.daysInPeriod, 7);
  assert.deepEqual([week.coverage.firstDate, week.coverage.lastDate], ["2026-09-25", "2026-10-01"]);
  const everything = run(rs, { period: "all", timeZone: "Asia/Kolkata" });
  assert.equal(everything.coverage.sessions, 5, "all: every finished session, undated included, live never");
  assert.equal(everything.coverage.undated, 1);
  assert.equal(everything.coverage.liveExcluded, 1);
  assert.equal(get(everything, "agg.prompts").covered.of, 5);
});

// ---- correctness of sums, coverage and null ----

test("fixtures: valid for every period and project; sums equal the session values; nothing extrapolated", async () => {
  const rs = await fixtureReceipts();
  const h = run(rs);
  const finished = rs.filter((r) => !r.session.live);
  assert.equal(h.coverage.sessions, finished.length);
  const val = (r: Receipt, id: MetricId) => Object.values(r.sections).flat().find((m) => m.id === id)!.value;
  for (const [from, to] of [["tokens.input", "agg.tokens.input"], ["tokens.output", "agg.tokens.output"], ["prompts.count", "agg.prompts"], ["toolCalls.count", "agg.toolCalls"],
    ["lines.added", "agg.lines.added"], ["commands.count", "agg.commands.count"], ["errors.toolErrors", "agg.errors.toolErrors"], ["tests.runs", "agg.tests.runs"]] as [MetricId, HistoryMetricId][]) {
    const having = finished.filter((r) => val(r, from) !== null);
    const m = get(h, to);
    assert.deepEqual(m.covered, { sessions: having.length, of: finished.length }, `${to} coverage`);
    assert.equal(m.value, having.length ? having.reduce((s, r) => s + (val(r, from) as number), 0) : null, `${to} = Σ ${from}`);
  }
  const cost = get(h, "agg.cost.apiEquivalent");
  const costs = finished.map((r) => val(r, "cost.apiEquivalent")).filter((v) => v !== null) as number[];
  assert.ok(Math.abs((cost.value as number) - costs.reduce((a, b) => a + b, 0)) < 1e-9);
  for (const p of ["all", "week", "month"] as const) for (const key of [null, rs[0]!.session.projectKey]) run(rs, { period: p, projectKey: key });
});

test("null is unavailable, never zero: no contributing session → null with a reason; no sessions → every metric null", async () => {
  await baseReceipt();
  const noTokens = { "tokens.input": null, "tokens.output": null, "tokens.cacheRead": null, "tokens.cacheWrite": null, "cost.apiEquivalent": null, "models.used": null };
  const h = run([mk("a", "2026-09-30T10:00:00.000Z", noTokens), mk("b", "2026-09-30T11:00:00.000Z", noTokens)]);
  for (const id of ["agg.tokens.input", "agg.cost.apiEquivalent", "agg.models", "agg.cacheHitRate"] as const) {
    const m = get(h, id);
    assert.equal(m.value, null, id);
    assert.equal(m.covered.sessions, 0);
    assert.ok(m.unavailableReason);
  }
  const partial = run([mk("a", "2026-09-30T10:00:00.000Z", { "tokens.input": 100 }), mk("b", "2026-09-30T11:00:00.000Z", { "tokens.input": null })]);
  assert.equal(get(partial, "agg.tokens.input").value, 100, "only the session that has it; never scaled up");
  assert.deepEqual(get(partial, "agg.tokens.input").covered, { sessions: 1, of: 2 });
  const empty = run([]);
  assert.equal(empty.coverage.sessions, 0);
  assert.equal(empty.coverage.daysInPeriod, null);
  for (const m of all(empty)) { assert.equal(m.value, null, m.id); assert.equal(m.unavailableReason, "no sessions in scope"); }
});

test("provenance: the weakest of the contributing inputs, never stronger than the metric's floor", async () => {
  await baseReceipt();
  const exact = run([mk("a", "2026-09-30T10:00:00.000Z", { "tokens.input": { value: 1, provenance: "exact" } }), mk("b", "2026-09-30T11:00:00.000Z", { "tokens.input": { value: 2, provenance: "exact" } })]);
  assert.equal(get(exact, "agg.tokens.input").provenance, "exact", "all exact stays exact");
  const mixed = run([mk("a", "2026-09-30T10:00:00.000Z", { "tokens.input": { value: 1, provenance: "exact" } }), mk("b", "2026-09-30T11:00:00.000Z", { "tokens.input": { value: 2, provenance: "derived" } })]);
  assert.equal(get(mixed, "agg.tokens.input").provenance, "derived", "one derived input makes the sum derived");
  // a null input doesn't weaken: it didn't contribute
  const withNull = run([mk("a", "2026-09-30T10:00:00.000Z", { "tokens.input": { value: 1, provenance: "exact" } }), mk("b", "2026-09-30T11:00:00.000Z", { "tokens.input": { value: null, provenance: "derived" } })]);
  assert.equal(get(withNull, "agg.tokens.input").provenance, "exact");
  const h = run([mk("a", "2026-09-30T10:00:00.000Z")]);
  assert.equal(get(h, "agg.duration.active").provenance, "heuristic", "active time stays heuristic");
  assert.equal(get(h, "agg.tests.runs").provenance, "heuristic");
  assert.equal(get(h, "agg.commits.byClaude").provenance, "heuristic");
  assert.equal(get(h, "agg.duration.wall").provenance, "derived", "a sum of derived durations");
  assert.equal(get(h, "agg.cacheHitRate").provenance, "derived", "a ratio is derived even from exact tokens");
  for (const m of all(run(await fixtureReceipts()))) assert.ok(["exact", "derived", "heuristic"].includes(m.provenance));
});

// ---- identity: dedup, forks, live, project ----

test("dedup: one session id counts once (keeping the latest-ending copy) and the duplicate is reported", async () => {
  await baseReceipt();
  const older = mk("same", "2026-09-30T10:00:00.000Z", { "prompts.count": 1 }, { endedAt: "2026-09-30T10:05:00.000Z" });
  const newer = mk("same", "2026-09-30T10:00:00.000Z", { "prompts.count": 3 }, { endedAt: "2026-09-30T11:00:00.000Z" });
  for (const order of [[older, newer], [newer, older]]) {
    const h = run(order);
    assert.equal(h.coverage.sessions, 1);
    assert.equal(get(h, "agg.prompts").value, 3);
    assert.deepEqual(h.warnings, [{ code: "duplicate-session", count: 1 }]);
  }
  // a fork has its own id (and its Receipt counts only its own activity): it is its own session
  const fork = mk("fork", "2026-09-30T12:00:00.000Z", { "prompts.count": 2 }, { forkOf: "same" });
  assert.equal(run([newer, fork]).coverage.sessions, 2);
});

test("--project: only sessions with that project key; coverage and top projects follow the filter", async () => {
  await baseReceipt();
  const rs = [
    mk("a", "2026-09-30T10:00:00.000Z", {}, { project: "alpha", projectKey: "c:\\work\\alpha" }),
    mk("b", "2026-09-30T11:00:00.000Z", {}, { project: "alpha", projectKey: "c:\\work\\alpha" }),
    mk("c", "2026-09-30T12:00:00.000Z", {}, { project: "beta", projectKey: "c:\\work\\beta" }),
    mk("d", "2026-09-30T13:00:00.000Z", {}, { project: null, projectKey: null }),
  ];
  const h = run(rs);
  assert.equal(h.coverage.projects, 2);
  assert.deepEqual(get(h, "agg.topProjects").value, [{ project: "alpha", sessions: 2 }, { project: "beta", sessions: 1 }]);
  assert.deepEqual(get(h, "agg.topProjects").covered, { sessions: 3, of: 4 });
  const alpha = run(rs, { projectKey: "c:\\work\\alpha" });
  assert.equal(alpha.coverage.sessions, 2);
  assert.equal(alpha.scope.projectKey, "c:\\work\\alpha");
  assert.equal(run(rs, { projectKey: "c:\\elsewhere" }).coverage.sessions, 0);
});

// ---- metric semantics ----

test("maps and lists sum per key; models count sessions; languages sum lines only", async () => {
  await baseReceipt();
  const h = run([
    mk("a", "2026-09-29T10:00:00.000Z", { "toolCalls.byName": { Bash: 2, Read: 1 }, "languages": [{ language: "TypeScript", lines: 10, files: 2 }], "commands.topPrograms": [{ program: "git", count: 2 }], "models.used": ["claude-x", "claude-y"] }),
    mk("b", "2026-09-30T10:00:00.000Z", { "toolCalls.byName": { Bash: 1, Edit: 4 }, "languages": [{ language: "TypeScript", lines: 5, files: 2 }, { language: "Markdown", lines: 7, files: 1 }], "commands.topPrograms": [{ program: "git", count: 1 }, { program: "npm", count: 3 }], "models.used": ["claude-x"] }),
  ]);
  assert.deepEqual(get(h, "agg.toolCalls.byName").value, { Edit: 4, Bash: 3, Read: 1 });
  assert.deepEqual(get(h, "agg.languages").value, [{ language: "TypeScript", lines: 15 }, { language: "Markdown", lines: 7 }]);
  assert.deepEqual(get(h, "agg.commands.topPrograms").value, [{ program: "git", count: 3 }, { program: "npm", count: 3 }]);
  assert.deepEqual(get(h, "agg.models").value, [{ model: "claude-x", sessions: 2 }, { model: "claude-y", sessions: 1 }]);
});

test("records keep the winning session's local date; ties go to the earliest session", async () => {
  await baseReceipt();
  const h = run([
    mk("a", "2026-09-28T20:00:00.000Z", { "session.duration.wall": 1000, "lore.rabbitHole": { promptIndex: 0, toolCalls: 9, durationMs: 50 }, "lore.longestTurn": 700, "lore.errorStreak": 3 }),
    mk("b", "2026-09-29T20:00:00.000Z", { "session.duration.wall": 5000, "lore.rabbitHole": { promptIndex: 2, toolCalls: 9, durationMs: 80 }, "lore.longestTurn": 900, "lore.errorStreak": 1 }),
  ], { timeZone: "Asia/Kolkata" });
  assert.deepEqual(get(h, "agg.longestSession").value, { durationMs: 5000, date: "2026-09-30" }, "date in the viewer's zone");
  assert.deepEqual(get(h, "agg.rabbitHole").value, { toolCalls: 9, durationMs: 50, date: "2026-09-29" }, "tie → earliest");
  assert.deepEqual(get(h, "agg.longestTurn").value, { durationMs: 900, date: "2026-09-30" });
  assert.deepEqual(get(h, "agg.errorStreak").value, { count: 3, date: "2026-09-29" });
  assert.ok(!JSON.stringify(h).includes("promptIndex"), "no per-session position leaks into history");
});

test("peak hour sums the sessions' hour histograms (even when their own peak is null); cache hit rate is recomputed, not averaged", async () => {
  await baseReceipt();
  const hist = (hours: Record<number, number>) => Array.from({ length: 24 }, (_, i) => hours[i] ?? 0);
  const h = run([
    mk("a", "2026-09-30T10:00:00.000Z", { "lore.peakHour": { value: null, detail: { timeZone: "UTC", byHour: hist({ 9: 5, 22: 1 }) } }, "tokens.input": 0, "tokens.cacheRead": 90, "tokens.cacheWrite": 10 }),
    mk("b", "2026-09-30T11:00:00.000Z", { "lore.peakHour": { value: 22, detail: { timeZone: "UTC", byHour: hist({ 22: 5 }) } }, "tokens.input": 100, "tokens.cacheRead": 0, "tokens.cacheWrite": 0 }),
    mk("c", "2026-09-30T12:00:00.000Z", { "lore.peakHour": null }),
  ]);
  const peak = get(h, "agg.peakHour");
  assert.equal(peak.value, 22, "09:00 has 5, 22:00 has 1 + 5 = 6");
  assert.deepEqual(peak.covered, { sessions: 2, of: 3 }, "the session without a histogram doesn't contribute");
  assert.deepEqual([(peak.detail!.byHour as number[])[9], (peak.detail!.byHour as number[])[22]], [5, 6]);
  const tie = run([mk("a", "2026-09-30T10:00:00.000Z", { "lore.peakHour": { value: null, detail: { timeZone: "UTC", byHour: hist({ 9: 3, 22: 3 }) } } })]);
  assert.equal(get(tie, "agg.peakHour").value, 9, "a tie goes to the earlier hour, as for a session");
  // ratio of sums: 90 / (100 + 90 + 10) = 0.45 (the average of the two ratios would be 0.45 too only by accident: 0.9 and 0)
  assert.equal(get(h, "agg.cacheHitRate").value, 90 / 200);
});

test("calendar lore: busiest day and longest streak use local start dates; undated sessions don't take part", async () => {
  await baseReceipt();
  const h = run([
    mk("a", "2026-09-20T10:00:00.000Z"), mk("b", "2026-09-21T10:00:00.000Z"), mk("c", "2026-09-22T10:00:00.000Z"),
    mk("d", "2026-09-25T10:00:00.000Z"), mk("e", "2026-09-25T11:00:00.000Z"), mk("f", null),
  ]);
  assert.deepEqual(get(h, "agg.busiestDay").value, { date: "2026-09-25", sessions: 2 });
  assert.deepEqual(get(h, "agg.streak").value, { days: 3, from: "2026-09-20", to: "2026-09-22" });
  assert.deepEqual(get(h, "agg.streak").covered, { sessions: 5, of: 6 });
  assert.deepEqual([h.coverage.daysWithData, h.coverage.daysInPeriod, h.coverage.undated], [4, 6, 1]);
});

test("session-only metrics are never aggregated: changing them changes nothing", async () => {
  await baseReceipt();
  const names = HISTORY_METRIC_IDS.map((id) => id.slice("agg.".length));
  for (const banned of ["files.read", "files.created", "files.edited", "files.mostEdited", "commits.inWindow", "commits.coAuthored", "git.lines", "lore.readEditRatio", "readEditRatio", "session.runs", "runs", "duration.open"]) assert.ok(!names.includes(banned), banned);
  assert.ok(!names.some((n) => /file|git|title|phrase|personality/i.test(n)), "no file, git, title or text metric");
  const a = run([mk("a", "2026-09-30T10:00:00.000Z")]);
  const b = run([mk("a", "2026-09-30T10:00:00.000Z", { "files.read": 99, "files.created": 99, "files.edited": 99, "files.mostEdited": "C:\\secret\\x.ts", "commits.inWindow": 99, "commits.coAuthored": 99, "git.lines": { added: 9, removed: 9 }, "lore.readEditRatio": 9, "session.runs": 9, "session.duration.open": 9 }, { title: "a secret title" })]);
  assert.deepEqual(b, a);
});

test("incomplete and mixed-zone sessions are counted and flagged, not hidden", async () => {
  await baseReceipt();
  const h = run([mk("a", "2026-09-30T10:00:00.000Z", {}, { complete: false }), mk("b", "2026-09-30T11:00:00.000Z", {}, {}, "Asia/Kolkata")]);
  assert.equal(h.coverage.incomplete, 1);
  assert.deepEqual(h.coverage.timeZones, ["Asia/Kolkata", "UTC"]);
  assert.deepEqual(h.warnings, [{ code: "mixed-time-zones", count: 2 }]);
});

// ---- purity, determinism, privacy ----

test("pure and deterministic: no clock or randomness, inputs never mutated, same input → same output", async (t) => {
  const deepFreeze = <T>(o: T): T => { if (o && typeof o === "object") { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
  const rs = deepFreeze(await fixtureReceipts());
  const before = JSON.stringify(rs);
  t.mock.method(Date, "now", () => { throw new Error("clock read"); });
  t.mock.method(Math, "random", () => { throw new Error("random read"); });
  const a = aggregate(rs, { period: "month", now: NOW, timeZone: "Asia/Kolkata" });
  const b = aggregate([...rs].reverse(), { period: "month", now: NOW, timeZone: "Asia/Kolkata" });
  t.mock.restoreAll();
  assert.equal(JSON.stringify(a), JSON.stringify(b), "input order doesn't matter");
  assert.equal(JSON.stringify(rs), before);
  for (const f of ["src/aggregate/index.ts", "src/aggregate/types.ts", "src/aggregate/validate.ts"]) {
    const src = readFileSync(f, "utf8");
    for (const [, from] of src.matchAll(/^import[^;]*?from "([^"]+)"/gm)) assert.match(from!, /^\.\.?\/(\.\.\/receipt\/types|types|validate|index)\.ts$|^\.\.\/receipt\/types\.ts$/, `${f} imports ${from}`);
    assert.ok(!/\b(process\.|Date\.now|new Date\(\)|Math\.random|require\(|node:)/.test(src), `${f}: ambient input or I/O`);
  }
});

test("privacy: a HistoryReceipt holds no transcript text, telemetry ids, session ids, titles or paths (unless --project)", async () => {
  const rs = (await fixtureReceipts()).map((r) => ({ ...r, session: { ...r.session, title: "CANARY-TITLE", cwd: "C:\\Users\\canary\\proj" } }));
  const fixtureIds = new Set<string>();
  for (const n of FIXTURES) for (const t of readFileSync(join(DIR, n), "utf8").match(/(?:msg|toolu|req|srvtoolu)_[A-Za-z0-9]+|\ba[0-9a-f]{12}\b/g) ?? []) fixtureIds.add(t);
  assert.ok(fixtureIds.size > 10);
  for (const period of ["all", "week", "month"] as const) {
    const text = JSON.stringify(aggregate(rs, { period, now: NOW, timeZone: "UTC" }));
    assert.ok(!/x{3,}/.test(text), "placeholder transcript text");
    for (const id of fixtureIds) assert.ok(!text.includes(id), `telemetry id ${id}`);
    for (const r of rs) assert.ok(!text.includes(`"${r.session.id}"`), `session id ${r.session.id}`);
    assert.ok(!text.includes("CANARY") && !text.includes("canary") && !text.includes("fixture\\\\project"), "title or path");
    assert.ok(!/"(content|text|thinking|command|stdout|stderr|patch|message|prompt|uuid|requestId|agentId|title|cwd)"\s*:/.test(text), "raw or session field");
  }
  // the one path a HistoryReceipt can hold is the --project key the caller asked for
  const key = rs.find((r) => r.session.projectKey)!.session.projectKey!;
  assert.ok(JSON.stringify(aggregate(rs, { period: "all", now: NOW, timeZone: "UTC", projectKey: key })).includes(JSON.stringify(key).slice(1, -1)));
});

test("validator rejects unknown fields, inconsistent coverage and values without contributors", async () => {
  const h = run(await fixtureReceipts());
  const clone = () => JSON.parse(JSON.stringify(h)) as HistoryReceipt & Record<string, unknown>;
  const x1 = clone(); x1.prompt = "leak"; assert.ok(validateHistory(x1).includes("unknown top-level field"));
  const x2 = clone(); (x2.sections.hard[0] as unknown as Record<string, unknown>).text = "leak"; assert.ok(validateHistory(x2).some((e) => e.endsWith("unknown field")));
  const x3 = clone(); x3.sections.hard[0]!.covered = { sessions: 0, of: h.coverage.sessions }; assert.ok(validateHistory(x3).some((e) => e.includes("no contributing session")));
  const x4 = clone(); (x4.coverage as unknown as Record<string, unknown>).sessionIds = ["a"]; assert.ok(validateHistory(x4).includes("coverage: unknown field"));
  const x5 = clone(); x5.sections.lore = x5.sections.lore.filter((m) => m.id !== "agg.streak"); assert.ok(validateHistory(x5).includes("missing metric agg.streak"));
});
