// v0.2 milestone 4: history receipts as SVG and PNG, through the shared view and the existing
// visual renderer (HistoryReceipt → historyView → layoutView → toSvg → toPng).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { aggregate } from "../../src/aggregate/index.ts";
import type { HistoryReceipt } from "../../src/aggregate/types.ts";
import { validateHistory } from "../../src/aggregate/validate.ts";
import { buildReceipt } from "../../src/analytics/index.ts";
import { loadFonts } from "../../src/assets.ts";
import { redactHistory } from "../../src/receipt/redact.ts";
import type { Receipt } from "../../src/receipt/types.ts";
import { toPng } from "../../src/render/png.ts";
import { toSvg } from "../../src/render/svg.ts";
import { historyView } from "../../src/render/view.ts";
import { layoutView, type TextItem, type VisualDoc } from "../../src/render/visual/layout.ts";
import { TEXT_LEFT, TEXT_RIGHT, VISUAL } from "../../src/render/visual/spec.ts";
import { loadSessions, refForFile } from "../../src/source/claude-code/index.ts";

const DIR = join("fixtures", "claude-code", "2.1.283");
const NOW = new Date("2026-10-01T12:00:00.000Z");
const fonts = loadFonts();
const one = async (n: string) => buildReceipt((await loadSessions([refForFile(join(DIR, n))]))[0]!, { now: NOW, timeZone: "UTC" });
let baseCache: Receipt[];
const base = async () => (baseCache ??= await Promise.all(["ordinary.jsonl", "no-tools.jsonl", "killed.jsonl", "write-update-replaceall.jsonl", "resumed.jsonl"].map(one)));
const doc = (h: HistoryReceipt) => layoutView(historyView(h));
const texts = (d: VisualDoc) => d.items.filter((i): i is TextItem => i.kind === "text");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const chunks = (png: Uint8Array) => { const b = Buffer.from(png); const t: string[] = []; for (let o = 8; o < b.length; o += 12 + b.readUInt32BE(o)) t.push(b.toString("latin1", o + 4, o + 8)); return t; };
const set = (r: Receipt, id: string, value: unknown): Receipt => ({ ...r, sections: Object.fromEntries(Object.entries(r.sections).map(([k, ms]) => [k, ms.map((m) => (m.id === id ? { ...m, value } : m))])) as Receipt["sections"] });
const clone = (r: Receipt, id: string, s: Partial<Receipt["session"]> = {}, tz?: string): Receipt => ({ ...r, ...(tz ? { context: { timeZone: tz } } : {}), session: { ...r.session, id, ...s } });

// Everything drawn stays in the paper's text area, between the torn edges (as for session receipts).
function assertBounds(d: VisualDoc) {
  assert.equal(d.width, 624);
  for (const i of d.items) {
    const [x1, x2] = i.kind === "text" ? (i.anchor === "start" ? [i.x, i.x + i.width] : i.anchor === "end" ? [i.x - i.width, i.x] : [i.x - i.width / 2, i.x + i.width / 2]) : i.kind === "band" ? [i.x, i.x + i.width] : [i.x1, i.x2];
    assert.ok(x1 >= TEXT_LEFT - 1e-9 && x2 <= TEXT_RIGHT + 1e-9, `${i.kind} "${"text" in i ? i.text : ""}" x ${x1}..${x2}`);
    const [y1, y2] = i.kind === "text" ? [i.y - (i.size ?? VISUAL.type[i.role].size), i.y] : i.kind === "band" ? [i.y, i.y + i.height] : [i.y, i.y];
    assert.ok(y1 > d.paper.top + VISUAL.edge.depth && y2 < d.paper.bottom - VISUAL.edge.depth, `${i.kind} y crosses a torn edge`);
  }
}

test("history SVG: the same receipt language (title, itemized history, leaders, marks, total rule, legend), no band", async () => {
  for (const period of ["all", "week", "month"] as const) {
    const h = aggregate(await base(), { period, now: NOW, timeZone: "UTC" });
    const d = doc(h);
    assertBounds(d);
    const t = texts(d).map((x) => x.text);
    assert.deepEqual(t.slice(1, 3), ["CLAUDE RECEIPT", "itemized history"], "after the opening line");
    assert.ok(t.includes({ all: "ALL SESSIONS", week: "LAST 7 DAYS", month: "LAST 30 DAYS" }[period]));
    assert.ok(["HARD STATS", "CODING STATS", "SESSION LORE", "API EQUIVALENT", "plain    recorded directly"].every((s) => t.includes(s)));
    assert.ok(!d.items.some((i) => i.kind === "band"), "no LIVE band on a history");
    assert.equal(d.items.filter((i) => i.kind === "rule" && i.style === "double").length, 3, "header, total, footer");
    assert.ok(d.items.some((i) => i.kind === "leader"));
    const svg = toSvg(d, fonts);
    assert.ok(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="624" height="${d.height}"`));
    assert.ok(!/<!--|<title|<desc|<script|<metadata|data-[a-z]+=|href=/.test(svg));
    assert.equal((svg.match(/@font-face/g) ?? []).length, 2, "the bundled fonts, embedded as for sessions");
  }
});

test("provenance and emphasis in the image: marks by provenance, bold primaries, never a bold heuristic", async () => {
  const h = aggregate(await base(), { period: "all", now: NOW, timeZone: "UTC" });
  const byId = new Map(Object.values(h.sections).flat().map((m) => [m.id, m]));
  for (const t of texts(doc(h)).filter((x) => x.metricId && x.part === "value")) {
    const m = byId.get(t.metricId as never)!;
    assert.equal(t.mark, m.provenance === "derived" ? "*" : m.provenance === "heuristic" ? "~" : "", t.metricId!);
    assert.equal(t.text.startsWith("~"), m.provenance === "heuristic");
    if (m.provenance === "heuristic") assert.equal(t.weight, 400);
  }
  const bold = new Set(texts(doc(h)).filter((t) => t.part === "value" && t.weight === 700 && t.metricId).map((t) => t.metricId));
  assert.deepEqual([...bold].sort(), ["agg.cost.apiEquivalent", "agg.duration.wall", "agg.lines.added", "agg.lines.removed", "agg.tokens.input", "agg.tokens.output"]);
});

test("coverage in the header: live, incomplete and undated sessions, project scope; partial metrics in the footer", async () => {
  const b = await base();
  const rs = [...b, clone(b[1]!, "undated", { startedAt: null, endedAt: null }), clone(b[0]!, "live", { live: true })];
  for (const [period, undatedLabel] of [["all", "UNDATED"], ["week", "UNDATED (NOT COUNTED)"]] as const) {
    const h = aggregate(rs, { period, now: NOW, timeZone: "UTC" });
    const t = texts(doc(h)).map((x) => x.text);
    for (const s of [undatedLabel, "LIVE (NOT COUNTED)", "INCOMPLETE", "DAYS WITH DATA", "FIRST", "LAST", "PROJECTS"]) assert.ok(t.includes(s), `${period}: ${s}`);
    const partial = Object.values(h.sections).flat().filter((m) => m.value !== null && m.covered.sessions < m.covered.of);
    assert.ok(partial.length > 0);
    assert.ok(t.some((x) => x.startsWith(`based on ${partial[0]!.covered.sessions} of ${h.coverage.sessions} sessions:`)), "partial coverage stated");
  }
  const proj = aggregate(b, { period: "all", now: NOW, timeZone: "UTC", projectKey: b[0]!.session.projectKey });
  const pt = texts(doc(proj)).map((x) => x.text);
  assert.ok(pt.includes("PROJECT") && !pt.includes("PROJECTS"));
});

test("mixed recorded time zones: the image keeps the aggregate and states the caveat", async () => {
  const b = await base();
  const h = aggregate([...b, clone(b[2]!, "kolkata", { startedAt: "2026-09-30T10:00:00.000Z" }, "Asia/Kolkata")], { period: "all", now: NOW, timeZone: "UTC" });
  assert.ok(h.warnings.some((w) => w.code === "mixed-time-zones"));
  const t = texts(doc(h)).map((x) => x.text).join(" ");
  assert.match(t, /PEAK HOUR uses each session's recorded time zone/);
});

test("long and Unicode names and a long partial-coverage footer stay inside the paper; names are cut with …", async () => {
  const b = await base();
  const long = "an-extraordinarily-long-monorepo-project-name-that-keeps-going-and-going";
  const rs = [
    ...b.map((r, i) => clone(r, `s${i}`, { project: i % 2 ? "数据-pipeline-café-🚀" : long, projectKey: i % 2 ? "c:\\work\\data" : "c:\\work\\long" })),
    clone(set(set(b[0]!, "languages", [{ language: "TypeScript", lines: 1234567, files: 3 }, { language: "a-very-long-language-name-from-some-toolchain-x", lines: 500, files: 1 }, { language: "日本語ドキュメント", lines: 12, files: 1 }]), "models.used", ["claude-some-extremely-long-model-identifier-name-20991231"]), "x", { startedAt: "2026-09-29T10:00:00.000Z", project: "e\u0301\u0301-ζ", projectKey: "c:\\z" }),
    // sessions missing different metrics make many partial-coverage groups
    ...["tokens.input", "api.duration", "lore.rabbitHole", "languages", "lore.longestTurn", "models.used"].map((id, i) => clone(set(b[0]!, id, null), `p${i}`, { startedAt: `2026-09-2${i}T10:00:00.000Z` })),
  ];
  for (const h of [aggregate(rs, { period: "all", now: NOW, timeZone: "UTC" }), redactHistory(aggregate(rs, { period: "all", now: NOW, timeZone: "UTC" }))]) {
    assert.deepEqual(validateHistory(h), []);
    const d = doc(h);
    assertBounds(d);
    const t = texts(d);
    assert.ok(t.filter((x) => x.text.startsWith("based on ")).length >= 3, "several partial-coverage groups, all kept");
    const cut = t.filter((x) => x.text.endsWith("…")).map((x) => x.text);
    if (h.sections.lore.find((m) => m.id === "agg.topProjects")!.value !== null) assert.ok(cut.some((x) => x.startsWith("an-extraordinarily")), "long project cut with …");
    assert.ok(cut.some((x) => x.startsWith("a-very-long-language")) && cut.some((x) => x.startsWith("some-extremely-long-model")));
    assert.ok(t.some((x) => x.text.includes("数据") ? x.pinned === true : true), "non-ASCII runs pinned to their grid width");
  }
});

test("PNG: exactly 2× the SVG, IHDR/IDAT/IEND only, byte-identical across renders; SVG byte-identical too", async () => {
  const b = await base();
  for (const h of [aggregate(b, { period: "week", now: NOW, timeZone: "UTC" }), redactHistory(aggregate(b, { period: "all", now: NOW, timeZone: "UTC", projectKey: b[0]!.session.projectKey }))]) {
    const d = doc(h);
    const svg = toSvg(d, fonts);
    assert.equal(toSvg(doc(structuredClone(h)), fonts), svg, "SVG deterministic");
    const [p1, p2] = [await toPng(svg, fonts), await toPng(svg, fonts)];
    assert.equal(sha(p1), sha(p2), "PNG deterministic");
    const ihdr = Buffer.from(p1);
    assert.deepEqual([ihdr.readUInt32BE(16), ihdr.readUInt32BE(20)], [d.width * 2, d.height * 2]);
    assert.deepEqual([...new Set(chunks(p1))].sort(), ["IDAT", "IEND", "IHDR"]);
  }
});

test("privacy: history images hold no transcript text, telemetry ids, session ids or (redacted) project names and paths", async () => {
  const names = readdirSync(DIR).filter((f) => f.endsWith(".jsonl"));
  const rs = (await Promise.all(names.map(async (n) => (await loadSessions([refForFile(join(DIR, n))])).map((s) => buildReceipt(s, { now: NOW, timeZone: "UTC" }))))).flat()
    .map((r, i) => clone(r, `${String(i).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`, { project: "secret-proj", projectKey: "c:\\users\\someone\\secret-proj", title: "SECRET TITLE" }));
  const telemetry = new Set(names.flatMap((n) => readFileSync(join(DIR, n), "utf8").match(/(?:msg|toolu|req)_fixture[0-9a-f]{12}|\ba[0-9a-f]{12}\b/g) ?? []));
  assert.ok(telemetry.size > 10);
  for (const period of ["all", "week", "month"] as const) for (const redact of [false, true]) for (const projectKey of [null, "c:\\users\\someone\\secret-proj"]) {
    const h0 = aggregate(rs, { period, now: NOW, timeZone: "UTC", projectKey });
    const h = redact ? redactHistory(h0) : h0;
    if (h.coverage.sessions === 0) continue;
    const svg = toSvg(doc(h)); // no fonts: the scan reads only what is drawn
    for (const t of telemetry) assert.ok(!svg.includes(t), `telemetry id ${t}`);
    for (const r of rs) assert.ok(!svg.includes(r.session.id), "session id");
    assert.ok(!/x{3,}|SECRET TITLE|someone|users\\\\/.test(svg), "transcript text, title or path");
    assert.ok(!/<(command|local-command|bash|task-notification)/.test(svg));
    if (redact) assert.ok(!svg.includes("secret-proj"), `${period}: redacted project name`);
    const png = await toPng(toSvg(doc(h), fonts), fonts);
    assert.deepEqual([...new Set(chunks(png))].sort(), ["IDAT", "IEND", "IHDR"]);
  }
});

// A golden history SVG (no fonts embedded, so it stays reviewable). UPDATE_SNAPSHOTS=1 rewrites it.
test("history svg snapshot: all, from fixtures", async () => {
  const file = join("test", "render", "snapshots", "history-all.svg");
  const svg = toSvg(doc(aggregate(await base(), { period: "all", now: NOW, timeZone: "UTC" })));
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) { mkdirSync(join("test", "render", "snapshots"), { recursive: true }); writeFileSync(file, svg); }
  assert.equal(svg, readFileSync(file, "utf8"));
});
