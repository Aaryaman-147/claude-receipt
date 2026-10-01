// ReceiptView → VisualDoc: the visual receipt as pure data with pixel geometry (docs/VISUAL_RECEIPT.md).
// Reads only the view it is given (never files, git, the archive, the clock or the environment),
// never mutates it, computes no analytics, and is deterministic. The view (../view.ts) says what to
// print, shared with the terminal, so both receipts say the same thing with the same provenance marks.
import type { Provenance, Receipt } from "../../receipt/types.ts";
import { LEGEND, LIVE_BAND, displayWidth, fit, markFor, wrapWords } from "../format.ts";
import { sessionView, type ReceiptView, type StoryFact } from "../view.ts";
import { TEXT_LEFT, TEXT_RIGHT, TEXT_WIDTH, VISUAL, baselineIn, cell, type TypeRole } from "./spec.ts";

export type Ink = "primary" | "secondary" | "paper";

export interface TextItem {
  kind: "text";
  x: number; // anchor point
  y: number; // baseline
  text: string;
  role: TypeRole;
  size?: number; // display text only: its own size (the role's size otherwise)
  weight: 400 | 700;
  ink: Ink;
  anchor: "start" | "middle" | "end";
  width: number; // advance width in px (grid columns × cell, plus letter spacing)
  letterSpacing?: number;
  pinned?: boolean; // contains characters outside printable ASCII: SVG pins it to `width` (textLength)
  metricId?: string; // metric rows: which metric this text shows
  provenance?: Provenance;
  part?: "label" | "value" | "mark" | "heading" | "caption";
  mark?: "" | "*" | "~"; // on value parts: the provenance mark drawn for this row
}
export interface RuleItem { kind: "rule"; style: "double" | "dashed"; x1: number; x2: number; y: number }
export interface LeaderItem { kind: "leader"; x1: number; x2: number; y: number; metricId?: string }
export interface BandItem { kind: "band"; x: number; y: number; width: number; height: number }
export type VisualItem = TextItem | RuleItem | LeaderItem | BandItem;

export interface VisualDoc {
  width: number;
  height: number;
  backdrop: string;
  paper: { x: number; top: number; bottom: number; width: number; fill: string; outline: [number, number][] };
  items: VisualItem[];
}

const BAND = { live: LIVE_BAND } as const;
const BODY_CELL = cell(VISUAL.type.body.size), COLS = VISUAL.grid.columns;
const VALUE_RIGHT = TEXT_LEFT + (COLS - VISUAL.grid.markColumns) * BODY_CELL; // values end at column 40
const MARK_X = VALUE_RIGHT + BODY_CELL; // the derived mark sits in column 41
const MID = TEXT_LEFT + TEXT_WIDTH / 2, ST = VISUAL.story, LABEL = VISUAL.type.label;
const widthOf = (s: string, size: number, ls = 0) => displayWidth(s) * cell(size) + (ls ? ls * ([...s].length - 1) : 0);
const markSize = (size: number) => Math.round(size * ST.mark);
// A big number as drawn: "~" before a heuristic value, a raised "*" after a derived one.
const bigUnit = (f: StoryFact, size: number) => {
  const mark = markFor(f.provenance), shown = mark === "~" ? `~${f.value}` : f.value;
  return { mark, shown, width: widthOf(shown, size) + (mark === "*" ? 2 + cell(markSize(size)) : 0) };
};
// Column widths for numbers side by side at a size: each column is as wide as its widest part (the
// number with its mark, or its label). Null when the columns plus the minimum gaps do not fit.
const columnsAt = (facts: StoryFact[], size: number) => {
  const cols = facts.map((f) => Math.max(bigUnit(f, size).width, widthOf(f.label, LABEL.size, LABEL.letterSpacing)));
  return (TEXT_WIDTH - cols.reduce((a, b) => a + b, 0)) / facts.length >= ST.hero.gap ? cols : null;
};
const pinned = (s: string) => /[^\x20-\x7e]/.test(s);

// Torn sawtooth: whole teeth across the paper, peaks on the outer edge, valleys `depth` inside.
function outline(x: number, width: number, top: number, bottom: number): [number, number][] {
  const { tooth, depth } = VISUAL.edge;
  const teeth = Math.round(width / tooth);
  const pts: [number, number][] = [];
  for (let i = 0; i <= teeth; i++) pts.push([x + i * tooth, i % 2 ? top + depth : top]);
  for (let i = teeth; i >= 0; i--) pts.push([x + i * tooth, i % 2 ? bottom - depth : bottom]);
  return pts;
}

export const layoutReceipt = (receipt: Receipt): VisualDoc => layoutView(sessionView(receipt));

export function layoutView(view: ReceiptView): VisualDoc {
  const items: VisualItem[] = [];
  const paperX = VISUAL.canvas.gutter, top = VISUAL.canvas.gutter;
  let y = top + VISUAL.edge.allowance;

  const text = (t: Omit<TextItem, "kind" | "width" | "y" | "weight" | "ink" | "anchor"> & Partial<Pick<TextItem, "weight" | "ink" | "anchor">>, baseline: number) => {
    const size = t.size ?? VISUAL.type[t.role].size, ls = t.letterSpacing ?? 0;
    const chars = [...t.text].length;
    const width = displayWidth(t.text) * cell(size) + (ls ? ls * (chars - 1) : 0);
    items.push({ kind: "text", weight: VISUAL.type[t.role].weight, ink: "primary", anchor: "start", ...t, y: baseline, width, ...(pinned(t.text) ? { pinned: true } : {}) });
  };
  const line = (role: TypeRole, draw: (baseline: number, top: number) => void) => {
    draw(y + baselineIn(role), y);
    y += VISUAL.type[role].lineHeight;
  };
  const doubleRule = (x1 = TEXT_LEFT, x2 = TEXT_RIGHT) => { y += 8; items.push({ kind: "rule", style: "double", x1, x2, y }); y += 8; };

  // "LABEL ······ VALUE *": one body line, or label then value on its own right-aligned line.
  const row = (label: string, value: string, prov: Provenance, meta: { metricId?: string; bold?: boolean }) => {
    const mark = markFor(prov);
    const shownValue = mark === "~" && value ? `~${value}` : value;
    const indent = label.length - label.trimStart().length;
    const lbl = label.trimStart();
    const tag = meta.metricId ? { metricId: meta.metricId, provenance: prov } : {};
    const weight: 400 | 700 = meta.bold && prov !== "heuristic" ? 700 : 400;
    const drawValue = (baseline: number) => {
      if (!value) return;
      text({ text: shownValue, role: "body", anchor: "end", x: VALUE_RIGHT, weight, part: "value", mark, ...tag }, baseline);
      if (mark === "*") text({ text: "*", role: "body", x: MARK_X, weight, part: "mark", ...tag }, baseline);
    };
    const dots = COLS - indent - displayWidth(lbl) - displayWidth(shownValue) - VISUAL.grid.markColumns - 2;
    if (!value || dots >= 2) {
      line("body", (b) => {
        text({ text: fit(lbl, COLS - indent - VISUAL.grid.markColumns, VISUAL.ellipsis), role: "body", x: TEXT_LEFT + indent * BODY_CELL, part: "label", ...tag }, b);
        if (value) items.push({ kind: "leader", x1: TEXT_LEFT + (indent + displayWidth(lbl) + 1) * BODY_CELL, x2: TEXT_LEFT + (indent + displayWidth(lbl) + 1 + dots) * BODY_CELL, y: b, ...(meta.metricId ? { metricId: meta.metricId } : {}) });
        drawValue(b);
      });
    } else {
      line("body", (b) => text({ text: fit(lbl, COLS - indent, VISUAL.ellipsis), role: "body", x: TEXT_LEFT + indent * BODY_CELL, part: "label", ...tag }, b));
      const fitted = fit(shownValue, COLS - VISUAL.grid.markColumns, VISUAL.ellipsis);
      line("body", (b) => {
        text({ text: fitted, role: "body", anchor: "end", x: VALUE_RIGHT, weight, part: "value", mark, ...tag }, b);
        if (mark === "*") text({ text: "*", role: "body", x: MARK_X, weight, part: "mark", ...tag }, b);
      });
    }
  };

  // Numbers side by side (the hero, a beat's numbers): the largest size from `max` down at which every
  // column fits, columns spaced evenly; each number stays whole with its mark, its label centred below.
  // If even the smallest size does not fit, each number gets its own row.
  const numbers = (facts: StoryFact[], max: number) => {
    const { min, step, gap } = ST.hero;
    let size = max, cols = columnsAt(facts, size);
    while (!cols && size - step >= min) { size -= step; cols = columnsAt(facts, size); }
    if (!cols && facts.length > 1) { for (const f of facts) numbers([f], max); return; }
    cols ??= [TEXT_WIDTH - gap];
    const space = (TEXT_WIDTH - cols.reduce((a, b) => a + b, 0)) / facts.length;
    const b = y + size;
    let x = TEXT_LEFT + space / 2;
    facts.forEach((f, i) => {
      const cx = x + cols[i]! / 2, u = bigUnit(f, size), x0 = cx - u.width / 2;
      const tag = f.metricId ? { metricId: f.metricId, provenance: f.provenance } : {};
      const weight: 400 | 700 = f.provenance === "heuristic" ? 400 : 700;
      text({ text: u.shown, role: "display", size, x: x0, weight, part: "value", mark: u.mark, ...tag }, b);
      if (u.mark === "*") text({ text: "*", role: "display", size: markSize(size), x: x0 + widthOf(u.shown, size) + 2, weight, part: "mark", ...tag }, b - size * 0.45);
      text({ text: f.label, role: "label", anchor: "middle", x: cx, ink: "secondary", letterSpacing: LABEL.letterSpacing, ...tag, ...(f.metricId ? { part: "caption" as const } : {}) }, b + 22);
      x += cols[i]! + space;
    });
    y = b + 28;
  };
  //  -------- YOUR BIGGEST DAY --------
  const beatHeading = (s: string) => {
    y += ST.beatGap - VISUAL.type.beat.lineHeight / 2;
    line("beat", (b, rowTop) => {
      const ls = VISUAL.type.beat.letterSpacing, w = widthOf(s, VISUAL.type.beat.size, ls);
      text({ text: s, role: "beat", anchor: "middle", x: MID, letterSpacing: ls, part: "heading" }, b);
      const mid = rowTop + VISUAL.type.beat.lineHeight / 2, inner = w / 2 + 12;
      const side = Math.min(ST.beatRule, TEXT_WIDTH / 2 - inner);
      if (side >= 16) {
        items.push({ kind: "rule", style: "dashed", x1: MID - inner - side, x2: MID - inner, y: mid });
        items.push({ kind: "rule", style: "dashed", x1: MID + inner, x2: MID + inner + side, y: mid });
      }
    });
  };
  const caption = (s: string, f: StoryFact) => {
    line("small", (b) => text({ text: fit(s, Math.floor(TEXT_WIDTH / cell(VISUAL.type.small.size)), VISUAL.ellipsis), role: "small", anchor: "middle", x: MID, ink: "secondary", ...(f.metricId ? { metricId: f.metricId, provenance: f.provenance, part: "caption" as const } : {}) }, b));
  };

  // ---- opening and header ----
  line("opening", (b) => text({ text: view.opening, role: "opening", anchor: "middle", x: MID, ink: "secondary", letterSpacing: VISUAL.type.opening.letterSpacing }, b));
  y += 8;
  line("title", (b) => text({ text: view.title, role: "title", anchor: "middle", x: TEXT_LEFT + TEXT_WIDTH / 2, letterSpacing: VISUAL.type.title.letterSpacing }, b));
  line("small", (b) => text({ text: view.subtitle, role: "small", anchor: "middle", x: TEXT_LEFT + TEXT_WIDTH / 2, ink: "secondary" }, b));
  doubleRule();
  const heroRefs = new Set(view.hero.map((f) => f.ref));
  for (const r of view.header) if (!r.ref || !heroRefs.has(r.ref)) row(r.label, fit(r.value, COLS - r.label.length - 6, VISUAL.ellipsis), r.provenance, {});
  if (view.note) {
    y += 8;
    let lines = wrapWords(view.note, COLS, VISUAL.ellipsis);
    if (lines.length > VISUAL.titleMaxLines) {
      lines = lines.slice(0, VISUAL.titleMaxLines);
      const last = lines[lines.length - 1]!;
      lines[lines.length - 1] = displayWidth(last) < COLS ? `${last}${VISUAL.ellipsis}` : fit(last, COLS, VISUAL.ellipsis);
    }
    for (const l of lines) line("body", (b) => text({ text: l, role: "body", x: TEXT_LEFT }, b));
  }
  if (view.band) {
    y += 12;
    const { height } = VISUAL.band;
    items.push({ kind: "band", x: TEXT_LEFT, y, width: TEXT_WIDTH, height });
    const pad = (height - VISUAL.type.body.lineHeight) / 2;
    text({ text: BAND[view.band], role: "body", anchor: "middle", x: TEXT_LEFT + TEXT_WIDTH / 2, weight: 700, ink: "paper" }, y + pad + baselineIn("body"));
    y += height;
  }

  // ---- the story: hero, then beats ----
  if (view.hero.length) { y += ST.hero.top; numbers(view.hero, ST.hero.max); y += ST.hero.bottom; }
  for (const beat of view.beats) {
    beatHeading(beat.heading);
    const [first, ...rest] = beat.facts;
    if (beat.id === "shipped") numbers(beat.facts, ST.big.pair);
    else if (beat.id === "biggest-day" || beat.id === "long-one" || beat.id === "longest-turn" || beat.id === "nice-run") {
      y += 4;
      numbers([first!], beat.id === "biggest-day" ? ST.big.day : ST.big.single);
      if (rest.length) caption(rest.map((f) => f.value).join(" → "), first!);
    } else {
      y += 4;
      for (const f of beat.facts) row(f.label, f.value, f.provenance, f.metricId ? { metricId: f.metricId } : {});
    }
  }

  // ---- supporting sections, in view order, without what the story already showed ----
  for (const section of view.sections) {
    const entries = section.entries.filter((e) => !view.consumed.includes(e.metricId));
    if (!entries.length) continue;
    y += VISUAL.sectionGap;
    line("heading", (b, rowTop) => {
      text({ text: section.title, role: "heading", x: TEXT_LEFT, part: "heading" }, b);
      const x1 = TEXT_LEFT + (displayWidth(section.title) + 1) * BODY_CELL;
      items.push({ kind: "rule", style: "dashed", x1, x2: TEXT_RIGHT, y: rowTop + VISUAL.type.heading.lineHeight / 2 });
    });
    for (const e of entries) {
      if (e.total) {
        const x1 = VALUE_RIGHT - VISUAL.rule.totalColumns * BODY_CELL;
        y += 8; items.push({ kind: "rule", style: "double", x1, x2: TEXT_RIGHT, y }); y += 6;
      }
      if (e.heading) line("body", (b) => text({ text: e.heading!, role: "body", x: TEXT_LEFT, part: "label", metricId: e.metricId, provenance: e.provenance }, b));
      for (const r of e.rows) row(r.label, r.value, r.provenance, { ...(r.metricId ? { metricId: r.metricId } : {}), bold: r.bold === true });
    }
  }

  // ---- the observation: a heuristic, never bold, marked ~ ----
  if (view.observation) {
    y += ST.observationGap;
    line("beat", (b) => text({ text: `${view.observation!.heading} ~`, role: "beat", anchor: "middle", x: MID, weight: 400, letterSpacing: VISUAL.type.beat.letterSpacing }, b));
    for (const l of wrapWords(view.observation.text, Math.floor(TEXT_WIDTH / cell(VISUAL.type.small.size)) - 4, VISUAL.ellipsis))
      line("small", (b) => text({ text: l, role: "small", anchor: "middle", x: MID, ink: "secondary" }, b));
  }

  // ---- footer ----
  y += VISUAL.sectionGap - 8;
  doubleRule();
  const smallCols = Math.floor(TEXT_WIDTH / cell(VISUAL.type.small.size));
  const small = (t: string) => line("small", (b) => text({ text: t, role: "small", x: TEXT_LEFT, ink: "secondary" }, b));
  for (const f of view.footnotes) {
    if ("legend" in f) small(LEGEND[f.legend]);
    else if (f.wrap) for (const l of wrapWords(f.text, smallCols, VISUAL.ellipsis)) small(l);
    else small(fit(f.text, smallCols, VISUAL.ellipsis));
  }
  y += 16;
  line("body", (b) => text({ text: view.closing, role: "body", anchor: "middle", x: TEXT_LEFT + TEXT_WIDTH / 2, letterSpacing: 1 }, b));

  const bottom = y + VISUAL.edge.allowance;
  return {
    width: VISUAL.canvas.width,
    height: bottom + VISUAL.canvas.gutter,
    backdrop: VISUAL.canvas.backdrop,
    paper: { x: paperX, top, bottom, width: VISUAL.paper.width, fill: VISUAL.paper.fill, outline: outline(paperX, VISUAL.paper.width, top, bottom) },
    items,
  };
}
