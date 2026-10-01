// Visual receipt, PNG stage: the canonical SVG rasterized by resvg at 2×. Checked on decoded pixels
// against the layout model (so drift, clipping or a font swap shows up), plus chunks and determinism.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { buildReceipt } from "../../src/analytics/index.ts";
import { loadFonts } from "../../src/assets.ts";
import { redactReceipt } from "../../src/receipt/redact.ts";
import type { Metric, MetricId, Receipt } from "../../src/receipt/types.ts";
import { toPng } from "../../src/render/png.ts";
import { toSvg } from "../../src/render/svg.ts";
import { layoutReceipt, type TextItem, type VisualDoc } from "../../src/render/visual/layout.ts";
import { TEXT_LEFT, TEXT_RIGHT, VISUAL } from "../../src/render/visual/spec.ts";
import { loadSessions, refForFile } from "../../src/source/claude-code/index.ts";

const DIR = join("fixtures", "claude-code", "2.1.283");
const SUB = join("subagent", readdirSync(join(DIR, "subagent")).find((f) => f.endsWith(".jsonl"))!);
const NOW = new Date("2026-10-01T00:00:00.000Z");
const receiptOf = async (name: string) => buildReceipt((await loadSessions([refForFile(join(DIR, name))]))[0]!, { now: NOW, timeZone: "UTC" });
const fonts = loadFonts();
const S = VISUAL.pngScale;
const texts = (d: VisualDoc) => d.items.filter((i): i is TextItem => i.kind === "text");
const mapMetrics = (r: Receipt, f: (m: Metric) => Metric): Receipt => ({ ...r, sections: { hard: r.sections.hard.map(f), coding: r.sections.coding.map(f), lore: r.sections.lore.map(f) } });
const FILL: { [K in MetricId]?: unknown } = {
  "session.duration.open": 3_600_000, "api.duration": 1_234_567, "turns.count": 7, "files.mostEdited": "C:\\p\\src\\app.ts",
  languages: [{ language: "TypeScript", lines: 120, files: 3 }], "commits.inWindow": 2, "commits.coAuthored": 1,
  "git.lines": { added: 40, removed: 3 }, "lore.rabbitHole": { promptIndex: 0, toolCalls: 12, durationMs: 90_000 },
  "lore.longestTurn": 45_000, "lore.peakHour": 17, "lore.errorStreak": 2, "lore.readEditRatio": 1.5, "lore.cacheHitRate": 0.9,
};
const fullReceipt = async () => mapMetrics(await receiptOf("ordinary.jsonl"), (m) => (m.value === null && m.id in FILL
  ? ({ id: m.id, provenance: m.provenance, value: FILL[m.id], ...(m.unit ? { unit: m.unit } : {}) } as Metric) : m));

// ---- a minimal PNG reader (stdlib zlib): chunks and RGBA pixels ----
interface Chunk { type: string; data: Buffer }
function chunks(png: Uint8Array): Chunk[] {
  const b = Buffer.from(png);
  assert.ok(b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "PNG signature");
  const out: Chunk[] = [];
  for (let o = 8; o < b.length;) { const len = b.readUInt32BE(o); out.push({ type: b.toString("latin1", o + 4, o + 8), data: b.subarray(o + 8, o + 8 + len) }); o += 12 + len; }
  return out;
}
interface Image { width: number; height: number; lum(x: number, y: number): number }
function decode(png: Uint8Array): Image {
  const cs = chunks(png), ihdr = cs[0]!.data;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  assert.deepEqual([ihdr[8], ihdr[9], ihdr[12]], [8, 6, 0], "8-bit RGBA, not interlaced");
  const raw = inflateSync(Buffer.concat(cs.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const stride = width * 4, px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!, row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? px[y * stride + i - 4]! : 0, up = y ? px[(y - 1) * stride + i]! : 0, ul = y && i >= 4 ? px[(y - 1) * stride + i - 4]! : 0;
      const p = a + up - ul, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
      px[y * stride + i] = (row[i]! + pred) & 0xff;
    }
  }
  return { width, height, lum: (x, y) => { const o = y * stride + x * 4; return 0.299 * px[o]! + 0.587 * px[o + 1]! + 0.114 * px[o + 2]!; } };
}
const INK = 128; // both inks (#1C1C1A, #6B6A64) are darker; paper, backdrop and shadow are lighter
// x-extent of ink inside a box (logical px in, raster px out); null if the box is blank
function inkX(img: Image, x1: number, x2: number, y1: number, y2: number): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (let y = Math.max(0, Math.floor(y1 * S)); y < Math.min(img.height, Math.ceil(y2 * S)); y++)
    for (let x = Math.max(0, Math.floor(x1 * S)); x < Math.min(img.width, Math.ceil(x2 * S)); x++)
      if (img.lum(x, y) < INK) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  return lo === Infinity ? null : [lo, hi];
}
const render = async (r: Receipt) => { const doc = layoutReceipt(r); const png = await toPng(toSvg(doc, fonts), fonts); return { doc, png, img: decode(png) }; };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ---- tests ----

test("png: 2× of the canonical SVG: 1248 px wide, height exactly 2× the layout; only IHDR/IDAT/IEND", async () => {
  for (const name of ["ordinary.jsonl", "no-tools.jsonl", "killed.jsonl", SUB]) {
    const { doc, png, img } = await render(await receiptOf(name));
    assert.equal(img.width, 1248);
    assert.equal(img.height, doc.height * 2);
    const types = chunks(png).map((c) => c.type);
    assert.equal(types[0], "IHDR");
    assert.equal(types.at(-1), "IEND");
    assert.deepEqual([...new Set(types)].sort(), ["IDAT", "IEND", "IHDR"], `${name}: no text, time, ICC or other metadata chunks`);
  }
});

test("png: same SVG, fonts and scale → byte-identical PNG, across renders and processes in other time zones", async () => {
  const svg = toSvg(layoutReceipt(await fullReceipt()), fonts);
  const a = await toPng(svg, fonts), b = await toPng(svg, fonts);
  assert.equal(sha(a), sha(b));
  const code = `Promise.all([import("./src/render/png.ts"), import("./src/assets.ts")]).then(async ([p, f]) => {
    const svg = require("node:fs").readFileSync(0, "utf8");
    process.stdout.write(require("node:crypto").createHash("sha256").update(await p.toPng(svg, f.loadFonts())).digest("hex"));
  });`;
  for (const tz of ["Pacific/Kiritimati", "America/St_Johns"]) {
    const out = spawnSync(process.execPath, ["-e", code], { input: svg, env: { ...process.env, TZ: tz }, encoding: "utf8" });
    assert.equal(out.stdout, sha(a), out.stderr);
  }
});

test("png: golden hash for a fixture (pinned resvg 2.6.2 and the bundled fonts)", async () => {
  const { png } = await render(await receiptOf("ordinary.jsonl"));
  assert.equal(sha(png), GOLDEN_ORDINARY);
});

test("fonts: text comes only from the supplied IBM Plex Mono bytes, never from system fonts", async () => {
  const doc = layoutReceipt(await receiptOf("ordinary.jsonl"));
  const svg = toSvg(doc, fonts);
  const none = decode(await toPng(svg, { regular: new Uint8Array(), bold: new Uint8Array() }));
  const withFonts = decode(await toPng(svg, fonts));
  const title = texts(doc).find((t) => t.text === "CLAUDE RECEIPT")!;
  const box = [TEXT_LEFT, TEXT_RIGHT, title.y - 40, title.y + 4] as const;
  assert.ok(inkX(withFonts, ...box), "title drawn with the bundled font");
  assert.equal(inkX(none, ...box), null, "no font supplied → no text at all (no system fallback)");
  // Regular and Bold are both used: the same digits are wider in ink when bold
  const one = (weight: 400 | 700) => toSvg({ ...doc, height: 60, items: [{ ...texts(doc)[0]!, text: "0000", x: 60, y: 40, anchor: "start", weight, role: "body", width: 48, letterSpacing: 0 }] });
  const darkness = async (w: 400 | 700) => { const img = decode(await toPng(one(w), fonts)); let n = 0; for (let y = 40; y < 90; y++) for (let x = 110; x < 230; x++) if (img.lum(x, y) < INK) n++; return n; };
  assert.ok((await darkness(700)) > (await darkness(400)) * 1.2, "bold is heavier");
});

// One line of text, rasterized: what resvg draws for a string.
async function glyphs(s: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><text x="10" y="28" font-size="20" font-family="IBM Plex Mono">${s}</text></svg>`;
  return sha(await toPng(svg, fonts));
}

test("unsupported glyphs (CJK, emoji, Greek, Arabic) render as the font's missing-glyph box; supported ones render", async () => {
  const box = await glyphs("数");
  for (const s of ["語", "🚀", "α", "ب"]) assert.equal(await glyphs(s), box, `${s} → missing-glyph box`);
  assert.notEqual(box, await glyphs(" "), "the box is visible");
  for (const s of ["A", "é", "ß", "Ж", "…", "·", "─"]) assert.notEqual(await glyphs(s), box, `${s} is in IBM Plex Mono`);
});

// Every row's ink sits where the layout put it: values end at column 40, marks in column 42,
// heuristic "~" starts the value, pinned (non-ASCII) runs fill their grid width, nothing leaves the text area.
async function assertRasterMatchesLayout(r: Receipt) {
  const { doc, img } = await render(r);
  const cell = 12, valueRight = TEXT_LEFT + 40 * cell, markX = valueRight + cell;
  // all ink inside the text area, between the torn edges
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.lum(x, y) >= INK) continue;
    assert.ok(x >= TEXT_LEFT * S - 2 && x <= TEXT_RIGHT * S + 2, `ink at x=${x}, y=${y} outside the text area`);
    assert.ok(y > (doc.paper.top + 6) * S && y < (doc.paper.bottom - 6) * S, `ink at y=${y} crosses a torn edge`);
  }
  for (const t of texts(doc).filter((t) => t.role === "body" && t.ink !== "paper")) {
    const [y1, y2] = [t.y - 16, t.y + 5];
    if (t.part === "value") {
      const ink = inkX(img, valueRight - t.width - 2, valueRight + 4, y1, y2)!;
      assert.ok(ink, `${t.metricId}: value drawn`);
      assert.ok(ink[1] <= valueRight * S + 2 && ink[1] >= (valueRight - cell) * S, `${t.metricId}: "${t.text}" ends at column 40 (ink to ${ink[1] / S})`);
      assert.ok(ink[0] >= (valueRight - t.width) * S - 2 && ink[0] <= (valueRight - t.width + cell) * S, `${t.metricId}: "${t.text}" starts in its first cell (ink from ${ink[0] / S})`);
      const mark = inkX(img, valueRight + 2, TEXT_RIGHT + 2, y1, y2);
      assert.equal(!!mark, t.mark === "*", `${t.metricId}: "*" drawn iff derived`);
      if (mark) assert.ok(mark[0] >= markX * S - 2, `${t.metricId}: "*" in the mark column`);
      if (t.mark === "~") assert.ok(inkX(img, valueRight - t.width, valueRight - t.width + cell, y1 + 6, y2 - 8), `${t.metricId}: "~" leads`);
    }
    if (t.pinned && t.anchor === "start") {
      const ink = inkX(img, t.x - 2, t.x + t.width + 4, y1, y2)!;
      assert.ok(ink[1] <= (t.x + t.width) * S + 2 && ink[1] >= (t.x + t.width - cell) * S, `pinned "${t.text}" fills its width`);
    }
  }
  return { doc, img };
}

test("raster geometry matches the layout: full, redacted, live, unavailable, long and wide values", async () => {
  const full = await fullReceipt();
  const long = "an-extraordinarily-long-monorepo-project-name-that-keeps-going";
  const set = (r: Receipt, id: MetricId, value: unknown) => mapMetrics(r, (m) => (m.id === id ? ({ ...m, value } as Metric) : m));
  for (const r of [
    full,
    redactReceipt(full),
    { ...full, session: { ...full.session, live: true } },
    await receiptOf("no-tools.jsonl"),
    { ...set(full, "files.mostEdited", `src/${"AnExtremelyLongComponentFileName".repeat(3)}.tsx`), session: { ...full.session, project: long } },
    { ...set(set(full, "files.mostEdited", "src/コンポーネント/ボタン.tsx"), "tokens.input", 1e12), session: { ...full.session, project: "数据-pipeline-café", title: "naïve Ünïcödé 日本語 e\u0301 🚀" } },
  ]) await assertRasterMatchesLayout(r);
});

test("live: the LIVE band is a solid ink bar with its words knocked out in paper colour", async () => {
  const base = await receiptOf("ordinary.jsonl");
  const { doc, img } = await render({ ...base, session: { ...base.session, live: true } });
  const band = doc.items.find((i) => i.kind === "band")!;
  assert.ok(band.kind === "band");
  const midY = Math.round((band.y + 4) * S);
  for (const x of [TEXT_LEFT + 2, TEXT_RIGHT - 2]) assert.ok(img.lum(Math.round(x * S), midY) < 40, "band is solid ink");
  let light = 0;
  for (let y = Math.round((band.y + 10) * S); y < Math.round((band.y + band.height - 10) * S); y++) for (let x = 200 * S; x < 420 * S; x++) if (img.lum(x, y) > 200) light++;
  assert.ok(light > 500, "band text is drawn in paper colour");
});

const GOLDEN_ORDINARY = "ca57ec5c9bdd54e686a567f713740c69860af66c4713aa68427179ff9616e231";

// The README's sample image: the redacted receipt of an anonymized fixture, regenerated with
// UPDATE_SNAPSHOTS=1 so it always shows the current renderer.
test("docs/receipt-sample.png is the current redacted PNG of the ordinary fixture", async () => {
  const { png } = await render(redactReceipt(await receiptOf("ordinary.jsonl")));
  const file = join("docs", "receipt-sample.png");
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) writeFileSync(file, png);
  assert.equal(sha(readFileSync(file)), sha(png));
});
