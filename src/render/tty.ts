// Terminal receipt: ReceiptView → string. Reads nothing but the view it is given (no files, no
// clock, no git, no archive) and is deterministic. Plain ASCII is the base; ANSI (bold/dim) is an
// optional layer. Provenance is always visible (docs/METRICS.md → Rendering rule): exact =
// unmarked, derived = " *" suffix, heuristic = "~" prefix, plus a legend. The view (./view.ts)
// says what to print; this file decides how it fits 28..40 columns.
import type { Provenance, Receipt } from "../receipt/types.ts";
import { LEGEND, LIVE_TERMINAL, MARK, displayWidth, fit, wrapWords } from "./format.ts";
import { sessionView, type ReceiptView } from "./view.ts";

export interface RenderOptions {
  width?: number; // columns; clamped to 28..40 (default 40)
  color?: boolean; // ANSI bold/dim; default false
}

export interface Line {
  text: string; // plain text (no ANSI)
  metricId?: string; // set on lines that show a metric value
  provenance?: Provenance;
  value?: string; // the formatted value shown on this line, without marks
}

const BAND = { live: LIVE_TERMINAL } as const;

export function renderViewLines(view: ReceiptView, opts: RenderOptions = {}): Line[] {
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

  push("/\\".repeat(W).slice(0, W));
  push("");
  push(center(view.title.split("").join(" ")));
  push(center(view.subtitle));
  rule("=");
  for (const r of view.header) item(r.label, fit(r.value, W - r.label.length - 6), r.provenance, {});
  if (view.note) { push(""); for (const l of wrapWords(view.note, W)) push(l); }
  if (view.band) { push(""); push(center(BAND[view.band])); }

  for (const section of view.sections) {
    push("");
    const title = `-- ${section.title} `;
    push(`${title}${"-".repeat(Math.max(0, W - title.length))}`);
    for (const e of section.entries) {
      if (e.heading) push(e.heading, { metricId: e.metricId, provenance: e.provenance });
      for (const r of e.rows) item(r.label, r.value, r.provenance, { ...(r.metricId ? { metricId: r.metricId } : {}), provenance: r.provenance, value: r.value });
    }
  }

  push("");
  rule("=");
  for (const f of view.footnotes) {
    if ("legend" in f) push(LEGEND[f.legend]);
    else if (f.wrap) for (const l of wrapWords(f.text, W)) push(l);
    else push(fit(f.text, W));
  }
  push("");
  push(center(view.closing));
  push("");
  push("\\/".repeat(W).slice(0, W));
  return out;
}

export const renderLines = (receipt: Receipt, opts: RenderOptions = {}): Line[] => renderViewLines(sessionView(receipt), opts);

const ESC = "\x1b[";
// Optional ANSI layer: bold title and section headings, dim rules and dotted leaders. Removing
// the escape codes gives back exactly the plain text.
function paint(t: string, i: number): string {
  if (i === 2 || /^-- [A-Z ]+ -*$/.test(t)) return `${ESC}1m${t}${ESC}0m`;
  if (/^(=+|[/\\]+)$/.test(t)) return `${ESC}2m${t}${ESC}0m`;
  return t.replace(/ (\.{2,}) /, ` ${ESC}2m$1${ESC}0m `);
}

export function renderViewTerminal(view: ReceiptView, opts: RenderOptions = {}): string {
  return `${renderViewLines(view, opts).map((l, i) => (opts.color ? paint(l.text, i) : l.text)).join("\n")}\n`;
}

export const renderTerminal = (receipt: Receipt, opts: RenderOptions = {}): string => renderViewTerminal(sessionView(receipt), opts);
