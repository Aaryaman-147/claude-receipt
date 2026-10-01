// Terminal receipt: Receipt → string. Reads nothing but the Receipt it is given (no files, no
// clock, no git, no archive), never mutates it, and is deterministic. Plain ASCII is the base;
// ANSI (bold/dim) is an optional layer. Provenance is always visible (docs/METRICS.md →
// Rendering rule): exact = unmarked, derived = " *" suffix, heuristic = "~" prefix, plus a legend.
// Words and values come from ./format.ts, shared with the visual receipt.
import type { MetricId, Provenance, Receipt, Section } from "../receipt/types.ts";
import {
  COST_NOTE, LEGEND, LIVE_TERMINAL, MARK, SECTION_TITLES, SUBTITLE, TITLE,
  displayWidth, fit, footerFor, identityRows, isShown, metricRows, timesText, unavailableText, wrapWords,
} from "./format.ts";

export interface RenderOptions {
  width?: number; // columns; clamped to 28..40 (default 40)
  color?: boolean; // ANSI bold/dim; default false
}

export interface Line {
  text: string; // plain text (no ANSI)
  metricId?: MetricId; // set on lines that show a metric value
  provenance?: Provenance;
  value?: string; // the formatted value shown on this line, without marks
}

export function renderLines(receipt: Receipt, opts: RenderOptions = {}): Line[] {
  const W = Math.max(28, Math.min(40, Math.floor(opts.width ?? 40)));
  const out: Line[] = [];
  const push = (text: string, meta: Omit<Line, "text"> = {}) => out.push({ text: text.trimEnd(), ...meta });
  const center = (t: string) => { const s = fit(t, W); return `${" ".repeat(Math.floor((W - displayWidth(s)) / 2))}${s}`; };
  // "LABEL ....... VALUE" with the provenance mark; wraps the value onto its own line if needed.
  const item = (label: string, value: string, prov: Provenance, meta: Omit<Line, "text">) => {
    const shown = prov === "heuristic" && value ? `${MARK.heuristicPrefix}${value}` : value;
    const right = `${shown}${prov === "derived" ? MARK.derived : "  "}`;
    const dots = W - displayWidth(label) - displayWidth(right) - 2;
    if (!value) { push(`${fit(label, W - 2)}${right.trim() ? `${" ".repeat(Math.max(0, W - 2 - displayWidth(fit(label, W - 2))))}${right}` : ""}`, meta); return; }
    if (dots >= 2) { push(`${label} ${".".repeat(dots)} ${right}`, meta); return; }
    push(fit(label, W));
    push(`${" ".repeat(Math.max(0, W - displayWidth(right)))}${fit(right, W)}`, meta);
  };
  const rule = (ch: string) => push(ch.repeat(W));
  const s = receipt.session, tz = receipt.context.timeZone;

  push("/\\".repeat(W).slice(0, W));
  push("");
  push(center(TITLE.split("").join(" ")));
  push(center(SUBTITLE));
  rule("=");
  for (const r of identityRows(s, tz)) item(r.label, fit(r.value, W - r.label.length - 6), "exact", {});
  if (s.title) { push(""); for (const l of wrapWords(`"${s.title}"`, W)) push(l); }
  if (s.live) { push(""); push(center(LIVE_TERMINAL)); }

  const used = new Set<Provenance>();
  let unavailable = 0, costShown = false;
  for (const section of ["hard", "coding", "lore"] as Section[]) {
    const shown = receipt.sections[section].filter(isShown);
    unavailable += receipt.sections[section].filter((m) => m.value === null).length;
    if (!shown.length) continue;
    push("");
    const title = `-- ${SECTION_TITLES[section]} `;
    push(`${title}${"-".repeat(Math.max(0, W - title.length))}`);
    for (const m of shown) {
      const { heading, rows } = metricRows(m);
      used.add(m.provenance);
      if (m.id === "cost.apiEquivalent") costShown = true;
      if (heading) push(heading, { metricId: m.id, provenance: m.provenance });
      for (const r of rows) item(r.label, r.value, m.provenance, { metricId: m.id, provenance: m.provenance, value: r.value });
    }
  }

  push("");
  rule("=");
  if (unavailable) for (const l of wrapWords(unavailableText(unavailable), W)) push(l);
  for (const p of ["exact", "derived", "heuristic"] as Provenance[]) if (used.has(p)) push(LEGEND[p]);
  if (costShown) for (const l of wrapWords(COST_NOTE, W)) push(l);
  push(fit(timesText(tz), W));
  push("");
  push(center(footerFor(s.id)));
  push("");
  push("\\/".repeat(W).slice(0, W));
  return out;
}

const ESC = "\x1b[";
// Optional ANSI layer: bold title and section headings, dim rules and dotted leaders. Removing
// the escape codes gives back exactly the plain text.
function paint(t: string, i: number): string {
  if (i === 2 || /^-- [A-Z ]+ -*$/.test(t)) return `${ESC}1m${t}${ESC}0m`;
  if (/^(=+|[/\\]+)$/.test(t)) return `${ESC}2m${t}${ESC}0m`;
  return t.replace(/ (\.{2,}) /, ` ${ESC}2m$1${ESC}0m `);
}

export function renderTerminal(receipt: Receipt, opts: RenderOptions = {}): string {
  return `${renderLines(receipt, opts).map((l, i) => (opts.color ? paint(l.text, i) : l.text)).join("\n")}\n`;
}
