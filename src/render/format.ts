// Presentation vocabulary shared by every renderer (docs/ARCHITECTURE.md §2 `format`): labels keyed
// by metric id, value formatting, identity rows, provenance marks, copy and display width. The
// terminal and the visual receipt both take their words and numbers from here, so they always say
// the same thing. Nothing here computes a metric. Heuristic metrics get labels that say what they
// are ("DETECTED", "EST.") so wording never upgrades them to facts.
import type { Metric, MetricId, Provenance, Receipt } from "../receipt/types.ts";

export const LABELS: Record<MetricId, string> = {
  "session.duration.wall": "DURATION",
  "session.duration.active": "ACTIVE TIME (EST.)",
  "session.duration.open": "CLAUDE CODE OPEN",
  "session.runs": "RUNS",
  "api.duration": "CLAUDE WORKING",
  "models.used": "MODELS",
  "tokens.input": "TOKENS IN",
  "tokens.output": "TOKENS OUT",
  "tokens.cacheRead": "CACHE READ",
  "tokens.cacheWrite": "CACHE WRITE",
  "cost.apiEquivalent": "API EQUIVALENT",
  "prompts.count": "PROMPTS",
  "toolCalls.count": "TOOL CALLS",
  "toolCalls.byName": "TOP TOOLS",
  "turns.count": "TURNS",
  "files.read": "FILES READ",
  "files.created": "FILES CREATED",
  "files.edited": "FILES EDITED",
  "lines.added": "LINES ADDED",
  "lines.removed": "LINES REMOVED",
  "files.mostEdited": "MOST EDITED",
  "languages": "LANGUAGES",
  "commands.count": "SHELL COMMANDS",
  "commands.topPrograms": "TOP PROGRAMS",
  "tests.runs": "TEST RUNS DETECTED",
  "errors.toolErrors": "TOOL ERRORS",
  "interruptions": "INTERRUPTED TOOL RUNS",
  "commits.byClaude": "CLAUDE COMMITS DETECTED",
  "commits.inWindow": "COMMITS IN WINDOW",
  "commits.coAuthored": "CO-AUTHORED BY CLAUDE",
  "git.lines": "GIT LINES",
  "lore.rabbitHole": "BIGGEST RABBIT HOLE",
  "lore.longestTurn": "LONGEST TURN",
  "lore.peakHour": "PEAK HOUR",
  "lore.errorStreak": "LONGEST ERROR STREAK",
  "lore.readEditRatio": "READS PER EDIT",
  "lore.cacheHitRate": "CACHE HIT RATE",
};

export const SECTION_TITLES = { hard: "HARD STATS", coding: "CODING STATS", lore: "SESSION LORE" } as const;

// The only marks, and what they mean (docs/METRICS.md → Rendering rule).
export const MARK = { derived: " *", heuristicPrefix: "~" } as const;
export const markFor = (p: Provenance): "" | "*" | "~" => (p === "derived" ? "*" : p === "heuristic" ? "~" : "");
// Each legend line fits the narrowest receipt (28 columns).
export const LEGEND: Record<Provenance, string> = {
  exact: "plain    recorded directly",
  derived: "  *      computed from data",
  heuristic: "  ~      heuristic estimate",
};

// Copy. Playful, makes no claims about the session. Footers must not use `~` or `*`.
export const TITLE = "CLAUDE RECEIPT";
export const SUBTITLE = "itemized session record";
export const LIVE_TERMINAL = "[ LIVE SESSION: STILL RUNNING ]";
export const LIVE_BAND = "LIVE · STILL RUNNING";
export const FOOTERS = ["THANK YOU FOR SHIPPING", "NO REFUNDS ON TOKENS", "KEEP FOR YOUR RECORDS", "PRINTED LOCALLY. NOTHING UPLOADED."];
export const COST_NOTE = "API EQUIVALENT = these tokens at API list prices";
export const unavailableText = (n: number) => `${n} metric${n === 1 ? "" : "s"} unavailable, not shown`;
export const timesText = (timeZone: string) => `times: ${timeZone}`;
// Deterministic per session.
export const footerFor = (sessionId: string) => FOOTERS[[...sessionId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % FOOTERS.length]!;

export const int = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function duration(ms: number): string {
  if (ms < 1000) return ms <= 0 ? "0s" : "<1s";
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

export function usd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  const [whole, cents] = n.toFixed(2).split(".");
  return `$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}
export const pct = (r: number) => `${Math.round(r * 100)}%`;
export const ratio = (r: number) => (Number.isInteger(r) ? String(r) : r.toFixed(1));
export const hour = (h: number) => `${String(h).padStart(2, "0")}:00`;
// "claude-haiku-4-5-20251001" → "haiku-4-5"
export const model = (id: string) => id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
export const basename = (path: string) => path.split(/[\\/]/).pop() || path;

const dateParts = new Map<string, Intl.DateTimeFormat>();
export function localTime(iso: string, timeZone: string): string {
  let f = dateParts.get(timeZone);
  if (!f) dateParts.set(timeZone, (f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })));
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Display width in grid columns: wide East Asian and emoji code points take 2, combining marks 0.
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x300 && c <= 0x36f) || (c >= 0xfe00 && c <= 0xfe0f) || c === 0x200d) continue;
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1;
  }
  return w;
}

// Cut to at most `max` columns, marking the cut (the terminal uses "..", the image "…").
export function fit(s: string, max: number, ellipsis = ".."): string {
  if (displayWidth(s) <= max) return s;
  let out = "";
  for (const ch of s) { if (displayWidth(out + ch) > max - displayWidth(ellipsis)) break; out += ch; }
  return `${out}${ellipsis}`;
}

// Word-wrap to `width` columns; a word longer than a line is cut with `ellipsis`.
export function wrapWords(text: string, width: number, ellipsis = ".."): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (displayWidth(next) <= width) cur = next;
    else { if (cur) lines.push(cur); cur = fit(word, width, ellipsis); }
  }
  if (cur) lines.push(cur);
  return lines;
}

// A metric is shown when it has a value and isn't an empty list or map.
export const isShown = (m: Metric) =>
  m.value !== null && (!Array.isArray(m.value) || m.value.length > 0) && !(m.id === "toolCalls.byName" && Object.keys(m.value as object).length === 0);

export interface Row { label: string; value: string }
const top = <T>(xs: T[], n = 3) => xs.slice(0, n);

// One or more {label, value} rows per shown metric. A list metric is a heading plus indented rows.
export function metricRows(m: Metric): { heading?: string; rows: Row[] } {
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
    case "models.used": return { heading: label, rows: top(m.value!, 5).map((id) => ({ label: `  ${model(id)}`, value: "" })) };
    case "toolCalls.byName":
      return { heading: label, rows: top(Object.entries(m.value!).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))).map(([name, n]) => ({ label: `  ${name}`, value: int(n) })) };
    case "languages": return { heading: label, rows: top(m.value!).map((l) => ({ label: `  ${l.language}`, value: `${int(l.lines)} lines` })) };
    case "commands.topPrograms": return { heading: label, rows: top(m.value!).map((p) => ({ label: `  ${p.program}`, value: int(p.count) })) };
    default: return one(int(m.value as number));
  }
}

const ENTRY: Record<string, string> = { cli: "CLI", "sdk-cli": "HEADLESS", "claude-desktop": "DESKTOP" };

// The identity block, in order, skipping fields the Receipt doesn't have (or that redaction removed).
export function identityRows(s: Receipt["session"], timeZone: string): Row[] {
  const rows: [string, string | null][] = [
    ["SESSION", s.id.slice(0, 8)],
    ["PROJECT", s.project],
    ["STARTED", s.startedAt && localTime(s.startedAt, timeZone)],
    ["ENDED", s.endedAt && localTime(s.endedAt, timeZone)],
    ["ENTRY", s.entrypoint && (ENTRY[s.entrypoint] ?? s.entrypoint.toUpperCase())],
    ["STATUS", s.live ? "LIVE" : s.complete ? "COMPLETE" : "INCOMPLETE"],
    ["FORK OF", s.forkOf && s.forkOf.slice(0, 8)],
  ];
  return rows.filter((r): r is [string, string] => !!r[1]).map(([label, value]) => ({ label, value }));
}
