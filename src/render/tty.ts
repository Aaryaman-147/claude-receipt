// Terminal receipt: Receipt → string. Reads nothing but the Receipt it is given (no files, no
// clock, no git, no archive), never mutates it, and is deterministic. Plain ASCII is the base;
// ANSI (bold/dim) is an optional layer. Provenance is always visible (docs/METRICS.md →
// Rendering rule): exact = unmarked, derived = " *" suffix, heuristic = "~" prefix, plus a legend.
import type { Metric, MetricId, Provenance, Receipt, Section } from "../receipt/types.ts";
import {
  COST_NOTE, FOOTERS, LABELS, LEGEND, MARK, SECTION_TITLES,
  basename, displayWidth, duration, fit, hour, int, localTime, model, pct, ratio, usd,
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

type Row = { label: string; value: string };
const top = <T>(xs: T[], n = 3) => xs.slice(0, n);

// One or more {label, value} rows per metric. A list metric renders as a heading plus rows.
function rows(m: Metric): { heading?: string; rows: Row[] } {
  const label = LABELS[m.id];
  const one = (value: string): { rows: Row[] } => ({ rows: [{ label, value }] });
  switch (m.id) {
    case "session.duration.wall": case "session.duration.active": case "session.duration.open": case "api.duration": case "lore.longestTurn":
      return one(duration(m.value!));
    case "cost.apiEquivalent": return one(usd(m.value!));
    case "lines.added": return one(`+${int(m.value!)}`);
    case "lines.removed": return one(`-${int(m.value!)}`);
    case "lore.cacheHitRate": return one(pct(m.value!));
    case "lore.readEditRatio": return one(ratio(m.value!));
    case "lore.peakHour": return one(hour(m.value!));
    case "files.mostEdited": return one(m.value!.startsWith("*") ? m.value! : basename(m.value!));
    case "git.lines": return one(`+${int(m.value!.added)} / -${int(m.value!.removed)}`);
    case "lore.rabbitHole": {
      const v = m.value!;
      return one(`${v.toolCalls} call${v.toolCalls === 1 ? "" : "s"}${v.durationMs === null ? "" : ` in ${duration(v.durationMs)}`}`);
    }
    case "models.used": return { heading: label, rows: m.value!.map((id) => ({ label: `  ${model(id)}`, value: "" })) };
    case "toolCalls.byName":
      return { heading: label, rows: top(Object.entries(m.value!).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))).map(([name, n]) => ({ label: `  ${name}`, value: int(n) })) };
    case "languages": return { heading: label, rows: top(m.value!).map((l) => ({ label: `  ${l.language}`, value: `${int(l.lines)} lines` })) };
    case "commands.topPrograms": return { heading: label, rows: top(m.value!).map((p) => ({ label: `  ${p.program}`, value: int(p.count) })) };
    default: return one(int(m.value as number));
  }
}

export function renderLines(receipt: Receipt, opts: RenderOptions = {}): Line[] {
  const W = Math.max(28, Math.min(40, Math.floor(opts.width ?? 40)));
  const out: Line[] = [];
  const push = (text: string, meta: Omit<Line, "text"> = {}) => out.push({ text: text.trimEnd(), ...meta });
  const center = (t: string) => { const s = fit(t, W); return `${" ".repeat(Math.floor((W - displayWidth(s)) / 2))}${s}`; };
  const wrap = (t: string) => {
    const lines: string[] = [];
    let cur = "";
    for (const word of t.split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${word}` : word;
      if (displayWidth(next) <= W) cur = next;
      else { if (cur) lines.push(cur); cur = fit(word, W); }
    }
    if (cur) lines.push(cur);
    return lines;
  };
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
  push(center("C L A U D E   R E C E I P T"));
  push(center("itemized session record"));
  rule("=");
  const header = (label: string, value: string | null) => { if (value) item(label, fit(value, W - label.length - 6), "exact", {}); };
  header("SESSION", s.id.slice(0, 8));
  header("PROJECT", s.project);
  header("STARTED", s.startedAt && localTime(s.startedAt, tz));
  header("ENDED", s.endedAt && localTime(s.endedAt, tz));
  header("ENTRY", s.entrypoint && ({ cli: "CLI", "sdk-cli": "HEADLESS", "claude-desktop": "DESKTOP" }[s.entrypoint] ?? s.entrypoint.toUpperCase()));
  header("STATUS", s.live ? "LIVE" : s.complete ? "COMPLETE" : "INCOMPLETE");
  header("FORK OF", s.forkOf && s.forkOf.slice(0, 8));
  if (s.title) { push(""); for (const l of wrap(`"${s.title}"`)) push(l); }
  if (s.live) { push(""); push(center("[ LIVE SESSION: STILL RUNNING ]")); }

  const used = new Set<Provenance>();
  let unavailable = 0, costShown = false;
  for (const section of ["hard", "coding", "lore"] as Section[]) {
    const shown = receipt.sections[section].filter((m) => m.value !== null && (!Array.isArray(m.value) || m.value.length > 0) && !(m.id === "toolCalls.byName" && Object.keys(m.value as object).length === 0));
    unavailable += receipt.sections[section].filter((m) => m.value === null).length;
    if (!shown.length) continue;
    push("");
    const title = `-- ${SECTION_TITLES[section]} `;
    push(`${title}${"-".repeat(Math.max(0, W - title.length))}`);
    for (const m of shown) {
      const { heading, rows: rs } = rows(m);
      used.add(m.provenance);
      if (m.id === "cost.apiEquivalent") costShown = true;
      if (heading) push(heading, { metricId: m.id, provenance: m.provenance });
      for (const r of rs) item(r.label, r.value, m.provenance, { metricId: m.id, provenance: m.provenance, value: r.value });
    }
  }

  push("");
  rule("=");
  if (unavailable) for (const l of wrap(`${unavailable} metric${unavailable === 1 ? "" : "s"} unavailable, not shown`)) push(l);
  for (const p of ["exact", "derived", "heuristic"] as Provenance[]) if (used.has(p)) push(LEGEND[p]);
  if (costShown) for (const l of wrap(COST_NOTE)) push(l);
  push(fit(`times: ${tz}`, W));
  push("");
  const pick = [...s.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % FOOTERS.length;
  push(center(FOOTERS[pick]!));
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
