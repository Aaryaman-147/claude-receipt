// The Receipt: output of analytics, input of every renderer and of the archive.
// Semantic data only (docs/ARCHITECTURE.md §4): values may be numbers, strings or small
// structures, never labels, formatted values, microcopy or layout. Metric definitions:
// docs/METRICS.md. Breaking changes to this file require RECEIPT_SCHEMA_VERSION + 1.

export const RECEIPT_SCHEMA_VERSION = 1;
export const GENERATOR = { name: "claude-receipt", version: "0.2.0" } as const; // = package.json version (tested)

export type Provenance = "exact" | "derived" | "heuristic";
export type Unit = "ms" | "tokens" | "usd" | "count" | "lines" | "hour" | "ratio";
export type Section = "hard" | "coding" | "lore";

// The value type of every metric id. `null` (with unavailableReason) is always allowed.
export interface MetricValueMap {
  "session.duration.wall": number;
  "session.duration.active": number;
  "session.duration.open": number;
  "session.runs": number;
  "api.duration": number;
  "models.used": string[];
  "tokens.input": number;
  "tokens.output": number;
  "tokens.cacheRead": number;
  "tokens.cacheWrite": number;
  "cost.apiEquivalent": number; // API-equivalent USD, never money spent
  "prompts.count": number;
  "toolCalls.count": number;
  "toolCalls.byName": Record<string, number>;
  "turns.count": number;
  "files.read": number;
  "files.created": number;
  "files.edited": number;
  "lines.added": number;
  "lines.removed": number;
  "files.mostEdited": string; // a path
  "languages": { language: string; lines: number; files: number }[];
  "commands.count": number;
  "commands.topPrograms": { program: string; count: number }[];
  "tests.runs": number;
  "errors.toolErrors": number;
  "interruptions": number;
  "commits.byClaude": number;
  "commits.inWindow": number;
  "commits.coAuthored": number;
  "git.lines": { added: number; removed: number };
  "lore.rabbitHole": { promptIndex: number; toolCalls: number; durationMs: number | null };
  "lore.longestTurn": number;
  "lore.peakHour": number; // 0-23, local time in Receipt.context.timeZone
  "lore.errorStreak": number;
  "lore.readEditRatio": number;
  "lore.cacheHitRate": number; // 0-1
}
export type MetricId = keyof MetricValueMap;

export interface MetricOf<K extends MetricId> {
  id: K;
  provenance: Provenance; // of the value (or of the value it would have had)
  value: MetricValueMap[K] | null;
  unit?: Unit;
  unavailableReason?: string; // present exactly when value is null
  sensitive?: true; // paths, names: renderers redact in exports (PRIVACY.md §6)
  detail?: Record<string, unknown>; // structured extras (JSON-safe), never prose
}
export type Metric = { [K in MetricId]: MetricOf<K> }[MetricId];

// Registry: where each metric lives, its unit, whether it's sensitive. Order = rendering order.
export const METRICS: { [K in MetricId]: { section: Section; unit?: Unit; sensitive?: true } } = {
  "session.duration.wall": { section: "hard", unit: "ms" },
  "session.duration.active": { section: "hard", unit: "ms" },
  "session.duration.open": { section: "hard", unit: "ms" },
  "session.runs": { section: "hard", unit: "count" },
  "api.duration": { section: "hard", unit: "ms" },
  "models.used": { section: "hard" },
  "tokens.input": { section: "hard", unit: "tokens" },
  "tokens.output": { section: "hard", unit: "tokens" },
  "tokens.cacheRead": { section: "hard", unit: "tokens" },
  "tokens.cacheWrite": { section: "hard", unit: "tokens" },
  "cost.apiEquivalent": { section: "hard", unit: "usd" },
  "prompts.count": { section: "hard", unit: "count" },
  "toolCalls.count": { section: "hard", unit: "count" },
  "toolCalls.byName": { section: "hard", sensitive: true },
  "turns.count": { section: "hard", unit: "count" },
  "files.read": { section: "coding", unit: "count" },
  "files.created": { section: "coding", unit: "count" },
  "files.edited": { section: "coding", unit: "count" },
  "lines.added": { section: "coding", unit: "lines" },
  "lines.removed": { section: "coding", unit: "lines" },
  "files.mostEdited": { section: "coding", sensitive: true },
  "languages": { section: "coding" },
  "commands.count": { section: "coding", unit: "count" },
  "commands.topPrograms": { section: "coding" },
  "tests.runs": { section: "coding", unit: "count" },
  "errors.toolErrors": { section: "coding", unit: "count" },
  "interruptions": { section: "coding", unit: "count" },
  "commits.byClaude": { section: "coding", unit: "count" },
  "commits.inWindow": { section: "coding", unit: "count" },
  "commits.coAuthored": { section: "coding", unit: "count" },
  "git.lines": { section: "coding", unit: "lines" },
  "lore.rabbitHole": { section: "lore" },
  "lore.longestTurn": { section: "lore", unit: "ms" },
  "lore.peakHour": { section: "lore", unit: "hour" },
  "lore.errorStreak": { section: "lore", unit: "count" },
  "lore.readEditRatio": { section: "lore", unit: "ratio" },
  "lore.cacheHitRate": { section: "lore", unit: "ratio" },
};
export const METRIC_IDS = Object.keys(METRICS) as MetricId[];

export interface ReceiptSession {
  id: string;
  sourceSchemaVersion: number; // Session schema the receipt was computed from
  project: string | null; // project name (basename of cwd)
  projectKey: string | null; // grouping key for aggregation
  cwd: string | null;
  entrypoint: string | null;
  title: string | null; // display only: never archived, removed on export
  startedAt: string | null;
  endedAt: string | null;
  live: boolean;
  complete: boolean;
  forkOf: string | null; // parent session id when this session is a fork
  clientVersions: string[];
}

export interface Receipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  kind: "session"; // later: "project" | "week" | "month" | "wrapped"
  generatedAt: string;
  generator: { name: string; version: string; pricingTableDate: string };
  context: { timeZone: string }; // local-time metrics (peak hour) use this zone
  session: ReceiptSession;
  sections: Record<Section, Metric[]>;
  warnings: { code: string; count: number }[];
}
