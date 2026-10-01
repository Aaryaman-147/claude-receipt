// Receipt → VisualDoc: the visual receipt as pure data with pixel geometry (docs/VISUAL_RECEIPT.md).
// Reads only the Receipt (never files, git, the archive, the clock or the environment), never
// mutates it, computes no analytics, and is deterministic. Words and values come from ../format.ts,
// shared with the terminal, so both receipts say the same thing with the same provenance marks.
import type { MetricId, Provenance, Receipt, Section } from "../../receipt/types.ts";
import {
  COST_NOTE, LEGEND, LIVE_BAND, SECTION_TITLES, SUBTITLE, TITLE,
  displayWidth, fit, footerFor, identityRows, isShown, markFor, metricRows, timesText, unavailableText, wrapWords,
} from "../format.ts";
import { TEXT_LEFT, TEXT_RIGHT, TEXT_WIDTH, VISUAL, baselineIn, cell, type TypeRole } from "./spec.ts";

export type Ink = "primary" | "secondary" | "paper";

export interface TextItem {
  kind: "text";
  x: number; // anchor point
  y: number; // baseline
  text: string;
  role: TypeRole;
  weight: 400 | 700;
  ink: Ink;
  anchor: "start" | "middle" | "end";
  width: number; // advance width in px (grid columns × cell, plus letter spacing)
  letterSpacing?: number;
  pinned?: boolean; // contains characters outside printable ASCII: SVG pins it to `width` (textLength)
  metricId?: MetricId; // metric rows: which metric this text shows
  provenance?: Provenance;
  part?: "label" | "value" | "mark" | "heading";
  mark?: "" | "*" | "~"; // on value parts: the provenance mark drawn for this row
}
export interface RuleItem { kind: "rule"; style: "double" | "dashed"; x1: number; x2: number; y: number }
export interface LeaderItem { kind: "leader"; x1: number; x2: number; y: number; metricId?: MetricId }
export interface BandItem { kind: "band"; x: number; y: number; width: number; height: number }
export type VisualItem = TextItem | RuleItem | LeaderItem | BandItem;

export interface VisualDoc {
  width: number;
  height: number;
  backdrop: string;
  paper: { x: number; top: number; bottom: number; width: number; fill: string; outline: [number, number][] };
  items: VisualItem[];
}

// Bold values, emphasized in place (never reordered). A heuristic value is never bold.
const PRIMARY = new Set<MetricId>(["session.duration.wall", "tokens.input", "tokens.output", "cost.apiEquivalent", "lines.added", "lines.removed"]);
const BODY_CELL = cell(VISUAL.type.body.size), COLS = VISUAL.grid.columns;
const VALUE_RIGHT = TEXT_LEFT + (COLS - VISUAL.grid.markColumns) * BODY_CELL; // values end at column 40
const MARK_X = VALUE_RIGHT + BODY_CELL; // the derived mark sits in column 41
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

export function layoutReceipt(receipt: Receipt): VisualDoc {
  const items: VisualItem[] = [];
  const s = receipt.session, tz = receipt.context.timeZone;
  const paperX = VISUAL.canvas.gutter, top = VISUAL.canvas.gutter;
  let y = top + VISUAL.edge.allowance;

  const text = (t: Omit<TextItem, "kind" | "width" | "y" | "weight" | "ink" | "anchor"> & Partial<Pick<TextItem, "weight" | "ink" | "anchor">>, baseline: number) => {
    const size = VISUAL.type[t.role].size, ls = t.letterSpacing ?? 0;
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
  const row = (label: string, value: string, prov: Provenance, meta: { metricId?: MetricId; bold?: boolean }) => {
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

  // ---- header ----
  line("title", (b) => text({ text: TITLE, role: "title", anchor: "middle", x: TEXT_LEFT + TEXT_WIDTH / 2, letterSpacing: VISUAL.type.title.letterSpacing }, b));
  line("small", (b) => text({ text: SUBTITLE, role: "small", anchor: "middle", x: TEXT_LEFT + TEXT_WIDTH / 2, ink: "secondary" }, b));
  doubleRule();
  for (const r of identityRows(s, tz)) row(r.label, fit(r.value, COLS - r.label.length - 6, VISUAL.ellipsis), "exact", {});
  if (s.title) {
    y += 8;
    let lines = wrapWords(`"${s.title}"`, COLS, VISUAL.ellipsis);
    if (lines.length > VISUAL.titleMaxLines) {
      lines = lines.slice(0, VISUAL.titleMaxLines);
      const last = lines[lines.length - 1]!;
      lines[lines.length - 1] = displayWidth(last) < COLS ? `${last}${VISUAL.ellipsis}` : fit(last, COLS, VISUAL.ellipsis);
    }
    for (const l of lines) line("body", (b) => text({ text: l, role: "body", x: TEXT_LEFT }, b));
  }
  if (s.live) {
    y += 12;
    const { height } = VISUAL.band;
    items.push({ kind: "band", x: TEXT_LEFT, y, width: TEXT_WIDTH, height });
    const pad = (height - VISUAL.type.body.lineHeight) / 2;
    text({ text: LIVE_BAND, role: "body", anchor: "middle", x: TEXT_LEFT + TEXT_WIDTH / 2, weight: 700, ink: "paper" }, y + pad + baselineIn("body"));
    y += height;
  }

  // ---- metric sections, in Receipt order ----
  const used = new Set<Provenance>();
  let unavailable = 0, costShown = false;
  for (const section of ["hard", "coding", "lore"] as Section[]) {
    const shown = receipt.sections[section].filter(isShown);
    unavailable += receipt.sections[section].filter((m) => m.value === null).length;
    if (!shown.length) continue;
    y += VISUAL.sectionGap;
    line("heading", (b, rowTop) => {
      const title = SECTION_TITLES[section];
      text({ text: title, role: "heading", x: TEXT_LEFT, part: "heading" }, b);
      const x1 = TEXT_LEFT + (displayWidth(title) + 1) * BODY_CELL;
      items.push({ kind: "rule", style: "dashed", x1, x2: TEXT_RIGHT, y: rowTop + VISUAL.type.heading.lineHeight / 2 });
    });
    for (const m of shown) {
      used.add(m.provenance);
      const { heading, rows } = metricRows(m);
      if (m.id === "cost.apiEquivalent") {
        costShown = true;
        const x1 = VALUE_RIGHT - VISUAL.rule.totalColumns * BODY_CELL;
        y += 8; items.push({ kind: "rule", style: "double", x1, x2: TEXT_RIGHT, y }); y += 6;
      }
      if (heading) line("body", (b) => text({ text: heading, role: "body", x: TEXT_LEFT, part: "label", metricId: m.id, provenance: m.provenance }, b));
      for (const r of rows) row(r.label, r.value, m.provenance, { metricId: m.id, bold: PRIMARY.has(m.id) });
    }
  }

  // ---- footer ----
  y += VISUAL.sectionGap - 8;
  doubleRule();
  const smallCols = Math.floor(TEXT_WIDTH / cell(VISUAL.type.small.size));
  const small = (t: string) => line("small", (b) => text({ text: t, role: "small", x: TEXT_LEFT, ink: "secondary" }, b));
  if (unavailable) for (const l of wrapWords(unavailableText(unavailable), smallCols, VISUAL.ellipsis)) small(l);
  for (const p of ["exact", "derived", "heuristic"] as Provenance[]) if (used.has(p)) small(LEGEND[p]);
  if (costShown) for (const l of wrapWords(COST_NOTE, smallCols, VISUAL.ellipsis)) small(l);
  small(fit(timesText(tz), smallCols, VISUAL.ellipsis));
  y += 16;
  line("body", (b) => text({ text: footerFor(s.id), role: "body", anchor: "middle", x: TEXT_LEFT + TEXT_WIDTH / 2, letterSpacing: 1 }, b));

  const bottom = y + VISUAL.edge.allowance;
  return {
    width: VISUAL.canvas.width,
    height: bottom + VISUAL.canvas.gutter,
    backdrop: VISUAL.canvas.backdrop,
    paper: { x: paperX, top, bottom, width: VISUAL.paper.width, fill: VISUAL.paper.fill, outline: outline(paperX, VISUAL.paper.width, top, bottom) },
    items,
  };
}
