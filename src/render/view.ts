// The shared presentation model: what a printed receipt says, in order, before any renderer decides
// how wide it is or how it looks. Session Receipts (and, from v0.2, HistoryReceipts) are turned into
// a ReceiptView here; the terminal (tty.ts) and the visual layout (visual/layout.ts) render it.
// Presentation structure only: already-formatted strings, provenance and metric ids. No semantic
// model, no widths or coordinates, no ANSI or SVG. Strings come from ./format.ts.
import type { Provenance, Receipt, Section } from "../receipt/types.ts";
import { COST_NOTE, LEGEND_ORDER, PRIMARY, SECTION_TITLES, SUBTITLE, TITLE, footerFor, identityRows, isShown, metricRows, timesText, unavailableText } from "./format.ts";

export interface ViewRow {
  label: string; // may start with "  " (an indented list row)
  value: string; // formatted, without provenance marks ("" for a heading-only row)
  provenance: Provenance; // renderers draw the mark from this (exact plain, derived " *", heuristic "~")
  metricId?: string; // set on metric rows
  bold?: true; // emphasized value; never set on a heuristic value
}

export interface ViewEntry {
  metricId: string;
  provenance: Provenance;
  heading?: string; // a list metric: its label on its own line, rows below
  rows: ViewRow[];
  total?: true; // a total line: the visual receipt draws a short double rule above it
}

export interface ViewSection { title: string; entries: ViewEntry[] }

// Footer lines in order: plain text (wrapped to the width, or cut to one line) and legend entries.
export type ViewFootnote = { text: string; wrap: boolean } | { legend: Provenance };

export interface ReceiptView {
  title: string;
  subtitle: string;
  header: ViewRow[]; // identity rows (provenance exact, no metric id)
  note: string | null; // a quoted line under the header (the session title), wrapped by the renderer
  band: "live" | null; // a status band; each renderer has its own wording for it
  sections: ViewSection[]; // only sections with something to show
  footnotes: ViewFootnote[];
  closing: string; // footer microcopy
}

// The view of a session Receipt. Pure; reads only the Receipt.
export function sessionView(receipt: Receipt): ReceiptView {
  const s = receipt.session, tz = receipt.context.timeZone;
  const used = new Set<Provenance>();
  let unavailable = 0, costShown = false;
  const sections: ViewSection[] = [];
  for (const section of ["hard", "coding", "lore"] as Section[]) {
    unavailable += receipt.sections[section].filter((m) => m.value === null).length;
    const shown = receipt.sections[section].filter(isShown);
    if (!shown.length) continue;
    sections.push({
      title: SECTION_TITLES[section],
      entries: shown.map((m) => {
        used.add(m.provenance);
        if (m.id === "cost.apiEquivalent") costShown = true;
        const { heading, rows } = metricRows(m);
        const bold = PRIMARY.has(m.id) && m.provenance !== "heuristic";
        return {
          metricId: m.id, provenance: m.provenance,
          ...(heading ? { heading } : {}),
          rows: rows.map((r) => ({ label: r.label, value: r.value, provenance: m.provenance, metricId: m.id, ...(bold ? { bold: true as const } : {}) })),
          ...(m.id === "cost.apiEquivalent" ? { total: true as const } : {}),
        };
      }),
    });
  }
  const footnotes: ViewFootnote[] = [
    ...(unavailable ? [{ text: unavailableText(unavailable), wrap: true }] : []),
    ...LEGEND_ORDER.filter((p) => used.has(p)).map((p) => ({ legend: p })),
    ...(costShown ? [{ text: COST_NOTE, wrap: true }] : []),
    { text: timesText(tz), wrap: false },
  ];
  return {
    title: TITLE,
    subtitle: SUBTITLE,
    header: identityRows(s, tz).map((r) => ({ label: r.label, value: r.value, provenance: "exact" })),
    note: s.title ? `"${s.title}"` : null,
    band: s.live ? "live" : null,
    sections,
    footnotes,
    closing: footerFor(s.id),
  };
}
