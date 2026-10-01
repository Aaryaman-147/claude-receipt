// v0.2.1 stage 1: the story layer (narrative.ts) and its place in the shared view. Deterministic
// selection, thresholds at their edges, closed vocabulary, fact vs flavour, redaction and privacy.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { aggregate } from "../../src/aggregate/index.ts";
import type { HistoryMetric, HistoryReceipt } from "../../src/aggregate/types.ts";
import { buildReceipt } from "../../src/analytics/index.ts";
import { redactHistory, redactReceipt } from "../../src/receipt/redact.ts";
import type { Metric, Receipt } from "../../src/receipt/types.ts";
import { duration, int, isDisplayed, usd } from "../../src/render/format.ts";
import { COPY, STORY, historyStory, observe, sessionStory, type Story } from "../../src/render/narrative.ts";
import { historyView, sessionView } from "../../src/render/view.ts";
import { loadSessions, refForFile } from "../../src/source/claude-code/index.ts";

const DIR = join("fixtures", "claude-code", "2.1.283");
const NOW = new Date("2026-10-01T12:00:00.000Z");
const one = async (n: string) => buildReceipt((await loadSessions([refForFile(join(DIR, n))]))[0]!, { now: NOW, timeZone: "UTC" });
let cache: Receipt[];
const base = async () => (cache ??= await Promise.all(["ordinary.jsonl", "no-tools.jsonl", "killed.jsonl", "write-update-replaceall.jsonl", "resumed.jsonl"].map(one)));
const hist = async (period: "all" | "week" | "month" = "all") => aggregate(await base(), { period, now: NOW, timeZone: "UTC" });

// Set a session metric (value, and optionally provenance/detail); null keeps the validator's shape.
function setS(r: Receipt, id: Metric["id"], value: unknown, extra: Partial<Pick<Metric, "provenance" | "detail">> = {}): Receipt {
  const f = (m: Metric): Metric => m.id !== id ? m : ({ ...m, value, ...extra, ...(value === null ? { unavailableReason: "test" } : { unavailableReason: undefined }) } as Metric);
  return { ...r, sections: { hard: r.sections.hard.map(f), coding: r.sections.coding.map(f), lore: r.sections.lore.map(f) } };
}
// Set a history metric (value, and optionally provenance/detail/covered).
function setH(h: HistoryReceipt, id: HistoryMetric["id"], value: unknown, extra: Partial<Pick<HistoryMetric, "provenance" | "detail" | "covered">> = {}): HistoryReceipt {
  const f = (m: HistoryMetric): HistoryMetric => m.id !== id ? m : ({ ...m, value, ...extra } as HistoryMetric);
  return { ...h, sections: { hard: h.sections.hard.map(f), coding: h.sections.coding.map(f), lore: h.sections.lore.map(f) } };
}
const cov = (h: HistoryReceipt, c: Partial<HistoryReceipt["coverage"]>): HistoryReceipt => ({ ...h, coverage: { ...h.coverage, ...c } });
const beatIds = (s: Story) => s.beats.map((b) => b.id);
const hours = (byHour: Record<number, number>) => Array.from({ length: 24 }, (_, i) => byHour[i] ?? 0);

// ---- openings and closings ----

test("opening: the first matching rule, else the neutral line; the same input always gives the same words", async () => {
  const h = await hist();
  assert.equal(historyStory(cov(h, { sessions: 20 })).opening, COPY.openings.busy);
  assert.equal(historyStory(setH(cov(h, { sessions: 3 }), "agg.lines.added", 500)).opening, COPY.openings.shipped);
  assert.equal(historyStory(setH(setH(h, "agg.lines.added", 499), "agg.rabbitHole", { toolCalls: 40, durationMs: 1000, date: "2026-09-28" })).opening, COPY.openings.rabbitHole);
  assert.equal(historyStory(setH(setH(h, "agg.lines.added", 1), "agg.streak", { days: 3, from: "2026-09-26", to: "2026-09-28" })).opening, COPY.openings.run);
  assert.equal(historyStory(setH(h, "agg.lines.added", 1)).opening, "HERE'S YOUR RECEIPT.", "the neutral fallback");
  assert.equal(sessionStory(setS((await base())[0]!, "lines.added", 1)).opening, COPY.openings.neutral);
  for (const o of Object.values(COPY.openings)) assert.ok(!/WELCOME BACK|AGAIN/.test(o), "no opening assumes a returning reader");
  const r = (await base())[0]!;
  assert.equal(sessionStory({ ...r, session: { ...r.session, live: true } }).opening, COPY.openings.live);
  assert.equal(sessionStory(setS(r, "session.duration.wall", 3 * 3_600_000)).opening, COPY.openings.busy);
  assert.equal(sessionStory(setS(r, "lines.added", 500)).opening, COPY.openings.shipped);
});

test("opening and closing do not change under redaction (keyed on times and counts, not ids or names)", async () => {
  for (const r of await base()) {
    const a = sessionStory(r), b = sessionStory(redactReceipt(r));
    assert.deepEqual([a.opening, a.closing], [b.opening, b.closing], r.session.id);
    assert.ok((COPY.closings as readonly string[]).includes(a.closing));
  }
  const h = await hist();
  const k = aggregate(await base(), { period: "all", now: NOW, timeZone: "UTC", projectKey: (await base())[0]!.session.projectKey });
  for (const x of [h, k]) {
    const a = historyStory(x), b = historyStory(redactHistory(x));
    assert.deepEqual([a.opening, a.closing], [b.opening, b.closing]);
  }
});

// ---- history beats ----

test("history beats: each one appears exactly at its threshold, in a fixed priority order, at most five", async () => {
  const h = await hist();
  // biggest day: >= 2 days with data and >= 2 sessions that day
  const day = { date: "2026-09-28", sessions: 2 };
  assert.ok(beatIds(historyStory(setH(cov(h, { daysWithData: 2 }), "agg.busiestDay", day))).includes("biggest-day"));
  assert.ok(!beatIds(historyStory(setH(cov(h, { daysWithData: 1 }), "agg.busiestDay", day))).includes("biggest-day"), "one day is not a 'biggest' day");
  assert.ok(!beatIds(historyStory(setH(cov(h, { daysWithData: 2 }), "agg.busiestDay", { ...day, sessions: 1 }))).includes("biggest-day"));
  // rabbit hole: >= 10 tool calls
  const rh = (n: number) => setH(h, "agg.rabbitHole", { toolCalls: n, durationMs: 60_000, date: "2026-09-28" });
  assert.ok(beatIds(historyStory(rh(10))).includes("rabbit-hole"));
  assert.ok(!beatIds(historyStory(rh(9))).includes("rabbit-hole"));
  // the long one: >= 2 sessions and >= 30 min
  const lo = (ms: number) => setH(h, "agg.longestSession", { durationMs: ms, date: "2026-09-28" });
  assert.ok(beatIds(historyStory(lo(30 * 60_000))).includes("long-one"));
  assert.ok(!beatIds(historyStory(lo(30 * 60_000 - 1))).includes("long-one"));
  assert.ok(!beatIds(historyStory(cov(lo(3_600_000), { sessions: 1 }))).includes("long-one"), "one session is not 'the long one'");
  // toolbox: >= 2 tools; nice run: >= 3 days
  assert.ok(!beatIds(historyStory(setH(h, "agg.toolCalls.byName", { Bash: 9 }))).includes("toolbox"));
  assert.ok(beatIds(historyStory(setH(h, "agg.toolCalls.byName", { Bash: 9, Read: 1 }))).includes("toolbox"));
  const run = (d: number) => setH(h, "agg.streak", { days: d, from: "2026-09-20", to: "2026-09-22" });
  assert.ok(beatIds(historyStory(run(3))).includes("nice-run"));
  assert.ok(!beatIds(historyStory(run(2))).includes("nice-run"));
  // everything at once: the first five, in priority order
  let all = cov(setH(setH(setH(setH(setH(setH(h, "agg.busiestDay", day), "agg.rabbitHole", { toolCalls: 50, durationMs: 1, date: "2026-09-28" }), "agg.longestSession", { durationMs: 7_200_000, date: "2026-09-28" }),
    "agg.toolCalls.byName", { Bash: 3, Read: 3 }), "agg.streak", { days: 4, from: "2026-09-20", to: "2026-09-23" }), "agg.topProjects", [{ project: "a", sessions: 3 }, { project: "b", sessions: 1 }]), { daysWithData: 4, projects: 2, sessions: 4 });
  all = setH(all, "agg.lines.added", 5);
  assert.deepEqual(beatIds(historyStory(all)), ["biggest-day", "shipped", "rabbit-hole", "long-one", "toolbox"]);
  assert.equal(historyStory(all).beats.length, STORY.maxBeats);
});

test("history beats: a beat whose data is unavailable, redacted or out of scope simply does not appear", async () => {
  const h = await hist();
  const withProjects = cov(setH(h, "agg.topProjects", [{ project: "alpha", sessions: 3 }, { project: "beta", sessions: 2 }]), { projects: 2 });
  assert.ok(beatIds(historyStory(withProjects)).includes("where-you-worked"));
  assert.ok(!beatIds(historyStory(redactHistory(withProjects))).includes("where-you-worked"), "project names are hidden by redaction");
  assert.ok(!beatIds(historyStory({ ...withProjects, scope: { ...withProjects.scope, projectFilter: true } })).includes("where-you-worked"), "one-project receipts have no project beat");
  const empty = setH(setH(setH(setH(setH(h, "agg.busiestDay", null), "agg.lines.added", null), "agg.lines.removed", null), "agg.rabbitHole", null), "agg.toolCalls.byName", null);
  const s = historyStory(setH(setH(setH(empty, "agg.longestSession", null), "agg.streak", null), "agg.topProjects", null));
  assert.deepEqual(s.beats, [], "no data, no beats, no filler");
  assert.equal(historyStory(setH(setH(h, "agg.lines.added", 0), "agg.lines.removed", 0)).beats.some((b) => b.id === "shipped"), false, "nothing changed is not 'shipped'");
});

test("facts are the metric values, formatted; flavour never changes them; provenance travels with each fact", async () => {
  let h = cov(await hist(), { daysWithData: 3, sessions: 5, projects: 2 });
  h = setH(h, "agg.busiestDay", { date: "2026-09-28", sessions: 4 }, { provenance: "derived" });
  h = setH(h, "agg.rabbitHole", { toolCalls: 60, durationMs: 1_018_000, date: "2026-09-27" });
  h = setH(h, "agg.longestSession", { durationMs: 12_000_000, date: "2026-09-26" });
  h = setH(h, "agg.lines.added", 872, { provenance: "derived" });
  h = setH(h, "agg.lines.removed", 8, { provenance: "derived" });
  const s = historyStory(h);
  const beat = (id: string) => s.beats.find((b) => b.id === id)!;
  assert.deepEqual(beat("biggest-day").facts.map((f) => [f.label, f.value, f.provenance]), [["SESSIONS", "4", "derived"], ["DATE", "2026-09-28", "derived"]]);
  assert.deepEqual(beat("rabbit-hole").facts.map((f) => f.value), [int(60), duration(1_018_000), "2026-09-27"]);
  assert.deepEqual(beat("long-one").facts.map((f) => f.value), [duration(12_000_000), "2026-09-26"]);
  assert.deepEqual(beat("shipped").facts.map((f) => [f.label, f.value]), [["LINES ADDED", "+872"], ["LINES REMOVED", "-8"]]);
  assert.equal(beat("shipped").heading, COPY.beats.shipped);
  for (const b of s.beats) for (const f of b.facts) assert.ok(f.metricId && s.consumed.includes(f.metricId), `${b.id}: consumed lists ${f.metricId}`);
});

test("toolbox ties break by name; hero facts: sessions, projects (unless one project), time in sessions", async () => {
  const h = setH(await hist(), "agg.toolCalls.byName", { Write: 5, Bash: 5, Read: 5, Edit: 2 });
  assert.deepEqual(historyStory(h).beats.find((b) => b.id === "toolbox")!.facts.map((f) => f.label), ["Bash", "Read", "Write"]);
  const s = historyStory(h);
  assert.deepEqual(s.hero.map((f) => f.label), ["SESSIONS", "PROJECTS", "IN SESSIONS"]);
  assert.deepEqual(s.hero.slice(0, 2).map((f) => [f.value, f.provenance]), [[String(h.coverage.sessions), "exact"], [String(h.coverage.projects), "exact"]]);
  const filtered = { ...h, scope: { ...h.scope, projectFilter: true } };
  assert.deepEqual(historyStory(filtered).hero.map((f) => f.label), ["SESSIONS", "IN SESSIONS"]);
  assert.deepEqual(historyStory(setH(h, "agg.duration.wall", null)).hero.map((f) => f.label), ["SESSIONS", "PROJECTS"], "no time, no time hero");
});

// ---- session beats and hero ----

test("session beats and hero: thresholds, order, missing data", async () => {
  const r = (await base())[0]!;
  let x = setS(r, "session.duration.wall", 3_600_000);
  x = setS(x, "lore.rabbitHole", { promptIndex: 0, toolCalls: 10, durationMs: 5000 });
  x = setS(x, "lore.longestTurn", 5 * 60_000);
  x = setS(x, "toolCalls.byName", { Bash: 2, Read: 1 });
  assert.deepEqual(beatIds(sessionStory(x)), ["shipped", "rabbit-hole", "toolbox", "longest-turn"], "THE LONG ONE never repeats the hero duration");
  const below = setS(setS(setS(setS(x, "session.duration.wall", 3_599_999), "lore.rabbitHole", { promptIndex: 0, toolCalls: 9, durationMs: 1 }), "lore.longestTurn", 299_999), "toolCalls.byName", { Bash: 2 });
  assert.deepEqual(beatIds(sessionStory(below)), ["shipped"]);
  assert.deepEqual(sessionStory(x).hero.map((f) => f.label), ["DURATION", "TOKENS OUT", "API EQUIVALENT"]);
  const out = sessionStory(x).hero.find((f) => f.label === "API EQUIVALENT")!;
  assert.equal(out.value, usd(Object.values(x.sections).flat().find((m) => m.id === "cost.apiEquivalent")!.value as number));
  const noTokens = setS(setS(x, "tokens.output", null), "cost.apiEquivalent", null);
  assert.deepEqual(sessionStory(noTokens).hero.map((f) => f.label), ["DURATION"]);
});

// ---- observations ----

test("observations: exact thresholds, priority, minimum data, wording; always heuristic", () => {
  // night owl: >= 50% in 20:00-04:59
  assert.equal(observe(hours({ 22: 20, 10: 20 }), "history")?.id, "night-owl");
  assert.equal(observe(hours({ 22: 20, 10: 21 }), "history")?.id, "early-bird", "49% night, 51% morning");
  // early bird: >= 50% in 05:00-11:59
  assert.equal(observe(hours({ 9: 25, 14: 25 }), "history")?.id, "early-bird");
  assert.equal(observe(hours({ 9: 24, 14: 26 }), "history"), null);
  // after hours: neither, >= 35% in 18:00-23:59 and the peak hour in 18-23
  assert.equal(observe(hours({ 18: 20, 14: 15, 15: 15 }), "history")?.id, "after-hours");
  assert.equal(observe(hours({ 18: 14, 19: 0, 14: 18, 15: 8 }), "history"), null, "35% evening but the peak is 14:00");
  assert.equal(observe(hours({ 18: 13, 14: 12, 15: 12, 16: 3 }), "history"), null, "32.5% evening");
  // minimum data
  assert.equal(observe(hours({ 22: 39 }), "history"), null, "39 events");
  assert.equal(observe(hours({ 22: 40 }), "history")?.id, "night-owl");
  assert.equal(observe([1, 2, 3], "history"), null);
  assert.equal(observe(undefined, "history"), null);
  // wording: never "you are"; session vs history; provenance
  const s = observe(hours({ 22: 40 }), "session")!, h = observe(hours({ 22: 40 }), "history")!;
  assert.deepEqual([s.heading, s.provenance, h.provenance], ["NIGHT OWL", "heuristic", "heuristic"]);
  assert.match(s.text, /this session's activity/);
  assert.match(h.text, /your recorded activity/);
  for (const o of Object.values(COPY.observations)) for (const t of [o.history, o.session]) assert.ok(!/\byou are\b|you're|personality|productive|healthy|smart/i.test(t), t);
});

test("history observations need >= 3 contributing sessions and one recorded time zone", async () => {
  const h = await hist();
  const peak = (sessions: number, byHour: number[]) => setH(h, "agg.peakHour", 22, { detail: { byHour, timeZones: ["UTC"] }, covered: { sessions, of: h.coverage.sessions } });
  const night = hours({ 22: 50 });
  assert.equal(historyStory(peak(3, night)).observation?.id, "night-owl");
  assert.equal(historyStory(peak(2, night)).observation, null, "two sessions are too few");
  const mixed = { ...peak(3, night), coverage: { ...h.coverage, timeZones: ["Asia/Kolkata", "UTC"] }, warnings: [{ code: "mixed-time-zones", count: 2 }] };
  assert.equal(historyStory(mixed).observation, null, "hours from different zones are not comparable");
  const r = (await base())[0]!;
  assert.equal(sessionStory(setS(r, "lore.peakHour", null, { detail: { timeZone: "UTC", byHour: night } })).observation?.text, COPY.observations["night-owl"].session);
});

// ---- the view, closed vocabulary, privacy, determinism ----

test("the view carries the story; hidden metrics are never shown or counted; heuristic facts are never bold", async () => {
  for (const r of await base()) {
    const v = sessionView(r), s = sessionStory(r);
    assert.deepEqual([v.opening, v.hero, v.beats, v.observation, v.consumed, v.closing], [s.opening, s.hero, s.beats, s.observation, s.consumed, s.closing]);
    for (const e of v.sections.flatMap((x) => x.entries)) assert.ok(isDisplayed(e.metricId), `${e.metricId} is hidden in v0.2.1`);
  }
  const hv = historyView(await hist());
  for (const e of hv.sections.flatMap((x) => x.entries)) assert.ok(isDisplayed(e.metricId), e.metricId);
  assert.ok(!hv.sections.flatMap((x) => x.entries).some((e) => /^agg\.(turns|commands|tests|errors|interruptions|commits|errorStreak)/.test(e.metricId)));
});

test("closed vocabulary: every flavour string in any story comes from COPY", async () => {
  const vocab = new Set<string>([
    ...Object.values(COPY.openings).flat(), ...Object.values(COPY.beats), ...COPY.closings,
    ...Object.values(COPY.observations).flatMap((o) => [o.heading, o.history, o.session]),
  ]);
  const stories = [...(await base()).map(sessionStory), ...(["all", "week", "month"] as const).map((p) => historyStory(aggregate(cache, { period: p, now: NOW, timeZone: "UTC" })))];
  for (const s of stories) {
    for (const t of [s.opening, s.closing, ...s.beats.map((b) => b.heading), ...(s.observation ? [s.observation.heading, s.observation.text] : [])]) assert.ok(vocab.has(t), `not in COPY: ${t}`);
  }
});

test("privacy: stories hold no transcript text, telemetry or session ids, paths or titles; redacted stories no project names", async () => {
  const names = readdirSync(DIR).filter((f) => f.endsWith(".jsonl"));
  const rs = (await loadSessions(names.map((n) => refForFile(join(DIR, n))))).map((s) => buildReceipt(s, { now: NOW, timeZone: "UTC" }))
    .map((r) => ({ ...r, session: { ...r.session, title: "SECRET TITLE", project: "secret-proj", projectKey: "c:\\users\\someone\\secret-proj", cwd: "C:\\Users\\someone\\secret-proj" } }));
  const telemetry = new Set(names.flatMap((n) => readFileSync(join(DIR, n), "utf8").match(/(?:msg|toolu|req)_fixture[0-9a-f]{12}|\ba[0-9a-f]{12}\b/g) ?? []));
  const texts = [
    ...rs.map((r) => JSON.stringify(sessionStory(r))), ...rs.map((r) => JSON.stringify(sessionStory(redactReceipt(r)))),
    JSON.stringify(historyStory(aggregate(rs, { period: "all", now: NOW, timeZone: "UTC" }))),
  ];
  const redacted = [...rs.map((r) => JSON.stringify(sessionStory(redactReceipt(r)))), JSON.stringify(historyStory(redactHistory(aggregate(rs, { period: "all", now: NOW, timeZone: "UTC" }))))];
  for (const t of texts) {
    for (const id of telemetry) assert.ok(!t.includes(id), `telemetry id ${id}`);
    for (const r of rs) assert.ok(!t.includes(r.session.id) || r.session.id.length < 12, "session id");
    assert.ok(!/x{3,}|SECRET TITLE|someone|Users/.test(t), "transcript text, title or path");
  }
  for (const t of redacted) assert.ok(!t.includes("secret-proj"), "redacted story shows a project name");
});

test("deterministic and pure: same input, same story; inputs never mutated; no clock or randomness", async (t) => {
  const deepFreeze = <T>(o: T): T => { if (o && typeof o === "object") { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
  const h = deepFreeze(await hist()), rs = deepFreeze(await base());
  t.mock.method(Date, "now", () => { throw new Error("clock"); });
  t.mock.method(Math, "random", () => { throw new Error("random"); });
  assert.equal(JSON.stringify(historyStory(h)), JSON.stringify(historyStory(structuredClone(h))));
  for (const r of rs) assert.equal(JSON.stringify(sessionStory(r)), JSON.stringify(sessionStory(structuredClone(r))));
  t.mock.restoreAll();
  const src = readFileSync("src/render/narrative.ts", "utf8");
  for (const [, from] of src.matchAll(/^import[^;]*?from "([^"]+)"/gm)) assert.match(from!, /^\.\.?\/(receipt\/types|aggregate\/types|format)\.ts$/, from!);
  assert.ok(!/\b(process\.|Date\.now|new Date\(|Math\.random|require\(|node:)/.test(src));
});
