// Explicit, testable check of the Receipt JSON contract (schemaVersion 1). Returns a list of
// problems; empty means valid. Used by tests and available to any consumer of Receipt JSON.
import { METRIC_IDS, METRICS, RECEIPT_SCHEMA_VERSION, type MetricId } from "./types.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Shape of each non-null metric value.
const VALUE: { [K in MetricId]: (v: unknown) => boolean } = Object.fromEntries(METRIC_IDS.map((id) => {
  const unit = METRICS[id].unit;
  const byUnit = unit === "ms" || unit === "tokens" || unit === "count" || unit === "lines" ? isCount
    : unit === "hour" ? (v: unknown) => isCount(v) && (v as number) < 24
    : unit === "usd" ? (v: unknown) => isNum(v) && (v as number) >= 0
    : unit === "ratio" ? (v: unknown) => isNum(v) && (v as number) >= 0
    : () => false;
  return [id, byUnit];
})) as never;
Object.assign(VALUE, {
  "session.duration.wall": isNum, // clock skew could make it negative; still a number
  "models.used": (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  "toolCalls.byName": (v: unknown) => isObj(v) && Object.values(v).every(isCount),
  "files.mostEdited": (v: unknown) => typeof v === "string" && v.length > 0,
  "languages": (v: unknown) => Array.isArray(v) && v.every((x) => isObj(x) && typeof x.language === "string" && isCount(x.lines) && isCount(x.files)),
  "commands.topPrograms": (v: unknown) => Array.isArray(v) && v.every((x) => isObj(x) && typeof x.program === "string" && isCount(x.count)),
  "git.lines": (v: unknown) => isObj(v) && isCount(v.added) && isCount(v.removed),
  "lore.rabbitHole": (v: unknown) => isObj(v) && isCount(v.promptIndex) && isCount(v.toolCalls) && (v.durationMs === null || isNum(v.durationMs)),
  "lore.cacheHitRate": (v: unknown) => isNum(v) && (v as number) >= 0 && (v as number) <= 1,
});

export function validateReceipt(r: unknown): string[] {
  const errs: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };
  if (!isObj(r)) return ["receipt is not an object"];
  need(r.schemaVersion === RECEIPT_SCHEMA_VERSION, "schemaVersion");
  need(r.kind === "session", "kind");
  need(typeof r.generatedAt === "string" && ISO.test(r.generatedAt), "generatedAt");
  const g = r.generator;
  need(isObj(g) && typeof g.name === "string" && typeof g.version === "string" && typeof g.pricingTableDate === "string", "generator");
  need(isObj(r.context) && typeof r.context.timeZone === "string", "context.timeZone");
  const s = r.session;
  if (!isObj(s)) errs.push("session");
  else {
    need(typeof s.id === "string" && s.id.length > 0, "session.id");
    need(isCount(s.sourceSchemaVersion), "session.sourceSchemaVersion");
    for (const k of ["project", "projectKey", "cwd", "entrypoint", "title", "forkOf"]) need(isStrOrNull(s[k]), `session.${k}`);
    for (const k of ["startedAt", "endedAt"]) need(s[k] === null || (typeof s[k] === "string" && ISO.test(s[k] as string)), `session.${k}`);
    need(typeof s.live === "boolean" && typeof s.complete === "boolean", "session.live/complete");
    need(Array.isArray(s.clientVersions) && s.clientVersions.every((v) => typeof v === "string"), "session.clientVersions");
  }
  need(Array.isArray(r.warnings) && r.warnings.every((w) => isObj(w) && typeof w.code === "string" && isCount(w.count)), "warnings");
  if (!isObj(r.sections)) return [...errs, "sections"];
  need(Object.keys(r.sections).sort().join() === "coding,hard,lore", "sections keys");
  const seen = new Set<string>();
  for (const [section, list] of Object.entries(r.sections)) {
    if (!Array.isArray(list)) { errs.push(`sections.${section}`); continue; }
    for (const m of list) {
      if (!isObj(m) || typeof m.id !== "string" || !(m.id in METRICS)) { errs.push(`${section}: unknown metric ${isObj(m) ? String(m.id) : "?"}`); continue; }
      const id = m.id as MetricId, def = METRICS[id];
      const at = `${section}.${id}`;
      need(!seen.has(id), `${at}: duplicate`);
      seen.add(id);
      need(def.section === section, `${at}: wrong section`);
      need(m.provenance === "exact" || m.provenance === "derived" || m.provenance === "heuristic", `${at}: provenance`);
      need(m.unit === def.unit, `${at}: unit`);
      need((m.sensitive === true) === (def.sensitive === true), `${at}: sensitive`);
      need(m.detail === undefined || isObj(m.detail), `${at}: detail`);
      if (m.value === null) need(typeof m.unavailableReason === "string" && m.unavailableReason.length > 0, `${at}: null without reason`);
      else {
        need(m.unavailableReason === undefined, `${at}: reason on a present value`);
        need(VALUE[id](m.value), `${at}: value shape`);
      }
      need(Object.keys(m).every((k) => ["id", "provenance", "value", "unit", "unavailableReason", "sensitive", "detail"].includes(k)), `${at}: unknown field`);
    }
  }
  for (const id of METRIC_IDS) need(seen.has(id), `missing metric ${id}`);
  return errs;
}
