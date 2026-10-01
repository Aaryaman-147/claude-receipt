// Session Receipts → HistoryReceipt (v0.2, docs/METRICS.md → Historical metrics). Pure: no I/O, no
// clock (the caller passes `now` and the viewer's zone), no transcripts, no rendering. Inputs are
// the CLI's candidate pool: archived and freshly built Receipts, at most one per session id.
//
// Rules: live sessions are never aggregated (counted as excluded); a session belongs to the period
// containing its startedAt (local calendar days in the viewer's zone); undated sessions count only
// in "all"; sums cover the sessions that have a value and are never extrapolated; a metric no
// session has is null, never 0; provenance is the weakest of the contributing inputs.
import type { Metric, MetricId, MetricValueMap, Provenance, Receipt } from "../receipt/types.ts";
import { GENERATOR } from "../receipt/types.ts";
import {
  HISTORY_METRIC_IDS, HISTORY_METRICS, HISTORY_SCHEMA_VERSION,
  type HistoryCoverage, type HistoryMetric, type HistoryMetricId, type HistoryReceipt, type HistoryScope, type HistoryValueMap, type Period,
} from "./types.ts";

export interface AggregateOptions {
  period: Period;
  now: Date; // the viewer's clock, passed in
  timeZone: string; // the viewer's zone
  projectKey?: string | null; // --project
}

const RANK: Record<Provenance, number> = { exact: 0, derived: 1, heuristic: 2 };
const weakest = (ps: Provenance[]): Provenance => ps.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));

// ---- calendar (local days in an IANA zone, without a date library) ----
const dayFormats = new Map<string, Intl.DateTimeFormat>();
const partsFormats = new Map<string, Intl.DateTimeFormat>();
export function localDate(t: Date | string, timeZone: string): string {
  let f = dayFormats.get(timeZone);
  if (!f) dayFormats.set(timeZone, (f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f.format(typeof t === "string" ? new Date(t) : t); // YYYY-MM-DD
}
const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
// The zone's offset (ms) at instant t: local wall time read as UTC, minus t.
function offsetAt(t: number, timeZone: string): number {
  let f = partsFormats.get(timeZone);
  if (!f) partsFormats.set(timeZone, (f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })));
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!) - Math.floor(t / 1000) * 1000;
}
// The first instant of a local calendar day, as UTC. Handles DST days that skip or repeat midnight.
export function startOfLocalDay(date: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const a = guess - offsetAt(guess, timeZone), b = guess - offsetAt(a, timeZone);
  const onDay = [a, b].filter((t) => localDate(new Date(t), timeZone) === date).sort((x, z) => x - z);
  return new Date(onDay[0] ?? Math.max(a, b));
}

// The UTC bounds of a period: "week" = the last 7 local calendar days including today, "month" = the
// last 30. [since, until): until is the local midnight after today.
export function periodBounds(period: Period, now: Date, timeZone: string): { since: string | null; until: string | null; days: number | null } {
  if (period === "all") return { since: null, until: null, days: null };
  const days = period === "week" ? 7 : 30;
  const today = localDate(now, timeZone);
  return { since: startOfLocalDay(addDays(today, 1 - days), timeZone).toISOString(), until: startOfLocalDay(addDays(today, 1), timeZone).toISOString(), days };
}

// ---- helpers over the aggregated sessions ----
type Row = { r: Receipt; date: string | null; m: Map<MetricId, Metric> };
const valueOf = <K extends MetricId>(row: Row, id: K) => row.m.get(id) as { value: MetricValueMap[K] | null; provenance: Provenance; detail?: Record<string, unknown> } | undefined;

function build<K extends HistoryMetricId>(id: K, of: number, value: HistoryValueMap[K] | null, inputs: Provenance[], covered: number,
  extra: { reason?: string; detail?: Record<string, unknown> } = {}): HistoryMetric {
  const def = HISTORY_METRICS[id];
  return {
    id, provenance: weakest([def.base, ...inputs]), value,
    ...(def.unit ? { unit: def.unit } : {}),
    covered: { sessions: covered, of },
    ...(value === null ? { unavailableReason: of === 0 ? "no sessions in scope" : extra.reason ?? "no session has this metric" } : {}),
    ...(def.sensitive ? { sensitive: def.sensitive } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
  } as HistoryMetric;
}

// The sessions that have a non-null value for `id`.
function having<K extends MetricId>(rows: Row[], id: K) {
  return rows.flatMap((row) => { const x = valueOf(row, id); return x && x.value !== null ? [{ row, value: x.value as MetricValueMap[K], provenance: x.provenance, detail: x.detail }] : []; });
}

function sum(rows: Row[], id: Extract<MetricId, keyof { [K in MetricId as MetricValueMap[K] extends number ? K : never]: 1 }>, to: HistoryMetricId): HistoryMetric {
  const xs = having(rows, id);
  return build(to, rows.length, xs.length ? xs.reduce((n, x) => n + (x.value as number), 0) : null, xs.map((x) => x.provenance), xs.length);
}

// The largest value of a per-session record; ties go to the earliest session (rows are in start order).
function record<K extends MetricId, H extends HistoryMetricId>(rows: Row[], id: K, to: H, size: (v: MetricValueMap[K]) => number, shape: (v: MetricValueMap[K], row: Row) => HistoryValueMap[H]): HistoryMetric {
  const xs = having(rows, id);
  const best = xs.reduce<(typeof xs)[number] | null>((b, x) => (b === null || size(x.value) > size(b.value) ? x : b), null);
  return build(to, rows.length, best ? shape(best.value, best.row) : null, xs.map((x) => x.provenance), xs.length);
}

const ranked = <T>(m: Map<string, number>, make: (key: string, n: number) => T) =>
  [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => make(k, n));

export function aggregate(receipts: Receipt[], opts: AggregateOptions): HistoryReceipt {
  const { period, now, timeZone } = opts;
  const projectKey = opts.projectKey ?? null;
  const bounds = periodBounds(period, now, timeZone);
  const warnings = new Map<string, number>();
  const warn = (code: string, n = 1) => warnings.set(code, (warnings.get(code) ?? 0) + n);

  // one Receipt per session id: the pool is keyed by id already, so a duplicate means a caller bug;
  // keep the latest-ending one and say so
  const byId = new Map<string, Receipt>();
  for (const r of receipts) {
    const prev = byId.get(r.session.id);
    if (prev) warn("duplicate-session");
    if (!prev || (r.session.endedAt ?? "") > (prev.session.endedAt ?? "")) byId.set(r.session.id, r);
  }

  const inProject = [...byId.values()].filter((r) => projectKey === null || r.session.projectKey === projectKey);
  const liveExcluded = inProject.filter((r) => r.session.live).length;
  const finished = inProject.filter((r) => !r.session.live);
  const undated = finished.filter((r) => !r.session.startedAt).length;
  const inPeriod = finished.filter((r) => {
    if (period === "all") return true;
    const t = r.session.startedAt;
    return t !== null && t >= bounds.since! && t < bounds.until!;
  });
  const rows: Row[] = inPeriod
    .map((r) => ({ r, date: r.session.startedAt ? localDate(r.session.startedAt, timeZone) : null, m: new Map(Object.values(r.sections).flat().map((m) => [m.id, m])) }))
    .sort((a, b) => (a.r.session.startedAt ?? "").localeCompare(b.r.session.startedAt ?? "") || a.r.session.id.localeCompare(b.r.session.id));
  const n = rows.length;

  // ---- coverage ----
  const dates = [...new Set(rows.map((x) => x.date).filter((d): d is string => d !== null))].sort();
  const zones = [...new Set(rows.map((x) => x.r.context.timeZone))].sort();
  if (zones.length > 1) warn("mixed-time-zones", zones.length);
  const coverage: HistoryCoverage = {
    sessions: n,
    projects: new Set(rows.map((x) => x.r.session.projectKey).filter((k) => k !== null)).size,
    undated,
    liveExcluded,
    incomplete: rows.filter((x) => !x.r.session.complete).length,
    firstDate: dates[0] ?? null,
    lastDate: dates.at(-1) ?? null,
    daysWithData: dates.length,
    daysInPeriod: bounds.days ?? (dates.length ? Math.round((Date.parse(dates.at(-1)!) - Date.parse(dates[0]!)) / 86_400_000) + 1 : null),
    generatorVersions: [...new Set(rows.map((x) => x.r.generator.version))].sort(),
    timeZones: zones,
  };

  const metrics: HistoryMetric[] = [];
  const add = (m: HistoryMetric) => metrics.push(m);

  // ---- hard ----
  add(sum(rows, "session.duration.wall", "agg.duration.wall"));
  add(sum(rows, "session.duration.active", "agg.duration.active"));
  add(sum(rows, "api.duration", "agg.api.duration"));
  {
    const xs = having(rows, "models.used");
    const counts = new Map<string, number>();
    for (const x of xs) for (const mdl of new Set(x.value)) counts.set(mdl, (counts.get(mdl) ?? 0) + 1);
    add(build("agg.models", n, xs.length ? ranked(counts, (model, s) => ({ model, sessions: s })) : null, xs.map((x) => x.provenance), xs.length));
  }
  add(sum(rows, "tokens.input", "agg.tokens.input"));
  add(sum(rows, "tokens.output", "agg.tokens.output"));
  add(sum(rows, "tokens.cacheRead", "agg.tokens.cacheRead"));
  add(sum(rows, "tokens.cacheWrite", "agg.tokens.cacheWrite"));
  add(sum(rows, "cost.apiEquivalent", "agg.cost.apiEquivalent"));
  add(sum(rows, "prompts.count", "agg.prompts"));
  add(sum(rows, "toolCalls.count", "agg.toolCalls"));
  {
    const xs = having(rows, "toolCalls.byName");
    const total = new Map<string, number>();
    for (const x of xs) for (const [k, v] of Object.entries(x.value)) total.set(k, (total.get(k) ?? 0) + v);
    add(build("agg.toolCalls.byName", n, xs.length ? Object.fromEntries(ranked(total, (k, v) => [k, v] as const)) : null, xs.map((x) => x.provenance), xs.length));
  }
  add(sum(rows, "turns.count", "agg.turns"));

  // ---- coding ----
  add(sum(rows, "lines.added", "agg.lines.added"));
  add(sum(rows, "lines.removed", "agg.lines.removed"));
  {
    // lines only: a session's per-language file count is of distinct files and doesn't add up
    const xs = having(rows, "languages");
    const lines = new Map<string, number>();
    for (const x of xs) for (const l of x.value) lines.set(l.language, (lines.get(l.language) ?? 0) + l.lines);
    add(build("agg.languages", n, xs.length ? ranked(lines, (language, l) => ({ language, lines: l })) : null, xs.map((x) => x.provenance), xs.length, { detail: { weighting: "lines changed" } }));
  }
  add(sum(rows, "commands.count", "agg.commands.count"));
  {
    const xs = having(rows, "commands.topPrograms");
    const counts = new Map<string, number>();
    for (const x of xs) for (const p of x.value) counts.set(p.program, (counts.get(p.program) ?? 0) + p.count);
    add(build("agg.commands.topPrograms", n, xs.length ? ranked(counts, (program, c) => ({ program, count: c })) : null, xs.map((x) => x.provenance), xs.length));
  }
  add(sum(rows, "tests.runs", "agg.tests.runs"));
  add(sum(rows, "errors.toolErrors", "agg.errors.toolErrors"));
  add(sum(rows, "interruptions", "agg.interruptions"));
  add(sum(rows, "commits.byClaude", "agg.commits.byClaude"));

  // ---- lore ----
  {
    // calendar patterns use exact start times, so they are derived; undated sessions don't take part
    const dated = rows.filter((x) => x.date !== null);
    const perDay = new Map<string, number>();
    for (const x of dated) perDay.set(x.date!, (perDay.get(x.date!) ?? 0) + 1);
    const busiest = ranked(perDay, (date, s) => ({ date, sessions: s }))[0] ?? null; // most sessions, then the earliest date
    add(build("agg.busiestDay", n, busiest, [], dated.length, { reason: "no dated sessions" }));
  }
  {
    // the sessions' own hour histograms (detail.byHour, kept even when their peak is null), summed
    const xs = rows.flatMap((row) => {
      const m = row.m.get("lore.peakHour");
      const h = m?.detail?.byHour;
      return Array.isArray(h) && h.length === 24 && h.every((c) => Number.isInteger(c) && c >= 0) ? [{ byHour: h as number[], provenance: m!.provenance }] : [];
    });
    const byHour = Array<number>(24).fill(0);
    for (const x of xs) x.byHour.forEach((c, i) => (byHour[i]! += c));
    const total = byHour.reduce((a, b) => a + b, 0);
    add(build("agg.peakHour", n, total ? byHour.indexOf(Math.max(...byHour)) : null, xs.map((x) => x.provenance), xs.length,
      { reason: "no session recorded hourly activity", ...(total ? { detail: { byHour, timeZones: zones } } : {}) }));
  }
  {
    let best: { days: number; from: string; to: string } | null = null, from = "", prev = "", days = 0;
    for (const d of dates) {
      if (prev && addDays(prev, 1) === d) days++; else { days = 1; from = d; }
      prev = d;
      if (!best || days > best.days) best = { days, from, to: d };
    }
    add(build("agg.streak", n, best, [], rows.filter((x) => x.date !== null).length, { reason: "no dated sessions" }));
  }
  add(record(rows, "session.duration.wall", "agg.longestSession", (v) => v, (v, row) => ({ durationMs: v, date: row.date })));
  add(record(rows, "lore.rabbitHole", "agg.rabbitHole", (v) => v.toolCalls, (v, row) => ({ toolCalls: v.toolCalls, durationMs: v.durationMs, date: row.date })));
  add(record(rows, "lore.longestTurn", "agg.longestTurn", (v) => v, (v, row) => ({ durationMs: v, date: row.date })));
  add(record(rows, "lore.errorStreak", "agg.errorStreak", (v) => v, (v, row) => ({ count: v, date: row.date })));
  {
    // recomputed from summed tokens (never an average of ratios), over sessions with all four
    const ids = ["tokens.input", "tokens.cacheRead", "tokens.cacheWrite"] as const;
    const xs = rows.filter((row) => ids.every((id) => valueOf(row, id)?.value != null));
    const t = (id: (typeof ids)[number]) => xs.reduce((s, row) => s + (valueOf(row, id)!.value as number), 0);
    const denom = t("tokens.input") + t("tokens.cacheRead") + t("tokens.cacheWrite");
    add(build("agg.cacheHitRate", n, xs.length && denom ? t("tokens.cacheRead") / denom : null, xs.flatMap((row) => ids.map((id) => valueOf(row, id)!.provenance)), xs.length,
      { reason: "no session has token counts" }));
  }
  {
    const named = rows.filter((x) => x.r.session.projectKey !== null && x.r.session.project !== null);
    const counts = new Map<string, number>(), names = new Map<string, string>();
    for (const x of named) { counts.set(x.r.session.projectKey!, (counts.get(x.r.session.projectKey!) ?? 0) + 1); names.set(x.r.session.projectKey!, x.r.session.project!); }
    add(build("agg.topProjects", n, named.length ? ranked(counts, (key, s) => ({ project: names.get(key)!, sessions: s })) : null, [], named.length, { reason: "no session has a project" }));
  }

  const scope: HistoryScope = { period, since: bounds.since, until: bounds.until, projectKey, projectFilter: projectKey !== null };
  const order = new Map(HISTORY_METRIC_IDS.map((id, i) => [id, i]));
  const of = (section: "hard" | "coding" | "lore") => metrics.filter((m) => HISTORY_METRICS[m.id].section === section).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    kind: "history",
    generatedAt: now.toISOString(),
    generator: { name: GENERATOR.name, version: GENERATOR.version },
    context: { timeZone },
    scope,
    coverage,
    sections: { hard: of("hard"), coding: of("coding"), lore: of("lore") },
    warnings: [...warnings].sort((a, b) => a[0].localeCompare(b[0])).map(([code, count]) => ({ code, count })),
  };
}
