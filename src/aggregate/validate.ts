// Explicit, testable check of the HistoryReceipt JSON contract (schemaVersion 1). Returns a list of
// problems; empty means valid. The field allowlists are the privacy guarantee in code form: a
// HistoryReceipt can carry nothing beyond these fields.
import { HISTORY_METRIC_IDS, HISTORY_METRICS, HISTORY_SCHEMA_VERSION, type HistoryMetricId } from "./types.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown) => typeof v === "string" && v.length > 0;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown) => typeof v === "string" && DATE.test(v);
const keysOnly = (o: Obj, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));
const listOf = (item: (x: Obj) => boolean, keys: string[]) => (v: unknown) => Array.isArray(v) && v.every((x) => isObj(x) && keysOnly(x, keys) && item(x));

const VALUE: { [K in HistoryMetricId]: (v: unknown) => boolean } = Object.fromEntries(HISTORY_METRIC_IDS.map((id) => {
  const unit = HISTORY_METRICS[id].unit;
  return [id, unit === "ms" || unit === "tokens" || unit === "count" || unit === "lines" ? isCount : unit === "usd" ? (v: unknown) => isNum(v) && (v as number) >= 0 : () => false];
})) as never;
Object.assign(VALUE, {
  "agg.duration.wall": isNum, // a session's wall time may be negative with clock skew
  "agg.models": listOf((x) => isStr(x.model) && isCount(x.sessions), ["model", "sessions"]),
  "agg.toolCalls.byName": (v: unknown) => isObj(v) && Object.values(v).every(isCount),
  "agg.languages": listOf((x) => isStr(x.language) && isCount(x.lines), ["language", "lines"]),
  "agg.commands.topPrograms": listOf((x) => isStr(x.program) && isCount(x.count), ["program", "count"]),
  "agg.busiestDay": (v: unknown) => isObj(v) && keysOnly(v, ["date", "sessions"]) && isDate(v.date) && isCount(v.sessions),
  "agg.peakHour": (v: unknown) => isCount(v) && (v as number) < 24,
  "agg.streak": (v: unknown) => isObj(v) && keysOnly(v, ["days", "from", "to"]) && isCount(v.days) && isDate(v.from) && isDate(v.to),
  "agg.longestSession": (v: unknown) => isObj(v) && keysOnly(v, ["durationMs", "date"]) && isNum(v.durationMs) && (v.date === null || isDate(v.date)),
  "agg.rabbitHole": (v: unknown) => isObj(v) && keysOnly(v, ["toolCalls", "durationMs", "date"]) && isCount(v.toolCalls) && (v.durationMs === null || isNum(v.durationMs)) && (v.date === null || isDate(v.date)),
  "agg.longestTurn": (v: unknown) => isObj(v) && keysOnly(v, ["durationMs", "date"]) && isCount(v.durationMs) && (v.date === null || isDate(v.date)),
  "agg.errorStreak": (v: unknown) => isObj(v) && keysOnly(v, ["count", "date"]) && isCount(v.count) && (v.date === null || isDate(v.date)),
  "agg.cacheHitRate": (v: unknown) => isNum(v) && (v as number) >= 0 && (v as number) <= 1,
  "agg.topProjects": listOf((x) => isStr(x.project) && isCount(x.sessions), ["project", "sessions"]),
});

export function validateHistory(h: unknown): string[] {
  const errs: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };
  if (!isObj(h)) return ["history is not an object"];
  need(keysOnly(h, ["schemaVersion", "kind", "generatedAt", "generator", "context", "scope", "coverage", "sections", "warnings"]), "unknown top-level field");
  need(h.schemaVersion === HISTORY_SCHEMA_VERSION, "schemaVersion");
  need(h.kind === "history", "kind");
  need(typeof h.generatedAt === "string" && ISO.test(h.generatedAt), "generatedAt");
  need(isObj(h.generator) && keysOnly(h.generator, ["name", "version"]) && isStr(h.generator.name) && isStr(h.generator.version), "generator");
  need(isObj(h.context) && keysOnly(h.context, ["timeZone"]) && isStr(h.context.timeZone), "context");
  const s = h.scope;
  if (!isObj(s)) errs.push("scope");
  else {
    need(keysOnly(s, ["period", "since", "until", "projectKey"]), "scope: unknown field");
    need(s.period === "all" || s.period === "week" || s.period === "month", "scope.period");
    const bounded = s.period !== "all";
    for (const k of ["since", "until"]) need(bounded ? typeof s[k] === "string" && ISO.test(s[k] as string) : s[k] === null, `scope.${k}`);
    if (bounded && typeof s.since === "string" && typeof s.until === "string") need(s.since < s.until, "scope: since < until");
    need(s.projectKey === null || isStr(s.projectKey), "scope.projectKey");
  }
  const c = h.coverage;
  if (!isObj(c)) errs.push("coverage");
  else {
    need(keysOnly(c, ["sessions", "projects", "undated", "liveExcluded", "incomplete", "firstDate", "lastDate", "daysWithData", "daysInPeriod", "generatorVersions", "timeZones"]), "coverage: unknown field");
    for (const k of ["sessions", "projects", "undated", "liveExcluded", "incomplete", "daysWithData"]) need(isCount(c[k]), `coverage.${k}`);
    for (const k of ["firstDate", "lastDate"]) need(c[k] === null || isDate(c[k]), `coverage.${k}`);
    need(c.daysInPeriod === null || isCount(c.daysInPeriod), "coverage.daysInPeriod");
    for (const k of ["generatorVersions", "timeZones"]) need(Array.isArray(c[k]) && (c[k] as unknown[]).every(isStr), `coverage.${k}`);
    if (isCount(c.sessions) && isCount(c.incomplete)) need((c.incomplete as number) <= (c.sessions as number), "coverage: incomplete > sessions");
  }
  need(Array.isArray(h.warnings) && h.warnings.every((w) => isObj(w) && keysOnly(w, ["code", "count"]) && isStr(w.code) && isCount(w.count)), "warnings");
  if (!isObj(h.sections)) return [...errs, "sections"];
  need(Object.keys(h.sections).sort().join() === "coding,hard,lore", "sections keys");
  const seen = new Set<string>();
  const sessions = isObj(c) && isCount(c.sessions) ? (c.sessions as number) : -1;
  for (const [section, list] of Object.entries(h.sections)) {
    if (!Array.isArray(list)) { errs.push(`sections.${section}`); continue; }
    for (const m of list) {
      if (!isObj(m) || typeof m.id !== "string" || !(m.id in HISTORY_METRICS)) { errs.push(`${section}: unknown metric ${isObj(m) ? String(m.id) : "?"}`); continue; }
      const id = m.id as HistoryMetricId, def = HISTORY_METRICS[id], at = `${section}.${id}`;
      need(!seen.has(id), `${at}: duplicate`);
      seen.add(id);
      need(def.section === section, `${at}: wrong section`);
      need(m.provenance === "exact" || m.provenance === "derived" || m.provenance === "heuristic", `${at}: provenance`);
      need(m.unit === def.unit, `${at}: unit`);
      need((m.sensitive === true) === (def.sensitive === true), `${at}: sensitive`);
      need(m.detail === undefined || isObj(m.detail), `${at}: detail`);
      const cov = m.covered;
      need(isObj(cov) && keysOnly(cov, ["sessions", "of"]) && isCount(cov.sessions) && isCount(cov.of) && (cov.sessions as number) <= (cov.of as number) && cov.of === sessions, `${at}: covered`);
      if (m.value === null) need(isStr(m.unavailableReason), `${at}: null without reason`);
      else {
        need(m.unavailableReason === undefined, `${at}: reason on a present value`);
        need(VALUE[id](m.value), `${at}: value shape`);
        need(isObj(cov) && (cov.sessions as number) > 0, `${at}: a value with no contributing session`);
      }
      need(keysOnly(m, ["id", "provenance", "value", "unit", "covered", "unavailableReason", "sensitive", "detail"]), `${at}: unknown field`);
    }
  }
  for (const id of HISTORY_METRIC_IDS) need(seen.has(id), `missing metric ${id}`);
  return errs;
}
