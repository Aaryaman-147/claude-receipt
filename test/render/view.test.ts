// v0.2 milestone 2: the shared presentation model (Receipt → ReceiptView) that the terminal and the
// visual receipt both render. Presentation structure only; the renderers' own tests pin their output.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildReceipt } from "../../src/analytics/index.ts";
import { redactReceipt } from "../../src/receipt/redact.ts";
import type { Metric, MetricId, Receipt } from "../../src/receipt/types.ts";
import { COST_NOTE, LEGEND_ORDER, PRIMARY, SECTION_TITLES, SUBTITLE, TITLE, footerFor, isShown, timesText } from "../../src/render/format.ts";
import { renderTerminal, renderViewTerminal } from "../../src/render/tty.ts";
import { layoutReceipt, layoutView } from "../../src/render/visual/layout.ts";
import { sessionView, type ReceiptView } from "../../src/render/view.ts";
import { loadSessions, refForFile } from "../../src/source/claude-code/index.ts";

const DIR = join("fixtures", "claude-code", "2.1.283");
const SUB = join("subagent", readdirSync(join(DIR, "subagent")).find((f) => f.endsWith(".jsonl"))!);
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).concat(SUB);
const NOW = new Date("2026-10-01T00:00:00.000Z");
const receipts = async () => (await loadSessions(FIXTURES.map((n) => refForFile(join(DIR, n))))).map((s) => buildReceipt(s, { now: NOW, timeZone: "UTC" }));
// loaded on its own: loaded with the others, it is (correctly) seen as a fork of an identical fixture
const ordinary = async () => buildReceipt((await loadSessions([refForFile(join(DIR, "ordinary.jsonl"))]))[0]!, { now: NOW, timeZone: "UTC" });
const all = (r: Receipt) => Object.values(r.sections).flat();
const withProv = (r: Receipt, id: MetricId, provenance: Metric["provenance"]): Receipt =>
  ({ ...r, sections: Object.fromEntries(Object.entries(r.sections).map(([k, ms]) => [k, ms.map((m) => (m.id === id ? { ...m, provenance } : m))])) as Receipt["sections"] });

test("session view: title, header, note, band and sections in Receipt order, only what is shown", async () => {
  for (const r of await receipts()) {
    const v = sessionView(r);
    assert.equal(v.title, TITLE);
    assert.equal(v.subtitle, SUBTITLE);
    assert.ok(v.header.every((h) => h.provenance === "exact" && h.metricId === undefined && !h.bold), "identity rows are plain");
    assert.deepEqual(v.header.map((h) => h.label).slice(0, 1), ["SESSION"]);
    assert.equal(v.note, r.session.title ? `"${r.session.title}"` : null);
    assert.equal(v.band, r.session.live ? "live" : null);
    const shownSections = (["hard", "coding", "lore"] as const).filter((s) => r.sections[s].some(isShown));
    assert.deepEqual(v.sections.map((s) => s.title), shownSections.map((s) => SECTION_TITLES[s]));
    assert.deepEqual(v.sections.flatMap((s) => s.entries.map((e) => e.metricId)), all(r).filter(isShown).map((m) => m.id), "same metrics, same order");
    assert.equal(v.closing, footerFor(r.session.id));
  }
});

test("rows carry their metric id and provenance; list metrics are a heading plus rows", async () => {
  const byId = new Map((await receipts()).flatMap(all).map((m) => [m.id, m]));
  for (const r of await receipts()) {
    for (const e of sessionView(r).sections.flatMap((s) => s.entries)) {
      const m = all(r).find((x) => x.id === e.metricId)!;
      assert.equal(e.provenance, m.provenance);
      assert.ok(e.rows.length > 0);
      for (const row of e.rows) assert.deepEqual([row.metricId, row.provenance], [m.id, m.provenance]);
      assert.equal(e.heading !== undefined, ["models.used", "toolCalls.byName", "languages", "commands.topPrograms"].includes(m.id), `${m.id}: heading iff a list metric`);
      if (e.heading) assert.ok(e.rows.every((row) => row.label.startsWith("  ")), "list rows are indented");
    }
  }
  assert.ok(byId.size > 0);
});

test("emphasis: only primary values are bold, never a heuristic one; API EQUIVALENT is the one total", async () => {
  const r = await ordinary();
  const entries = sessionView(r).sections.flatMap((s) => s.entries);
  for (const e of entries) for (const row of e.rows) assert.equal(row.bold === true, PRIMARY.has(e.metricId) && e.provenance !== "heuristic", e.metricId);
  assert.deepEqual(entries.filter((e) => e.total).map((e) => e.metricId), ["cost.apiEquivalent"]);
  const heuristicTokens = sessionView(withProv(r, "tokens.input", "heuristic")).sections.flatMap((s) => s.entries).find((e) => e.metricId === "tokens.input")!;
  assert.ok(heuristicTokens.rows.every((row) => !row.bold), "a primary metric loses emphasis when heuristic");
});

test("footnotes: unavailable count, legend for the marks in use (in order), cost note, then the time zone (one line)", async () => {
  for (const r of await receipts()) {
    const f = sessionView(r).footnotes;
    const used = new Set(all(r).filter(isShown).map((m) => m.provenance));
    const nulls = all(r).filter((m) => m.value === null).length;
    const want = [
      ...(nulls ? [{ text: `${nulls} metric${nulls === 1 ? "" : "s"} unavailable, not shown`, wrap: true }] : []),
      ...LEGEND_ORDER.filter((p) => used.has(p)).map((p) => ({ legend: p })),
      ...(all(r).some((m) => m.id === "cost.apiEquivalent" && isShown(m)) ? [{ text: COST_NOTE, wrap: true }] : []),
      { text: timesText("UTC"), wrap: false },
    ];
    assert.deepEqual(f, want);
  }
});

test("the view is presentation only: strings, provenance and flags; no coordinates, ANSI, markup or semantic fields", async () => {
  const leaves = (v: unknown, path = ""): [string, unknown][] => (v !== null && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => leaves(x, `${path}.${k}`)) : [[path, v]]);
  for (const r of await receipts()) {
    const v = sessionView({ ...r, session: { ...r.session, live: true, title: "a title" } });
    for (const [path, x] of leaves(v)) assert.ok(typeof x === "string" || typeof x === "boolean" || x === null, `${path}: ${typeof x}`);
    const text = JSON.stringify(v);
    assert.ok(!/\x1b\[|<\/?[a-z]+[ >]|"(x|y|width|height|cwd|projectKey|sessionId|startedAt|generatedAt|sections\.)"\s*:/.test(text), "no renderer or semantic data");
  }
});

test("redaction happens before the view: a redacted Receipt's view shows no project, path, title or full id", async () => {
  const r = await ordinary();
  const secret = { ...r, session: { ...r.session, project: "secret-proj", title: "secret title", cwd: "C:\\secret" } };
  const plain = JSON.stringify(sessionView(secret));
  assert.ok(plain.includes("secret-proj") && plain.includes("secret title"), "unredacted shows them");
  const v = JSON.stringify(sessionView(redactReceipt(secret)));
  for (const s of ["secret", "C:\\\\", "file1.txt", '"PROJECT"']) assert.ok(!v.includes(s), `leaked ${s}`);
  assert.ok(v.includes('"*.txt"'));
});

test("renderers render the view: the Receipt entry points equal rendering the session view", async () => {
  for (const r of await receipts()) {
    const v: ReceiptView = sessionView(r);
    assert.equal(renderTerminal(r), renderViewTerminal(v));
    assert.equal(renderTerminal(r, { width: 28, color: true }), renderViewTerminal(v, { width: 28, color: true }));
    assert.deepEqual(layoutReceipt(r), layoutView(v));
  }
});

test("view.ts is pure: imports only the Receipt types and the shared format module", () => {
  const src = readFileSync("src/render/view.ts", "utf8");
  for (const [, from] of src.matchAll(/^import[^;]*?from "([^"]+)"/gm)) assert.match(from!, /^\.\.?\/(\.\.\/receipt\/types|receipt\/types|format)\.ts$/, from!);
  assert.ok(!/\b(process\.|Date\.now|new Date\(|Math\.random|require\(|node:|\\x1b|<svg)/.test(src));
});
