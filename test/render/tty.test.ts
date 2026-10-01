// M3 terminal renderer: Receipt in, string out. Provenance must be visible on every metric line.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildReceipt } from "../../src/analytics/index.ts";
import { redactReceipt } from "../../src/receipt/redact.ts";
import { METRIC_IDS, METRICS, type Metric, type MetricId, type Receipt } from "../../src/receipt/types.ts";
import { validateReceipt } from "../../src/receipt/validate.ts";
import { displayWidth, isDisplayed, LABELS, LEGEND } from "../../src/render/format.ts";
import { renderJson } from "../../src/render/json.ts";
import { renderLines, renderTerminal } from "../../src/render/tty.ts";
import { loadSessions, refForFile } from "../../src/source/claude-code/index.ts";

const DIR = join("fixtures", "claude-code", "2.1.283");
const SUB = join("subagent", readdirSync(join(DIR, "subagent")).find((f) => f.endsWith(".jsonl"))!);
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).concat(SUB);
const NOW = new Date("2026-10-01T00:00:00.000Z");
const receiptOf = async (name: string) => buildReceipt((await loadSessions([refForFile(join(DIR, name))]))[0]!, { now: NOW, timeZone: "UTC" });
const all = (r: Receipt) => Object.values(r.sections).flat();
const ANSI = /\x1b\[[0-9;]*m/g;

// A receipt in which every metric has a value, so every label and mark gets exercised.
const FILL: { [K in MetricId]?: unknown } = {
  "session.duration.open": 3_600_000, "api.duration": 1_234_567, "turns.count": 7, "files.mostEdited": "C:\\p\\src\\app.ts",
  languages: [{ language: "TypeScript", lines: 120, files: 3 }], "commits.inWindow": 2, "commits.coAuthored": 1,
  "git.lines": { added: 40, removed: 3 }, "lore.rabbitHole": { promptIndex: 0, toolCalls: 12, durationMs: 90_000 },
  "lore.longestTurn": 45_000, "lore.peakHour": 17, "lore.errorStreak": 2, "lore.readEditRatio": 1.5, "lore.cacheHitRate": 0.9,
};
async function fullReceipt(): Promise<Receipt> {
  const r = await receiptOf("ordinary.jsonl");
  const fill = (m: Metric): Metric => (m.value === null && m.id in FILL ? ({ id: m.id, provenance: m.provenance, value: FILL[m.id], ...(m.unit ? { unit: m.unit } : {}), ...(m.sensitive ? { sensitive: m.sensitive } : {}) } as Metric) : m);
  const full = { ...r, sections: { hard: r.sections.hard.map(fill), coding: r.sections.coding.map(fill), lore: r.sections.lore.map(fill) } };
  assert.deepEqual(validateReceipt(full), []);
  assert.ok(all(full).every((m) => m.value !== null), "every metric has a value");
  return full;
}

// Checks every metric line's mark against the Receipt's provenance.
function assertMarks(r: Receipt, width?: number) {
  const byId = new Map(all(r).map((m) => [m.id, m]));
  const lines = renderLines(r, width ? { width } : {});
  for (const l of lines.filter((x) => x.metricId && x.value !== undefined)) {
    const m = byId.get(l.metricId as MetricId)!;
    assert.equal(l.provenance, m.provenance, `${l.metricId}: line provenance`);
    const derivedMark = l.text.endsWith(" *"), heuristicMark = l.value !== "" && l.text.includes(`~${l.value}`);
    if (m.provenance === "exact") assert.ok(!derivedMark && !heuristicMark, `${l.metricId} exact but marked: "${l.text}"`);
    if (m.provenance === "derived") assert.ok(derivedMark && !heuristicMark, `${l.metricId} derived without " *": "${l.text}"`);
    if (m.provenance === "heuristic") assert.ok(heuristicMark && !derivedMark, `${l.metricId} heuristic without "~": "${l.text}"`);
  }
  // every displayed metric with a value has at least one line; null and hidden (v0.2.1) metrics have none
  const shownIds = new Set(lines.filter((l) => l.metricId).map((l) => l.metricId));
  for (const m of all(r)) {
    const empty = m.value === null || (Array.isArray(m.value) && !m.value.length) || (m.id === "toolCalls.byName" && !Object.keys(m.value as object).length);
    assert.equal(shownIds.has(m.id), !empty && isDisplayed(m.id), `${m.id}: shown iff it has a value and is displayed`);
  }
  return lines;
}

test("provenance: every rendered metric line carries the mark of its provenance (all fixtures)", async () => {
  for (const name of FIXTURES) assertMarks(await receiptOf(name));
});

test("provenance: a receipt with every metric filled shows every label with the right mark, at every width", async () => {
  const r = await fullReceipt();
  for (const width of [40, 34, 28]) {
    const lines = assertMarks(r, width);
    for (const id of METRIC_IDS) assert.equal(lines.some((l) => l.metricId === id), isDisplayed(id), `${id} rendered at ${width} iff displayed`);
  }
  // the legend explains exactly the marks in use
  const text = renderTerminal(r);
  for (const p of ["exact", "derived", "heuristic"] as const) assert.ok(text.split("\n").includes(LEGEND[p]), p);
  const ordinaryText = renderTerminal(await receiptOf("ordinary.jsonl"));
  assert.ok(ordinaryText.split("\n").includes(LEGEND.heuristic), "heuristic legend whenever ~ is used");
});

test("heuristic metrics are worded as estimates or detections, never as recorded facts", async () => {
  const r = await fullReceipt();
  for (const m of all(r).filter((x) => x.provenance === "heuristic" && ["session.duration.active", "tests.runs", "commits.byClaude"].includes(x.id))) {
    assert.match(LABELS[m.id], /DETECTED|EST\./, m.id);
  }
  const text = renderTerminal(r);
  assert.match(text, /ACTIVE TIME \(EST\.\) \.+ ~/);
  // the two detection heuristics stay in the Receipt but are no longer printed (v0.2.1)
  assert.ok(!/TEST RUNS DETECTED|CLAUDE COMMITS DETECTED/.test(text));
});

test("null metrics are omitted, never shown as 0, and their count is stated", async () => {
  const r = await receiptOf("killed.jsonl");
  const text = renderTerminal(r);
  const nulls = all(r).filter((m) => m.value === null && isDisplayed(m.id));
  assert.ok(nulls.length > 5);
  for (const m of all(r).filter((x) => x.value === null)) assert.ok(!text.includes(`${LABELS[m.id]} `), `${m.id} should not be shown`);
  assert.match(text, new RegExp(`${nulls.length} metrics unavailable, not shown`), "the count covers displayed metrics only");
  assert.ok(!/TOKENS IN|API EQUIVALENT/.test(text), "no tokens or cost were recorded: none are shown");
});

test("deterministic and pure: same output every time, receipt not mutated, clock and system zone ignored", async () => {
  const r = await receiptOf("resumed.jsonl");
  const before = structuredClone(r);
  const a = renderTerminal(r);
  assert.equal(renderTerminal(structuredClone(r)), a);
  assert.deepEqual(r, before, "not mutated");
  const frozen = Object.freeze(structuredClone(r));
  assert.doesNotThrow(() => renderTerminal(frozen));
  const other = { ...r, context: { timeZone: "Asia/Kolkata" } };
  assert.notEqual(renderTerminal(other), a, "times follow the receipt's own time zone");
});

test("width: every line fits (40, narrow 28, too-narrow clamps to 28); values are never cut", async () => {
  const r = await fullReceipt();
  for (const [asked, max] of [[40, 40], [32, 32], [28, 28], [10, 28], [200, 40]] as const) {
    const lines = renderLines(r, { width: asked });
    for (const l of lines) assert.ok(displayWidth(l.text) <= max, `width ${asked}: "${l.text}" (${displayWidth(l.text)})`);
    for (const l of lines.filter((x) => x.value)) assert.ok(l.text.includes(l.value!), `value kept whole at ${asked}: ${l.value}`);
  }
});

test("wide characters in a project name keep the columns aligned", async () => {
  const r = await receiptOf("ordinary.jsonl");
  const wide = { ...r, session: { ...r.session, project: "設計プロジェクト" } };
  const lines = renderLines(wide).map((l) => l.text);
  const project = lines.find((l) => l.startsWith("PROJECT"))!, session = lines.find((l) => l.startsWith("SESSION"))!;
  assert.equal(displayWidth(project), displayWidth(session), "right edges line up");
  assert.ok(lines.every((l) => displayWidth(l) <= 40));
});

test("plain text by default; ANSI only when asked, and stripping it gives the plain text back", async () => {
  const r = await receiptOf("ordinary.jsonl");
  const plain = renderTerminal(r), color = renderTerminal(r, { color: true });
  assert.ok(!ANSI.test(plain));
  assert.ok(/\x1b\[/.test(color));
  assert.equal(color.replace(ANSI, ""), plain);
  for (const name of FIXTURES) assert.match(renderTerminal(await receiptOf(name)), /^[\x09\x0a\x20-\x7e]*$/, `${name}: ASCII only (Windows consoles, pipes)`);
});

test("cost is labelled API EQUIVALENT and no wording implies money was spent", async () => {
  for (const name of FIXTURES) {
    const text = renderTerminal(await receiptOf(name));
    assert.ok(!/spent|paid|charged|\bbill/i.test(text), name);
  }
  const text = renderTerminal(await receiptOf("ordinary.jsonl"));
  assert.match(text, /API EQUIVALENT \.+ \$0\.05/);
  assert.match(text, /API EQUIVALENT = these tokens at API/);
});

test("JSON stays semantic: no ANSI, no labels or microcopy, and rendering doesn't feed back into it", async () => {
  const r = await receiptOf("ordinary.jsonl");
  const json = renderJson(r);
  renderTerminal(r, { color: true });
  assert.equal(renderJson(r), json);
  assert.ok(!/\x1b/.test(json));
  for (const copy of ["HARD STATS", "API EQUIVALENT", "RABBIT HOLE", "THANK YOU", "computed from recorded", "DETECTED"]) assert.ok(!json.includes(copy), copy);
});

test("redaction: project, paths and title hidden, ids shortened, MCP tools grouped, still a valid Receipt", async () => {
  const r = await fullReceipt();
  const withMcp = { ...r, session: { ...r.session, title: "a private title" }, sections: { ...r.sections, hard: r.sections.hard.map((m) => (m.id === "toolCalls.byName" ? { ...m, value: { Bash: 2, mcp__acme__deploy: 1, mcp__acme__read: 2 } } : m)) as Metric[] } };
  const red = redactReceipt(withMcp);
  assert.deepEqual(validateReceipt(red), []);
  assert.equal(red.session.id, r.session.id.slice(0, 4));
  assert.deepEqual([red.session.project, red.session.projectKey, red.session.cwd, red.session.title], [null, null, null, null]);
  const edited = all(r).find((m) => m.id === "files.mostEdited")!.value as string;
  assert.equal(all(red).find((m) => m.id === "files.mostEdited")!.value, `*${edited.slice(edited.lastIndexOf("."))}`);
  assert.deepEqual(all(red).find((m) => m.id === "toolCalls.byName")!.value, { Bash: 2, MCP: 3 });
  assert.equal(withMcp.session.title, "a private title", "input untouched");
  const text = renderTerminal(red);
  for (const hidden of ["a private title", edited.split(/[\\/]/).pop()!, "acme", r.session.id.slice(0, 8)]) assert.ok(!text.includes(hidden), hidden);
  assert.ok(METRICS["files.mostEdited"].sensitive && METRICS["toolCalls.byName"].sensitive);
});

// Golden receipts: any change to layout or wording shows up here. UPDATE_SNAPSHOTS=1 rewrites them.
const SNAP = join("test", "render", "snapshots");
for (const name of ["ordinary.jsonl", "killed.jsonl", SUB]) {
  test(`snapshot: ${name}`, async () => {
    const file = join(SNAP, `${name.replace(/[\\/]/g, "_").replace(/\.jsonl$/, "")}.txt`);
    const text = renderTerminal(await receiptOf(name));
    if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) { mkdirSync(SNAP, { recursive: true }); writeFileSync(file, text); }
    assert.equal(text, readFileSync(file, "utf8"));
  });
}
