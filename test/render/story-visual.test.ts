// v0.2.1 stage 3: the story in the visual receipt. Hero fit (no collisions, sized by the widest value),
// no fact printed twice (hero/beat, header/hero, story/sections), beat spacing, long labels, legend
// whitespace, redaction and determinism. Layout geometry is checked on the VisualDoc; PNG on bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { aggregate } from "../../src/aggregate/index.ts";
import { buildReceipt } from "../../src/analytics/index.ts";
import { loadFonts } from "../../src/assets.ts";
import { redactHistory } from "../../src/receipt/redact.ts";
import type { Metric, Receipt } from "../../src/receipt/types.ts";
import { COPY } from "../../src/render/narrative.ts";
import { toPng } from "../../src/render/png.ts";
import { toSvg } from "../../src/render/svg.ts";
import { historyView, sessionView, type ReceiptView, type StoryFact } from "../../src/render/view.ts";
import { layoutView, type TextItem, type VisualDoc } from "../../src/render/visual/layout.ts";
import { TEXT_LEFT, TEXT_RIGHT, VISUAL } from "../../src/render/visual/spec.ts";
import { loadSessions, refForFile } from "../../src/source/claude-code/index.ts";

const DIR = join("fixtures", "claude-code", "2.1.283");
const NOW = new Date("2026-10-01T12:00:00.000Z");
const one = async (n: string) => buildReceipt((await loadSessions([refForFile(join(DIR, n))]))[0]!, { now: NOW, timeZone: "UTC" });
const set = (r: Receipt, id: string, value: unknown): Receipt => {
  const f = (m: Metric) => (m.id === id ? ({ ...m, value, unavailableReason: undefined } as Metric) : m);
  return { ...r, sections: { hard: r.sections.hard.map(f), coding: r.sections.coding.map(f), lore: r.sections.lore.map(f) } };
};
const texts = (d: VisualDoc) => d.items.filter((i): i is TextItem => i.kind === "text");
const extent = (t: TextItem) => (t.anchor === "start" ? [t.x, t.x + t.width] : t.anchor === "end" ? [t.x - t.width, t.x] : [t.x - t.width / 2, t.x + t.width / 2]) as [number, number];
const sizeOf = (t: TextItem) => t.size ?? VISUAL.type[t.role].size;
// the hero's big numbers: the display items on the first display baseline
const heroOf = (d: VisualDoc) => { const big = texts(d).filter((t) => t.role === "display" && t.part === "value"); return big.filter((t) => t.y === big[0]!.y); };
const withHero = (v: ReceiptView, hero: StoryFact[]): ReceiptView => ({ ...v, hero });
const f = (label: string, value: string, provenance: StoryFact["provenance"] = "exact", metricId?: string): StoryFact => ({ label, value, provenance, ...(metricId ? { metricId } : {}) });
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

// A long, busy session (realistic-scale values on the ordinary fixture's shape; synthetic, not real data).
async function longSession(): Promise<Receipt> {
  let r = await one("ordinary.jsonl");
  for (const [id, v] of Object.entries({
    "session.duration.wall": 12_020_000, "tokens.output": 126_465, "cost.apiEquivalent": 8.43, "lines.added": 872, "lines.removed": 8,
    "lore.rabbitHole": { promptIndex: 3, toolCalls: 60, durationMs: 1_018_000 }, "toolCalls.byName": { Bash: 38, Read: 38, Write: 11, Edit: 9 }, "lore.longestTurn": 412_000,
  })) r = set(r, id, v);
  return r;
}

// ---- hero fit ----

test("hero: numbers never collide; each stays whole with its raised *, inside the text area", async () => {
  const v = sessionView(await longSession());
  const cases: StoryFact[][] = [
    v.hero, // 3h 20m*  126,465  $8.43
    [f("DURATION", "23h 59m", "derived", "session.duration.wall"), f("TOKENS OUT", "12,345,678", "exact", "tokens.output"), f("API EQUIVALENT", "$12,345.67", "exact", "cost.apiEquivalent")],
    [f("A", "1,000,000,000,000"), f("B", "1,000,000,000,000"), f("C", "$1,234,567.89")], // too wide for one row at any size
    [f("SESSIONS", "1"), f("PROJECTS", "1"), f("IN SESSIONS", "1s", "derived", "agg.duration.wall")],
    [f("TOKENS OUT", "908", "heuristic", "tokens.output")],
  ];
  for (const hero of cases) {
    const d = layoutView(withHero(v, hero));
    const big = texts(d).filter((t) => t.role === "display");
    // pair each number with its mark: the number's ink runs from its start to the end of its mark
    const units = big.filter((t) => t.part === "value").slice(0, hero.length).map((t) => {
      const mark = big.find((m) => m.part === "mark" && m.y < t.y && m.y > t.y - sizeOf(t) && Math.abs(m.x - (t.x + t.width + 2)) < 1e-9);
      return { t, x1: t.x, x2: mark ? mark.x + mark.width : t.x + t.width, mark };
    });
    for (const [i, u] of units.entries()) {
      assert.ok(u.x1 >= TEXT_LEFT - 1e-9 && u.x2 <= TEXT_RIGHT + 1e-9, `${u.t.text} inside the text area`);
      assert.equal(!!u.mark, hero[i]!.provenance === "derived", `${u.t.text}: * attached iff derived`);
      for (const w of units.slice(i + 1)) if (w.t.y === u.t.y) assert.ok(w.x1 - u.x2 >= VISUAL.story.hero.gap - 1e-9, `${u.t.text} / ${w.t.text}: ${w.x1 - u.x2}px apart`);
    }
    // labels stay under their own number, and never touch each other
    const labels = texts(d).filter((t) => t.role === "label").slice(0, hero.length).map(extent);
    for (let i = 1; i < labels.length; i++) if (labels[i]![0] > labels[i - 1]![0]) assert.ok(labels[i]![0] > labels[i - 1]![1], "labels apart");
  }
});

test("hero: sized by its widest value: full size when it fits, only as small as needed, one size per row", async () => {
  const v = sessionView(await longSession());
  const { max, min, step } = VISUAL.story.hero;
  const short = heroOf(layoutView(withHero(v, [f("A", "21s"), f("B", "908"), f("C", "$0.05")])));
  assert.deepEqual(short.map(sizeOf), [max, max, max], "short values: full size");
  const wide = heroOf(layoutView(v)); // 3h 20m*  126,465  $8.43
  const s = sizeOf(wide[0]!);
  assert.ok(s < max && s >= min && wide.every((t) => sizeOf(t) === s), `one size for the row: ${wide.map(sizeOf)}`);
  // one step larger would not leave the minimum gaps
  const need = (size: number) => v.hero.map((x) => Math.max(
    ([...(x.provenance === "heuristic" ? `~${x.value}` : x.value)].length) * size * 0.6 + (x.provenance === "derived" ? 2 + Math.round(size * VISUAL.story.mark) * 0.6 : 0),
    x.label.length * VISUAL.type.label.size * 0.6 + VISUAL.type.label.letterSpacing * (x.label.length - 1)));
  const fits = (size: number) => (TEXT_RIGHT - TEXT_LEFT - need(size).reduce((a, b) => a + b, 0)) / v.hero.length >= VISUAL.story.hero.gap;
  assert.ok(fits(s) && !fits(s + step), "the largest size that fits");
  // nothing fits on one row: each number on its own row, never shrunk below the minimum
  const huge = layoutView(withHero(v, [f("A", "1,000,000,000,000"), f("B", "1,000,000,000,000"), f("C", "$1,234,567.89")]));
  const rows = texts(huge).filter((t) => t.role === "display" && t.part === "value").slice(0, 3);
  assert.equal(new Set(rows.map((t) => t.y)).size, 3, "stacked");
  assert.ok(rows.every((t) => sizeOf(t) >= min));
  // the hero dominates the supporting rows
  assert.ok(s > VISUAL.type.body.size * 1.5);
});

// ---- nothing twice ----

test("no hero/beat duplication: a long session leads with its duration once, without THE LONG ONE", async () => {
  const r = await longSession();
  const d = layoutView(sessionView(r));
  const t = texts(d);
  assert.ok(!t.some((x) => x.text === COPY.beats["long-one"]), "THE LONG ONE is not drawn");
  assert.equal(t.filter((x) => x.metricId === "session.duration.wall" && x.part === "value").length, 1, "duration drawn once");
  for (const id of sessionView(r).consumed) assert.equal(t.filter((x) => x.metricId === id && x.part === "value" && x.role === "body" && x.y > t.find((y) => y.text === "HARD STATS")!.y).length, 0, `${id} not repeated in sections`);
});

test("no header/hero duplication: header rows the hero shows are dropped, driven by the hero's facts", async () => {
  const rs = await Promise.all(["ordinary.jsonl", "no-tools.jsonl", "killed.jsonl"].map(one));
  const h = aggregate(rs, { period: "all", now: NOW, timeZone: "UTC" });
  const v = historyView(h);
  const labels = (d: VisualDoc) => texts(d).filter((t) => t.role === "body" && t.part !== "value").map((t) => t.text);
  const d = layoutView(v);
  assert.ok(!labels(d).includes("SESSIONS") && !labels(d).includes("PROJECTS"), "not repeated as header rows");
  assert.ok(texts(d).some((t) => t.role === "label" && t.text === "SESSIONS") && texts(d).some((t) => t.role === "label" && t.text === "PROJECTS"), "shown by the hero");
  // take SESSIONS out of the hero and its header row comes back
  const without = layoutView(withHero(v, v.hero.filter((x) => x.ref !== "coverage.sessions")));
  assert.ok(labels(without).includes("SESSIONS") && !labels(without).includes("PROJECTS"));
  // the terminal keeps its header (the story is not printed there)
  assert.ok(v.header.some((r) => r.label === "SESSIONS"));
  // a one-project receipt keeps PROJECT: the hero does not show it
  const p = layoutView(historyView(aggregate(rs, { period: "all", now: NOW, timeZone: "UTC", projectKey: rs[0]!.session.projectKey })));
  assert.ok(labels(p).includes("PROJECT"));
});

// ---- rhythm ----

test("beat spacing: about 40 px of paper above every beat heading, dashed rules beside it", async () => {
  const d = layoutView(sessionView(await longSession()));
  const headings = texts(d).filter((t) => t.role === "beat" && t.part === "heading");
  assert.ok(headings.length >= 3);
  for (const hd of headings) {
    const above = d.items.filter((i) => (i.kind === "text" ? i.y : i.y) < hd.y - VISUAL.type.beat.size);
    const prevBottom = Math.max(...above.map((i) => (i.kind === "text" ? i.y + VISUAL.font.descentEm * sizeOf(i) : i.kind === "band" ? i.y + i.height : i.y)));
    const gap = hd.y - VISUAL.font.ascentEm * VISUAL.type.beat.size - prevBottom;
    assert.ok(gap >= 28 && gap <= 48, `${hd.text}: ${gap.toFixed(1)}px above`);
    const rules = d.items.filter((i) => i.kind === "rule" && i.style === "dashed" && Math.abs(i.y - (hd.y - 6)) < 12);
    assert.equal(rules.length, 2, `${hd.text}: a dashed rule either side`);
  }
});

test("long project labels in a beat move their value to its own line; nothing leaves the text area", async () => {
  const rs = await Promise.all(["ordinary.jsonl", "no-tools.jsonl", "killed.jsonl"].map(one));
  const long = "an-extraordinarily-long-monorepo-project-name-that-keeps-going";
  const named = rs.map((r, i) => ({ ...r, session: { ...r.session, project: i ? "short" : long, projectKey: i ? "c:\\s" : "c:\\l" } }));
  const d = layoutView(historyView(aggregate(named, { period: "all", now: NOW, timeZone: "UTC" })));
  const label = texts(d).find((t) => t.metricId === "agg.topProjects" && t.part === "label" && t.text.startsWith("an-extra"))!;
  const value = texts(d).find((t) => t.metricId === "agg.topProjects" && t.part === "value" && t.y > label.y)!;
  assert.ok(label.text.endsWith("…") && value.anchor === "end", "label cut with …, value right-aligned below");
  for (const t of texts(d)) { const [x1, x2] = extent(t); assert.ok(x1 >= TEXT_LEFT - 1e-9 && x2 <= TEXT_RIGHT + 1e-9, t.text); }
  // redacted: no project beat and no names
  const red = toSvg(layoutView(historyView(redactHistory(aggregate(named, { period: "all", now: NOW, timeZone: "UTC" })))));
  assert.ok(!red.includes(COPY.beats["where-you-worked"]) && !red.includes("monorepo") && !red.includes(">short<"));
});

test("legend whitespace is preserved in the SVG (xml:space and white-space: pre)", async () => {
  const svg = toSvg(layoutView(sessionView(await longSession())));
  assert.match(svg, /^<svg [^>]*xml:space="preserve">/);
  assert.ok(svg.includes("white-space:pre"));
  for (const l of ["plain    recorded directly", "  *      computed from data"]) assert.ok(svg.includes(`>${l}</text>`), l);
});

test("observation: drawn once, after the data, marked ~ and never bold", async () => {
  let r = await longSession();
  r = { ...r, sections: { ...r.sections, lore: r.sections.lore.map((m) => (m.id === "lore.peakHour" ? ({ ...m, value: 22, detail: { timeZone: "UTC", byHour: Array.from({ length: 24 }, (_, i) => (i >= 20 ? 20 : 0)) } } as Metric) : m)) } };
  const t = texts(layoutView(sessionView(r)));
  const head = t.find((x) => x.text === "NIGHT OWL ~")!;
  assert.ok(head && head.weight === 400);
  assert.ok(head.y > t.find((x) => x.text === "SESSION LORE")!.y);
  assert.ok(t.some((x) => x.text.startsWith("Most of this session's activity") && x.role === "small"));
});

// ---- determinism ----

test("determinism: the story receipts render to identical SVG and PNG bytes every time", async () => {
  const fonts = loadFonts();
  const rs = await Promise.all(["ordinary.jsonl", "no-tools.jsonl", "killed.jsonl"].map(one));
  const h = aggregate(rs, { period: "all", now: NOW, timeZone: "UTC" });
  for (const view of [() => sessionView(rs[0]!), async () => sessionView(await longSession()), () => historyView(h), () => historyView(redactHistory(h))]) {
    const [a, b] = [toSvg(layoutView(await view()), fonts), toSvg(layoutView(await view()), fonts)];
    assert.equal(a, b);
    assert.equal(sha(await toPng(a, fonts)), sha(await toPng(b, fonts)));
  }
});

// ---- goldens (no fonts embedded, so they stay reviewable). UPDATE_SNAPSHOTS=1 rewrites them. ----

const SNAP = join("test", "render", "snapshots");
const golden = (name: string, make: () => Promise<VisualDoc>) => test(`story svg snapshot: ${name}`, async () => {
  const file = join(SNAP, `story-${name}.svg`), svg = toSvg(await make());
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) writeFileSync(file, svg);
  assert.equal(svg, readFileSync(file, "utf8"));
});
async function spread(): Promise<Receipt[]> {
  const rs = await Promise.all(["ordinary.jsonl", "no-tools.jsonl", "killed.jsonl", "write-update-replaceall.jsonl", "resumed.jsonl"].map(one));
  return rs.flatMap((r, i) => [0, 1, 2].map((d) => ({ ...r, session: { ...r.session, id: `${r.session.id}-${d}`, startedAt: new Date(Date.parse("2026-09-25T09:00:00Z") + (i + d * 2) * 43_200_000).toISOString(), project: ["nucleus", "receipt-lab"][i % 2]!, projectKey: ["c:\nucleus", "c:\receipt-lab"][i % 2]! } })));
}
golden("long-session", async () => layoutView(sessionView(await longSession())));
golden("unicode-session", async () => { const r = await longSession(); return layoutView(sessionView({ ...r, session: { ...r.session, project: "数据-café-ζ", title: "Ünïcödé — 日本語 title ✓" } })); });
golden("history", async () => layoutView(historyView(aggregate(await spread(), { period: "all", now: NOW, timeZone: "UTC" }))));
golden("history-redacted", async () => layoutView(historyView(redactHistory(aggregate(await spread(), { period: "all", now: NOW, timeZone: "UTC" })))));
golden("history-long-partial", async () => {
  const s = await spread();
  const rs = [
    ...s.map((r, i) => ({ ...r, session: { ...r.session, project: i % 3 ? "数据-pipeline-café" : "an-extraordinarily-long-monorepo-project-name-that-keeps-going", projectKey: i % 3 ? "c:\data" : "c:\long" } })),
    set(s[1]!, "tokens.input", null), { ...s[2]!, session: { ...s[2]!.session, id: "undated", startedAt: null, endedAt: null } },
    { ...s[3]!, session: { ...s[3]!.session, id: "live", live: true } },
  ];
  return layoutView(historyView(aggregate(rs, { period: "all", now: NOW, timeZone: "UTC" })));
});
