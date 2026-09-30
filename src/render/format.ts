// Presentation vocabulary shared by renderers (docs/ARCHITECTURE.md §2 `format`): labels keyed by
// metric id, value formatting, microcopy. Nothing here computes a metric. Heuristic metrics get
// labels that say what they are ("DETECTED", "EST.") so wording never upgrades them to facts.
import type { MetricId, Provenance } from "../receipt/types.ts";

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
// Each legend line fits the narrowest receipt (28 columns).
export const LEGEND: Record<Provenance, string> = {
  exact: "plain    recorded directly",
  derived: "  *      computed from data",
  heuristic: "  ~      heuristic estimate",
};

// Footer microcopy: playful, makes no claims about the session. Must not use `~` or `*`.
export const FOOTERS = ["THANK YOU FOR SHIPPING", "NO REFUNDS ON TOKENS", "KEEP FOR YOUR RECORDS", "PRINTED LOCALLY. NOTHING UPLOADED."];
export const COST_NOTE = "API EQUIVALENT = these tokens at API list prices";

export const int = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function duration(ms: number): string {
  if (ms < 1000) return ms <= 0 ? "0s" : "<1s";
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

export const usd = (n: number) => (n === 0 ? "$0.00" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
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

// Terminal display width: wide East Asian and emoji code points take 2 columns, combining marks 0.
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

// Cut to at most `max` columns, marking the cut with "..".
export function fit(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let out = "";
  for (const ch of s) { if (displayWidth(out + ch) > max - 2) break; out += ch; }
  return `${out}..`;
}
