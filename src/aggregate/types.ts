// The HistoryReceipt: what happened across many sessions (v0.2, roadmap M5). A separate model from
// the session Receipt, which it never changes or overloads. Semantic data only, like the Receipt:
// no labels, formatting or copy. Built only from session Receipts (src/aggregate/index.ts), so it
// can hold nothing a Receipt doesn't: no prompts, responses, tool output, commands or ids beyond
// the scope's project key. Metric definitions: docs/METRICS.md → Historical metrics.
import type { Provenance, Section, Unit } from "../receipt/types.ts";

export const HISTORY_SCHEMA_VERSION = 1;

export type Period = "all" | "week" | "month";

export interface HistoryValueMap {
  // hard
  "agg.duration.wall": number;
  "agg.duration.active": number;
  "agg.api.duration": number;
  "agg.models": { model: string; sessions: number }[];
  "agg.tokens.input": number;
  "agg.tokens.output": number;
  "agg.tokens.cacheRead": number;
  "agg.tokens.cacheWrite": number;
  "agg.cost.apiEquivalent": number; // API-equivalent USD, never money spent
  "agg.prompts": number;
  "agg.toolCalls": number;
  "agg.toolCalls.byName": Record<string, number>;
  "agg.turns": number;
  // coding
  "agg.lines.added": number;
  "agg.lines.removed": number;
  "agg.languages": { language: string; lines: number }[];
  "agg.commands.count": number;
  "agg.commands.topPrograms": { program: string; count: number }[];
  "agg.tests.runs": number;
  "agg.errors.toolErrors": number;
  "agg.interruptions": number;
  "agg.commits.byClaude": number;
  // lore (dates are local calendar dates, YYYY-MM-DD, in HistoryReceipt.context.timeZone)
  "agg.busiestDay": { date: string; sessions: number };
  "agg.peakHour": number; // 0-23
  "agg.streak": { days: number; from: string; to: string };
  "agg.longestSession": { durationMs: number; date: string | null };
  "agg.rabbitHole": { toolCalls: number; durationMs: number | null; date: string | null };
  "agg.longestTurn": { durationMs: number; date: string | null };
  "agg.errorStreak": { count: number; date: string | null };
  "agg.cacheHitRate": number; // 0-1
  "agg.topProjects": { project: string; sessions: number }[];
}
export type HistoryMetricId = keyof HistoryValueMap;

export interface HistoryMetricOf<K extends HistoryMetricId> {
  id: K;
  provenance: Provenance; // the weakest of the inputs that produced the value (or would have)
  value: HistoryValueMap[K] | null;
  unit?: Unit;
  covered: { sessions: number; of: number }; // sessions that had an input value / sessions in scope
  unavailableReason?: string; // present exactly when value is null
  sensitive?: true;
  detail?: Record<string, unknown>;
}
export type HistoryMetric = { [K in HistoryMetricId]: HistoryMetricOf<K> }[HistoryMetricId];

// Registry: section, unit, sensitivity, and `base`: the strongest provenance the metric can have
// (its provenance with no inputs, and the floor it is weakened from). Order = rendering order.
export const HISTORY_METRICS: { [K in HistoryMetricId]: { section: Section; base: Provenance; unit?: Unit; sensitive?: true } } = {
  "agg.duration.wall": { section: "hard", base: "derived", unit: "ms" },
  "agg.duration.active": { section: "hard", base: "heuristic", unit: "ms" },
  "agg.api.duration": { section: "hard", base: "exact", unit: "ms" },
  "agg.models": { section: "hard", base: "exact" },
  "agg.tokens.input": { section: "hard", base: "exact", unit: "tokens" },
  "agg.tokens.output": { section: "hard", base: "exact", unit: "tokens" },
  "agg.tokens.cacheRead": { section: "hard", base: "exact", unit: "tokens" },
  "agg.tokens.cacheWrite": { section: "hard", base: "exact", unit: "tokens" },
  "agg.cost.apiEquivalent": { section: "hard", base: "exact", unit: "usd" },
  "agg.prompts": { section: "hard", base: "exact", unit: "count" },
  "agg.toolCalls": { section: "hard", base: "exact", unit: "count" },
  "agg.toolCalls.byName": { section: "hard", base: "exact", sensitive: true },
  "agg.turns": { section: "hard", base: "exact", unit: "count" },
  "agg.lines.added": { section: "coding", base: "derived", unit: "lines" },
  "agg.lines.removed": { section: "coding", base: "derived", unit: "lines" },
  "agg.languages": { section: "coding", base: "derived" },
  "agg.commands.count": { section: "coding", base: "exact", unit: "count" },
  "agg.commands.topPrograms": { section: "coding", base: "derived" },
  "agg.tests.runs": { section: "coding", base: "heuristic", unit: "count" },
  "agg.errors.toolErrors": { section: "coding", base: "exact", unit: "count" },
  "agg.interruptions": { section: "coding", base: "exact", unit: "count" },
  "agg.commits.byClaude": { section: "coding", base: "heuristic", unit: "count" },
  "agg.busiestDay": { section: "lore", base: "derived" },
  "agg.peakHour": { section: "lore", base: "derived", unit: "hour" },
  "agg.streak": { section: "lore", base: "derived" },
  "agg.longestSession": { section: "lore", base: "derived" },
  "agg.rabbitHole": { section: "lore", base: "derived" },
  "agg.longestTurn": { section: "lore", base: "derived" },
  "agg.errorStreak": { section: "lore", base: "derived" },
  "agg.cacheHitRate": { section: "lore", base: "derived", unit: "ratio" },
  "agg.topProjects": { section: "lore", base: "derived", sensitive: true },
};
export const HISTORY_METRIC_IDS = Object.keys(HISTORY_METRICS) as HistoryMetricId[];

export interface HistoryScope {
  period: Period;
  since: string | null; // UTC instant of the first local midnight in the period (null for "all")
  until: string | null; // UTC instant of the local midnight after the period (exclusive; null for "all")
  projectKey: string | null; // --project: only sessions with this key (a path: sensitive)
}

export interface HistoryCoverage {
  sessions: number; // finished sessions aggregated
  projects: number; // distinct project keys among them
  undated: number; // in scope but without a start time (counted in "all" only)
  liveExcluded: number; // still running, never aggregated
  incomplete: number; // aggregated, but their transcript ended without a clean close
  firstDate: string | null; // local dates of the first and last aggregated session start
  lastDate: string | null;
  daysWithData: number; // distinct local start dates among aggregated sessions
  daysInPeriod: number | null; // 7, 30, or the first..last span for "all" (null without dated sessions)
  generatorVersions: string[]; // of the session Receipts aggregated (definitions may differ between them)
  timeZones: string[]; // the zones those Receipts were computed in (their peak-hour histograms use them)
}

export interface HistoryReceipt {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  kind: "history";
  generatedAt: string;
  generator: { name: string; version: string };
  context: { timeZone: string }; // the viewer's zone: period boundaries and dates use it
  scope: HistoryScope;
  coverage: HistoryCoverage;
  sections: Record<Section, HistoryMetric[]>;
  warnings: { code: string; count: number }[];
}
