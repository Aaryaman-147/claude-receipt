// Visual receipt, SVG stage: Receipt → VisualDoc (layout) → SVG string. Provenance is checked on the
// layout model itself; geometry, determinism, purity and privacy on both layout and SVG.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildReceipt } from "../../src/analytics/index.ts";
import { loadFonts } from "../../src/assets.ts";
import { redactReceipt } from "../../src/receipt/redact.ts";
import type { Metric, MetricId, Receipt } from "../../src/receipt/types.ts";
import { validateReceipt } from "../../src/receipt/validate.ts";
import { displayWidth, LEGEND, LIVE_BAND } from "../../src/render/format.ts";
import { renderTerminal } from "../../src/render/tty.ts";
import { toSvg } from "../../src/render/svg.ts";
import { layoutReceipt, type TextItem, type VisualDoc } from "../../src/render/visual/layout.ts";
import { TEXT_LEFT, TEXT_RIGHT, VISUAL } from "../../src/render/visual/spec.ts";
import { loadSessions, refForFile } from "../../src/source/claude-code/index.ts";

const DIR = join("fixtures", "claude-code", "2.1.283");
const SUB = join("subagent", readdirSync(join(DIR, "subagent")).find((f) => f.endsWith(".jsonl"))!);
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).concat(SUB);
const NOW = new Date("2026-10-01T00:00:00.000Z");
const receiptOf = async (name: string) => buildReceipt((await loadSessions([refForFile(join(DIR, name))]))[0]!, { now: NOW, timeZone: "UTC" });
const all = (r: Receipt) => Object.values(r.sections).flat();
const texts = (d: VisualDoc) => d.items.filter((i): i is TextItem => i.kind === "text");
const mapMetrics = (r: Receipt, f: (m: Metric) => Metric): Receipt => ({ ...r, sections: { hard: r.sections.hard.map(f), coding: r.sections.coding.map(f), lore: r.sections.lore.map(f) } });
const withValue = (r: Receipt, id: MetricId, value: unknown) => mapMetrics(r, (m) => (m.id === id ? ({ ...m, value } as Metric) : m));
const fonts = loadFonts();

const FILL: { [K in MetricId]?: unknown } = {
  "session.duration.open": 3_600_000, "api.duration": 1_234_567, "turns.count": 7, "files.mostEdited": "C:\\p\\src\\app.ts",
  languages: [{ language: "TypeScript", lines: 120, files: 3 }], "commits.inWindow": 2, "commits.coAuthored": 1,
  "git.lines": { added: 40, removed: 3 }, "lore.rabbitHole": { promptIndex: 0, toolCalls: 12, durationMs: 90_000 },
  "lore.longestTurn": 45_000, "lore.peakHour": 17, "lore.errorStreak": 2, "lore.readEditRatio": 1.5, "lore.cacheHitRate": 0.9,
};
async function fullReceipt(): Promise<Receipt> {
  const full = mapMetrics(await receiptOf("ordinary.jsonl"), (m) => (m.value === null && m.id in FILL ? ({ id: m.id, provenance: m.provenance, value: FILL[m.id], ...(m.unit ? { unit: m.unit } : {}), ...(m.sensitive ? { sensitive: m.sensitive } : {}) } as Metric) : m));
  assert.deepEqual(validateReceipt(full), []);
  assert.ok(all(full).every((m) => m.value !== null));
  return full;
}
const shownIn = (m: Metric) => m.value !== null && (!Array.isArray(m.value) || m.value.length > 0) && !(m.id === "toolCalls.byName" && !Object.keys(m.value as object).length);

// Every metric's value items carry its id, provenance and the mark of that provenance; marks appear nowhere else.
function assertProvenance(r: Receipt) {
  const doc = layoutReceipt(r);
  const byId = new Map(all(r).map((m) => [m.id, m]));
  const tagged = texts(doc).filter((t) => t.metricId);
  for (const t of tagged) {
    const m = byId.get(t.metricId as MetricId)!;
    assert.equal(t.provenance, m.provenance, `${t.metricId}: provenance carried`);
    if (t.part === "value") {
      const want = m.provenance === "derived" ? "*" : m.provenance === "heuristic" ? "~" : "";
      assert.equal(t.mark, want, `${t.metricId}: mark`);
      assert.equal(t.text.startsWith("~"), m.provenance === "heuristic", `${t.metricId}: "~" iff heuristic: "${t.text}"`);
      const markItem = tagged.find((x) => x.part === "mark" && x.y === t.y && x.metricId === t.metricId);
      assert.equal(!!markItem, m.provenance === "derived", `${t.metricId}: "*" iff derived`);
      if (markItem) { assert.equal(markItem.text, "*"); assert.equal(markItem.weight, t.weight, "mark has its value's weight"); assert.equal(markItem.ink, t.ink); }
      if (m.provenance === "heuristic") assert.equal(t.weight, 400, `${t.metricId}: heuristic is never bold`);
    }
  }
  // every shown metric has a value or heading item; no unavailable metric has any
  const ids = new Set(tagged.map((t) => t.metricId));
  for (const m of all(r)) assert.equal(ids.has(m.id), shownIn(m), `${m.id}: drawn iff it has a value`);
  // the legend lists exactly the marks in use
  const used = new Set(all(r).filter(shownIn).map((m) => m.provenance));
  for (const p of ["exact", "derived", "heuristic"] as const) assert.equal(texts(doc).some((t) => t.text === LEGEND[p]), used.has(p), `legend ${p}`);
  return doc;
}

// Everything drawn lies inside the paper's text area, between the torn edges.
function assertBounds(doc: VisualDoc) {
  const { top, bottom } = doc.paper, d = VISUAL.edge.depth;
  assert.equal(doc.width, 624);
  assert.equal(doc.paper.width, 576);
  assert.equal(doc.height, bottom + VISUAL.canvas.gutter);
  for (const i of doc.items) {
    const [x1, x2] = i.kind === "text" ? (i.anchor === "start" ? [i.x, i.x + i.width] : i.anchor === "end" ? [i.x - i.width, i.x] : [i.x - i.width / 2, i.x + i.width / 2])
      : i.kind === "band" ? [i.x, i.x + i.width] : [i.x1, i.x2];
    assert.ok(x1 >= TEXT_LEFT - 1e-9 && x2 <= TEXT_RIGHT + 1e-9 && x1 <= x2, `${i.kind} "${"text" in i ? i.text : ""}" x ${x1}..${x2} outside text area`);
    const [y1, y2] = i.kind === "text" ? [i.y - VISUAL.type[i.role].size, i.y] : i.kind === "band" ? [i.y, i.y + i.height] : [i.y, i.y];
    assert.ok(y1 > top + d && y2 < bottom - d, `${i.kind} y ${y1}..${y2} crosses a torn edge`);
  }
}

// ---- provenance ----

test("provenance: each metric's layout items carry its id, provenance and mark (all fixtures)", async () => {
  for (const n of FIXTURES) assertProvenance(await receiptOf(n));
});

test("provenance: a receipt with every metric populated, including redacted and live", async () => {
  const full = await fullReceipt();
  for (const r of [full, redactReceipt(full), { ...full, session: { ...full.session, live: true } }]) assertProvenance(r);
  const doc = layoutReceipt(full);
  const provs = new Set(texts(doc).filter((t) => t.part === "value" && t.metricId).map((t) => t.provenance));
  assert.deepEqual([...provs].sort(), ["derived", "exact", "heuristic"]);
});

test("provenance: the same value is drawn exact, derived or heuristic as the Receipt says", async () => {
  const base = await fullReceipt();
  for (const p of ["exact", "derived", "heuristic"] as const) {
    const r = mapMetrics(base, (m) => (m.id === "tokens.input" ? { ...m, provenance: p } as Metric : m));
    const v = texts(assertProvenance(r)).find((t) => t.metricId === "tokens.input" && t.part === "value")!;
    assert.equal(v.text, p === "heuristic" ? "~42" : "42");
    assert.equal(v.weight, p === "heuristic" ? 400 : 700, "primary value bold unless heuristic");
  }
});

test("unavailable metrics: never drawn as 0, counted once in the footer", async () => {
  const r = await receiptOf("no-tools.jsonl");
  const nulls = all(r).filter((m) => m.value === null);
  assert.ok(nulls.length > 0);
  const doc = assertProvenance(r);
  for (const m of nulls) assert.ok(!texts(doc).some((t) => t.metricId === m.id), `${m.id} drawn`);
  assert.ok(texts(doc).some((t) => t.text === `${nulls.length} metrics unavailable, not shown`));
  const allNull = mapMetrics(r, (m) => ({ ...m, value: null } as Metric));
  const d2 = layoutReceipt(allNull);
  assert.ok(!texts(d2).some((t) => t.metricId), "nothing metric-shaped drawn");
  assert.ok(!texts(d2).some((t) => /^(HARD|CODING) STATS|^SESSION LORE/.test(t.text)), "empty sections omitted");
  assert.ok(!texts(d2).some((t) => t.text.includes("API EQUIVALENT =")), "no cost note without a cost");
  assertBounds(d2);
});

// ---- structure and emphasis ----

test("structure: header, identity, sections and footer in the documented order", async () => {
  const r = { ...(await fullReceipt()), session: { ...(await fullReceipt()).session, live: true, title: "fixture title" } };
  const order = texts(layoutReceipt(r)).map((t) => t.text);
  const at = (s: string) => { const i = order.findIndex((t) => t === s || t.startsWith(s)); assert.ok(i >= 0, `missing ${s}`); return i; };
  const seq = ["CLAUDE RECEIPT", "itemized session record", "SESSION", "PROJECT", "STATUS", "\"fixture title\"", LIVE_BAND, "HARD STATS", "DURATION", "API EQUIVALENT", "CODING STATS", "SESSION LORE", "plain    recorded directly", "API EQUIVALENT = ", "times: UTC"];
  const idx = seq.map(at);
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), "order");
  // metrics keep Receipt order
  const drawn = [...new Set(texts(layoutReceipt(r)).filter((t) => t.metricId).map((t) => t.metricId))];
  assert.deepEqual(drawn, all(r).map((m) => m.id));
});

test("emphasis: only the documented primary values are bold; API EQUIVALENT gets the short total rule", async () => {
  const doc = layoutReceipt(await fullReceipt());
  const bold = new Set(texts(doc).filter((t) => t.part === "value" && t.weight === 700).map((t) => t.metricId));
  assert.deepEqual([...bold].sort(), ["cost.apiEquivalent", "lines.added", "lines.removed", "session.duration.wall", "tokens.input", "tokens.output"]);
  const cost = texts(doc).find((t) => t.metricId === "cost.apiEquivalent" && t.part === "value")!;
  const rules = doc.items.filter((i) => i.kind === "rule" && i.style === "double");
  const total = rules.find((i) => i.kind === "rule" && i.y < cost.y && cost.y - i.y < 40)!;
  assert.ok(total && total.kind === "rule" && total.x1 > TEXT_LEFT && total.x2 === TEXT_RIGHT, "short double rule right above the cost");
  assert.equal(rules.length, 3, "header, total, footer");
});

test("live: the band sits under the identity block and STATUS stays LIVE", async () => {
  const base = await receiptOf("ordinary.jsonl");
  const doc = layoutReceipt({ ...base, session: { ...base.session, live: true } });
  const band = doc.items.find((i) => i.kind === "band")!;
  const label = texts(doc).find((t) => t.text === LIVE_BAND)!;
  assert.ok(band && band.kind === "band" && label.ink === "paper" && label.y > band.y && label.y < band.y + band.height);
  const status = texts(doc).findIndex((t) => t.text === "STATUS");
  assert.equal(texts(doc)[status + 1]!.text, "LIVE");
  assert.ok(texts(doc)[status]!.y < band.y && band.y < texts(doc).find((t) => t.text === "HARD STATS")!.y);
  assert.ok(!layoutReceipt(base).items.some((i) => i.kind === "band"));
  assertBounds(doc);
});

// ---- geometry, width, long values ----

test("geometry: every item stays inside the paper for every fixture; height grows with content", async () => {
  for (const n of FIXTURES) assertBounds(layoutReceipt(await receiptOf(n)));
  const r = await receiptOf("ordinary.jsonl");
  const h = (x: Receipt) => layoutReceipt(x).height;
  assert.ok(h(await fullReceipt()) > h(r));
  assert.ok(h({ ...r, session: { ...r.session, title: "t" } }) > h(r));
});

test("torn edges: whole 12 px teeth, 6 px deep, straight sides, identical every time", async () => {
  const doc = layoutReceipt(await receiptOf("ordinary.jsonl"));
  const { outline, x, width, top, bottom } = doc.paper;
  assert.deepEqual(outline, layoutReceipt(await receiptOf("ordinary.jsonl")).paper.outline);
  const half = outline.length / 2;
  const upper = outline.slice(0, half), lower = outline.slice(half);
  assert.equal(upper.length, width / VISUAL.edge.tooth + 1);
  for (const [i, [px, py]] of upper.entries()) { assert.equal(px, x + i * 12); assert.equal(py, i % 2 ? top + 6 : top); }
  for (const [px, py] of lower) assert.ok(py === bottom || py === bottom - 6);
  assert.equal(upper.at(-1)![0], x + width, "right side straight");
  assert.equal(lower.at(-1)![0], x, "closes on the left side");
  assert.ok(outline.every(([px, py]) => px >= x && px <= x + width && py >= top && py <= bottom));
});

test("long and wide values: cut with … or moved to their own line, never past the text area", async () => {
  const full = await fullReceipt();
  const long = "a".repeat(200), wide = "数据".repeat(40), combining = "e\u0301".repeat(60), emoji = "🚀".repeat(30);
  for (const name of [long, wide, combining, emoji, `${wide}${emoji}`]) {
    const r = withValue({ ...full, session: { ...full.session, project: name, title: `${name} ${name} ${name} ${name}` } }, "files.mostEdited", `src/${name}.tsx`);
    const doc = layoutReceipt(r);
    assertBounds(doc);
    assertProvenance(r);
    for (const t of texts(doc).filter((x) => x.role !== "title")) assert.ok(displayWidth(t.text) <= (t.role === "small" ? 56 : VISUAL.grid.columns), `"${t.text.slice(0, 20)}" is ${displayWidth(t.text)} columns`);
    const title = texts(doc).filter((t) => t.text.startsWith("\"") || (t.y > texts(doc).find((x) => x.text === "STATUS")!.y && t.y < texts(doc).find((x) => x.text === "HARD STATS")!.y));
    assert.ok(title.length <= VISUAL.titleMaxLines, "title at most 3 lines");
  }
  // huge numbers keep separators and move to their own right-aligned line when they don't fit
  const big = withValue(withValue(full, "tokens.input", 1e15), "cost.apiEquivalent", 1234567.891);
  const doc = layoutReceipt(big);
  assertBounds(doc);
  const cost = texts(doc).find((t) => t.metricId === "cost.apiEquivalent" && t.part === "value")!;
  assert.equal(cost.text, "$1,234,567.89");
  const tokens = texts(doc).find((t) => t.metricId === "tokens.input" && t.part === "value")!;
  assert.equal(tokens.text, "1,000,000,000,000,000");
  const longLabel = withValue(full, "files.mostEdited", `C:\\src\\${"x".repeat(80)}.ts`);
  const d2 = layoutReceipt(longLabel);
  const label = texts(d2).find((t) => t.metricId === "files.mostEdited" && t.part === "label")!;
  const value = texts(d2).find((t) => t.metricId === "files.mostEdited" && t.part === "value")!;
  assert.ok(value.y > label.y && value.anchor === "end" && value.text.endsWith("…"), "own right-aligned line, cut with …");
  assertBounds(d2);
});

test("user strings outside printable ASCII are pinned to their grid width (textLength); ASCII runs are not", async () => {
  const full = await fullReceipt();
  const doc = layoutReceipt({ ...full, session: { ...full.session, project: "数据-café" } });
  const p = texts(doc).find((t) => t.text === "数据-café")!;
  assert.equal(p.width, displayWidth("数据-café") * 12);
  assert.ok(p.pinned);
  assert.ok(toSvg(doc).includes(`textLength="${p.width}" lengthAdjust="spacingAndGlyphs">数据-café</text>`));
  assert.ok(!texts(doc).find((t) => t.text === "SESSION")!.pinned);
});

// ---- SVG ----

test("svg: well-formed, self-contained, real text, only drawn content", async () => {
  const doc = layoutReceipt(await fullReceipt());
  const svg = toSvg(doc, fonts);
  assert.ok(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="624" height="${doc.height}" viewBox="0 0 624 ${doc.height}"`));
  assert.ok(svg.endsWith("</svg>\n"));
  // balanced tags
  const stack: string[] = [];
  for (const [, close, name, self] of svg.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
    if (self) continue;
    if (close) assert.equal(stack.pop(), name); else stack.push(name!);
  }
  assert.deepEqual(stack, []);
  assert.deepEqual([...new Set([...svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]))].sort(), ["defs", "feDropShadow", "filter", "line", "path", "rect", "style", "svg", "text"]);
  assert.ok(!/<!--|<title|<desc|<script|<metadata|<foreignObject|<image|data-[a-z]+=|href=|visibility|display="none"|opacity="0"/.test(svg));
  assert.ok(!/https?:\/\/(?!www\.w3\.org\/2000\/svg")/.test(svg), "no external references");
  // every text item appears as text, escaped
  for (const t of texts(doc)) assert.ok(svg.includes(`>${t.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>`), t.text);
  assert.ok(svg.includes(`fill="${VISUAL.canvas.backdrop}"`) && svg.includes(`fill="${VISUAL.paper.fill}"`));
});

test("svg: embeds the bundled IBM Plex Mono Regular and Bold byte-for-byte, unmodified", async () => {
  const svg = toSvg(layoutReceipt(await receiptOf("ordinary.jsonl")), fonts);
  const faces = [...svg.matchAll(/@font-face\{font-family:"IBM Plex Mono";font-weight:(\d+);src:url\(data:font\/ttf;base64,([A-Za-z0-9+/=]+)\) format\("truetype"\)\}/g)];
  assert.deepEqual(faces.map((f) => f[1]), ["400", "700"]);
  assert.ok(Buffer.from(faces[0]![2]!, "base64").equals(Buffer.from(fonts.regular)));
  assert.ok(Buffer.from(faces[1]![2]!, "base64").equals(Buffer.from(fonts.bold)));
  // the bundled files are IBM's release files (IBM/plex @ibm/plex-mono@2.5.0, fonts/complete/ttf)
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  assert.equal(sha(fonts.regular), "7c6fbddca4b700be918f5f6183d9bd4464fa427fe435f0b480d77fe2bb8c5a43");
  assert.equal(sha(fonts.bold), "74e5eedcfa4596497d34e19023cabdabd3a8c852b903007a5654a59591a72ffb");
  assert.ok(readFileSync(join("assets", "fonts", "IBMPlexMono-LICENSE.txt"), "utf8").includes("SIL Open Font License, Version 1.1"));
  // the grid's metrics are the font's: 600/1000 advance for every glyph
  for (const b of [fonts.regular, fonts.bold]) {
    const buf = Buffer.from(b), n = buf.readUInt16BE(4);
    const table = (tag: string) => { for (let i = 0; i < n; i++) if (buf.toString("latin1", 12 + i * 16, 16 + i * 16) === tag) return buf.readUInt32BE(12 + i * 16 + 8); throw new Error(tag); };
    const hhea = table("hhea"), hmtx = table("hmtx");
    assert.equal(buf.readUInt16BE(table("head") + 18), 1000);
    assert.equal(buf.readInt16BE(hhea + 4) / 1000, VISUAL.font.ascentEm);
    assert.equal(-buf.readInt16BE(hhea + 6) / 1000, VISUAL.font.descentEm);
    const advances = new Set(Array.from({ length: buf.readUInt16BE(hhea + 34) }, (_, i) => buf.readUInt16BE(hmtx + i * 4)));
    assert.deepEqual([...advances].filter((a) => a !== 0), [VISUAL.font.advanceEm * 1000]);
  }
});

test("svg: escapes markup in user strings", async () => {
  const full = await fullReceipt();
  const svg = toSvg(layoutReceipt({ ...full, session: { ...full.session, project: "<b>&\"x\"</b>" } }));
  assert.ok(svg.includes(">&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;</text>"));
  assert.ok(!svg.includes("<b>"));
});

// ---- determinism and purity ----

test("determinism: byte-identical SVG regardless of clock, randomness or system time zone", async (t) => {
  const r = await fullReceipt();
  const a = toSvg(layoutReceipt(r), fonts);
  t.mock.method(Date, "now", () => { throw new Error("clock read"); });
  t.mock.method(Math, "random", () => { throw new Error("random read"); });
  const b = toSvg(layoutReceipt(structuredClone(r)), fonts);
  t.mock.restoreAll();
  assert.equal(a, b);
  assert.equal(toSvg(layoutReceipt({ ...r, generatedAt: "1999-01-01T00:00:00.000Z" }), fonts), a, "generatedAt is never drawn");
  // another process in another system time zone
  const hash = (tz: string) => spawnSync(process.execPath, ["-e", `
    const { readFileSync } = require("node:fs");
    Promise.all([import("./src/render/visual/layout.ts"), import("./src/render/svg.ts")]).then(([l, s]) => {
      const r = JSON.parse(readFileSync(0, "utf8"));
      process.stdout.write(require("node:crypto").createHash("sha256").update(s.toSvg(l.layoutReceipt(r))).digest("hex"));
    });`], { input: JSON.stringify(r), env: { ...process.env, TZ: tz }, encoding: "utf8" });
  const local = createHash("sha256").update(toSvg(layoutReceipt(r))).digest("hex");
  for (const tz of ["Pacific/Kiritimati", "America/St_Johns"]) { const out = hash(tz); assert.equal(out.stdout, local, out.stderr); }
});

test("purity: the Receipt is not mutated; layout and SVG modules import no I/O", async () => {
  const deepFreeze = <T>(o: T): T => { if (o && typeof o === "object") { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
  const r = await fullReceipt();
  const before = JSON.stringify(r);
  toSvg(layoutReceipt(deepFreeze({ ...r, session: { ...r.session, live: true } })), fonts);
  toSvg(layoutReceipt(deepFreeze(r)), fonts);
  assert.equal(JSON.stringify(r), before);
  for (const f of ["src/render/visual/layout.ts", "src/render/visual/spec.ts", "src/render/svg.ts", "src/render/format.ts", "src/render/view.ts"]) {
    const imports = [...readFileSync(f, "utf8").matchAll(/^import[^;]*?from "([^"]+)"/gm)].map((m) => m[1]);
    for (const i of imports) assert.match(i!, /^\.\.?\/(\.\.\/receipt\/types|receipt\/types|format|view|spec|visual\/layout|visual\/spec|layout)\.ts$/, `${f} imports ${i}`);
    assert.ok(!/\b(process\.|Date\.now|new Date\(\)|Math\.random|require\()/.test(readFileSync(f, "utf8")), `${f}: ambient input`);
  }
});

test("terminal receipt is untouched by the shared-formatting move (snapshots also pin it)", async () => {
  const r = await receiptOf("ordinary.jsonl");
  assert.equal(renderTerminal(r), readFileSync(join("test", "render", "snapshots", "ordinary.txt"), "utf8"));
});

// ---- privacy ----

const ID_TOKEN = /(?<![A-Za-z0-9.])(?:(?:msg|toolu|req|srvtoolu)_[A-Za-z0-9]+|a[0-9a-f]{12})(?![A-Za-z0-9])/g;
const RAW_FIELDS = /\b(content|thinking|stdout|stderr|structuredPatch|requestId|agentId|toolUseResult|parentUuid|isSidechain|tool_use_id|sourceFingerprint)\b/;
const COPY_BANNED = /\b(spent|paid|charged|bill)\b/i;
const withoutFonts = (svg: string) => svg.replace(/@font-face\{[^}]*\}/g, "");

test("privacy: SVGs of every fixture, raw and redacted, hold no transcript text, telemetry ids or raw field names", async () => {
  const fixtureIds = new Set<string>();
  for (const n of FIXTURES) for (const t of readFileSync(join(DIR, n), "utf8").match(ID_TOKEN) ?? []) fixtureIds.add(t);
  assert.ok(fixtureIds.size > 10, "fixtures do contain (fake) ids to leak");
  for (const n of FIXTURES) {
    const r = await receiptOf(n);
    for (const svg of [toSvg(layoutReceipt(r), fonts), toSvg(layoutReceipt(redactReceipt(r)), fonts)].map(withoutFonts)) {
      assert.ok(!/x{3,}/.test(svg), `${n}: placeholder transcript text`);
      assert.ok(!/<(command|local-command|bash|task-notification|system-reminder)/.test(svg), `${n}: transcript tag`);
      assert.ok(!RAW_FIELDS.test(svg), `${n}: raw field name ${svg.match(RAW_FIELDS)?.[0]}`);
      assert.deepEqual((svg.match(ID_TOKEN) ?? []).filter((t) => fixtureIds.has(t)), [], `${n}: telemetry id`);
      assert.ok(!COPY_BANNED.test(svg), `${n}: cost copy`);
      if (all(r).some((m) => m.id === "cost.apiEquivalent" && m.value !== null)) assert.ok(svg.includes(">API EQUIVALENT</text>"));
    }
  }
});

test("privacy: a redacted Receipt's SVG has no project, path, title, full session id or file base name", async () => {
  const full = await fullReceipt();
  const r = { ...withValue(full, "files.mostEdited", "C:\\secret\\app.ts"), session: { ...full.session, project: "secret-proj", title: "secret title words", cwd: "C:\\secret\\dir" } };
  const plain = withoutFonts(toSvg(layoutReceipt(r)));
  assert.ok(plain.includes("secret-proj") && plain.includes("secret title") && plain.includes("app.ts"), "unredacted shows them");
  const svg = withoutFonts(toSvg(layoutReceipt(redactReceipt(r)), fonts));
  for (const s of ["secret", "proj", "app.ts", ">app<", "\\", "C:", r.session.id, r.session.id.slice(0, 5), "PROJECT"]) assert.ok(!svg.includes(s), `leaked ${s}`);
  assert.ok(svg.includes(`>${r.session.id.slice(0, 4)}</text>`) && svg.includes(">*.ts</text>"));
});

// ---- golden SVGs (no fonts embedded, so they stay reviewable) ----

const SNAP = join("test", "render", "snapshots");
for (const name of ["ordinary.jsonl", "no-tools.jsonl", SUB]) {
  test(`svg snapshot: ${name}`, async () => {
    const file = join(SNAP, `${name.replace(/[\\/]/g, "_").replace(/\.jsonl$/, "")}.svg`);
    const svg = toSvg(layoutReceipt(await receiptOf(name)));
    if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) { mkdirSync(SNAP, { recursive: true }); writeFileSync(file, svg); }
    assert.equal(svg, readFileSync(file, "utf8"));
  });
}
