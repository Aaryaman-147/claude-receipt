// Analytics: Session (+ optional GitFacts) → Receipt. Pure: no I/O, no formatting.
// Every metric follows docs/METRICS.md: provenance on everything, null + reason when an
// input is missing (never 0), a heuristic input makes the result heuristic.
import type { GitCommit, GitFacts } from "../git/index.ts";
import { GIT_GRACE_MS } from "../git/index.ts";
import {
  GENERATOR, METRIC_IDS, METRICS, RECEIPT_SCHEMA_VERSION,
  type Metric, type MetricId, type MetricValueMap, type Provenance, type Receipt, type Section,
} from "../receipt/types.ts";
import { projectKey, tokensByModel, type CostState, type Session, type ToolCall } from "../source/claude-code/index.ts";
import { languageOf } from "./languages.ts";
import { PRICING, priceCalls, type PricingTable } from "./pricing.ts";

export interface ReceiptOptions {
  git?: GitFacts; // omitted = git enrichment not run
  timeZone?: string; // local-time metrics; default: the system zone
  now?: Date;
  pricing?: PricingTable;
  idleThresholdMs?: number;
}
export const IDLE_THRESHOLD_MS = 5 * 60_000;

const RANK: Record<Provenance, number> = { exact: 0, derived: 1, heuristic: 2 };
const weakest = (...p: Provenance[]): Provenance => p.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));

function metric<K extends MetricId>(id: K, provenance: Provenance, value: MetricValueMap[K] | null,
  extra: { reason?: string; detail?: Record<string, unknown> } = {}): Metric {
  const { unit, sensitive } = METRICS[id];
  return {
    id, provenance, value,
    ...(unit ? { unit } : {}),
    ...(value === null ? { unavailableReason: extra.reason ?? "unavailable" } : {}),
    ...(sensitive ? { sensitive } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
  } as Metric;
}

// M0/M1: Claude Code's cost-state is the complete total, but only for a finished, non-forked session.
function usableCostState(s: Session): { cs: CostState } | { reason: string } {
  if (!s.costState) return { reason: s.status.live ? "live session: no cost-state yet" : "no cost-state (session killed or never completed)" };
  if (s.fork) return { reason: "forked session: cost-state includes the parent's usage" };
  if (s.status.live || !s.runs.at(-1)?.closed) return { reason: "latest run has no cost-state yet" };
  return { cs: s.costState };
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const EDIT_OPS = new Set(["create", "update", "edit"]);
const count = <T>(items: T[], key: (t: T) => string) =>
  items.reduce<Record<string, number>>((acc, t) => ((acc[key(t)] = (acc[key(t)] ?? 0) + 1), acc), {});
const byTs = (a: { ts: string | null }, b: { ts: string | null }) => (a.ts ?? "").localeCompare(b.ts ?? "");

const hourFormats = new Map<string, Intl.DateTimeFormat>();
const localHour = (ts: string, timeZone: string) => {
  let f = hourFormats.get(timeZone);
  if (!f) hourFormats.set(timeZone, (f = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone })));
  return Number(f.format(new Date(ts))) % 24;
};

const GIT_REASONS: Record<Exclude<GitFacts["status"], "ok">, string> = {
  "no-cwd": "project directory not found",
  "no-window": "session has no timestamps",
  "not-a-repo": "project is not a git repository",
  "git-unavailable": "git is not installed",
  error: "git failed",
};

export function buildReceipt(s: Session, opts: ReceiptOptions = {}): Receipt {
  const timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const pricing = opts.pricing ?? PRICING;
  const metrics: Metric[] = [];
  const add = (m: Metric) => metrics.push(m);
  const warnings = new Map<string, number>(s.warnings.map((w) => [w.code, w.count]));
  const use = usableCostState(s);
  const cs = "cs" in use ? use.cs : null;
  const noCs = "reason" in use ? use.reason : "";

  // ---- hard stats ----
  const wallMs = s.startedAt && s.endedAt ? Date.parse(s.endedAt) - Date.parse(s.startedAt) : null;
  add(metric("session.duration.wall", "derived", wallMs, { reason: "no timestamped records" }));

  const stamps = [
    ...s.prompts, ...s.apiCalls, ...s.toolCalls, ...s.turns, ...s.slashCommands,
    ...s.runs.flatMap((r) => [{ ts: r.startedAt }, { ts: r.endedAt }]),
  ].map((x) => x.ts).filter((t): t is string => t !== null).map(Date.parse).sort((a, b) => a - b);
  const idle = opts.idleThresholdMs ?? IDLE_THRESHOLD_MS;
  const activeMs = stamps.length ? stamps.slice(1).reduce((sum, t, i) => sum + Math.min(t - stamps[i]!, idle), 0) : null;
  add(metric("session.duration.active", "heuristic", activeMs, { reason: "no timestamped activity", detail: { idleThresholdMs: idle } }));

  add(metric("session.duration.open", "exact", cs?.totalDurationMs ?? null, { reason: noCs }));
  add(metric("session.runs", "derived", s.runs.length, { detail: { closed: s.runs.filter((r) => r.closed).length } }));
  add(metric("api.duration", "exact", cs?.totalApiDurationMs ?? null, { reason: noCs, ...(cs ? { detail: { toolDurationMs: cs.totalToolDurationMs } } : {}) }));

  // Tokens: cost-state when usable (exact, includes auxiliary calls), else the transcript (derived).
  const own = tokensByModel(s.apiCalls);
  const tokenSource = cs ? "cost-state" : s.apiCalls.length ? "transcript" : null;
  const tokenProv: Provenance = cs ? "exact" : "derived";
  const tokenReason = `${noCs}; no API calls recorded`;
  const tokenFields = { "tokens.input": "input", "tokens.output": "output", "tokens.cacheRead": "cacheRead", "tokens.cacheWrite": "cacheWrite" } as const;
  const totals: Partial<Record<keyof typeof tokenFields, number>> = {};
  for (const [id, field] of Object.entries(tokenFields) as [keyof typeof tokenFields, typeof tokenFields[keyof typeof tokenFields]][]) {
    if (!tokenSource) { add(metric(id, tokenProv, null, { reason: tokenReason })); continue; }
    const byModel = Object.fromEntries(Object.entries(cs ? cs.byModel : own).map(([m, t]) => [m, t[field]]));
    totals[id] = Object.values(byModel).reduce((a, b) => a + b, 0);
    add(metric(id, tokenProv, totals[id]!, { detail: { source: tokenSource, byModel, ...(cs ? {} : { excludes: "auxiliary calls not written to the transcript" }) } }));
  }
  const models = cs ? Object.keys(cs.byModel).sort() : [...new Set(s.apiCalls.map((c) => c.model))].sort();
  add(metric("models.used", "exact", tokenSource ? models : null, { reason: tokenReason, ...(tokenSource ? { detail: { source: tokenSource } } : {}) }));

  if (cs && !cs.hasUnknownModelCost) {
    add(metric("cost.apiEquivalent", "exact", cs.totalCostUSD, {
      detail: { source: "cost-state", byModel: Object.fromEntries(Object.entries(cs.byModel).map(([m, u]) => [m, u.costUSD])) },
    }));
  } else if (s.apiCalls.length) {
    const p = priceCalls(s.apiCalls, pricing);
    for (const u of p.unpriced) warnings.set(`pricing:unpriced:${u}`, 1);
    const partial = p.unpriced.length > 0 || p.assumedCacheTtl;
    add(metric("cost.apiEquivalent", partial ? "heuristic" : "derived", p.pricedCalls ? p.usd : null, {
      reason: `no price for ${p.unpriced.join(", ")}`,
      detail: {
        source: "pricing-table", pricingTableDate: pricing.date, byModel: p.byModel, incomplete: p.unpriced.length > 0,
        unpriced: p.unpriced, assumedCacheTtl: p.assumedCacheTtl, ...(cs ? { costStateHasUnknownModelCost: true } : {}),
      },
    }));
  } else {
    add(metric("cost.apiEquivalent", cs ? "exact" : "derived", null, { reason: cs ? "cost-state reports an unknown model cost" : tokenReason }));
  }

  add(metric("prompts.count", "exact", s.prompts.length, { detail: { byKind: count(s.prompts, (p) => p.kind) } }));
  add(metric("toolCalls.count", "exact", s.toolCalls.length));
  add(metric("toolCalls.byName", "exact", count(s.toolCalls, (t) => t.name)));
  // Headless (sdk-cli) runs write no turn_duration records (M0), and some other entrypoints
  // don't either (claude-desktop, M1): none + prompts means "not recorded", not zero turns.
  add(metric("turns.count", "exact", s.turns.length || !s.prompts.length ? s.turns.length : null, {
    reason: s.entrypoint === "sdk-cli" ? "no turn_duration records (headless runs don't write them)" : "no turn_duration records for this session",
  }));

  // ---- coding stats ----
  const okFiles = s.toolCalls.filter((t): t is ToolCall & { file: NonNullable<ToolCall["file"]> } => t.file !== null && t.status === "ok");
  const edits = okFiles.filter((t) => EDIT_OPS.has(t.file.op));
  const unique = (ts: typeof okFiles) => new Set(ts.map((t) => projectKey(t.file.path))).size;
  add(metric("files.read", "derived", unique(okFiles.filter((t) => t.file.op === "read"))));
  add(metric("files.created", "derived", unique(okFiles.filter((t) => t.file.op === "create"))));
  const unresolved = s.toolCalls.filter((t) => t.file && EDIT_TOOLS.has(t.name) && (t.status === "no-result" || t.file.op === "write" || (t.status === "ok" && t.file.added === null)));
  add(metric("files.edited", "derived", unique(okFiles.filter((t) => t.file.op === "edit" || t.file.op === "update")),
    unresolved.length ? { detail: { unresolvedWrites: unresolved.length } } : {}));

  const added = edits.reduce((n, t) => n + (t.file.added ?? 0), 0);
  const removed = edits.reduce((n, t) => n + (t.file.removed ?? 0), 0);
  const lineDetail = {
    partial: unresolved.length > 0, uncountedOps: unresolved.length,
    ...(cs ? { matchesCostState: added === cs.linesAdded && removed === cs.linesRemoved } : {}),
  };
  add(metric("lines.added", "derived", added, { detail: lineDetail }));
  add(metric("lines.removed", "derived", removed, { detail: lineDetail }));

  const perFile = new Map<string, { path: string; ops: number; lines: number; language: string }>();
  for (const t of edits) {
    const key = projectKey(t.file.path);
    const f = perFile.get(key) ?? { path: t.file.path, ops: 0, lines: 0, language: languageOf(t.file.path) };
    f.ops++;
    f.lines += (t.file.added ?? 0) + (t.file.removed ?? 0);
    perFile.set(key, f);
  }
  const top = [...perFile.values()].sort((a, b) => b.ops - a.ops || b.lines - a.lines || a.path.localeCompare(b.path))[0];
  add(metric("files.mostEdited", "derived", top?.path ?? null, { reason: "no file edits", ...(top ? { detail: { operations: top.ops, linesChanged: top.lines } } : {}) }));

  const langs = new Map<string, { language: string; lines: number; files: number }>();
  for (const f of perFile.values()) {
    const l = langs.get(f.language) ?? { language: f.language, lines: 0, files: 0 };
    l.lines += f.lines;
    l.files++;
    langs.set(f.language, l);
  }
  add(metric("languages", "derived", perFile.size ? [...langs.values()].sort((a, b) => b.lines - a.lines || b.files - a.files || a.language.localeCompare(b.language)) : null,
    { reason: "no file edits", detail: { weighting: "lines changed" } }));

  const commands = s.toolCalls.filter((t) => t.command);
  add(metric("commands.count", "exact", commands.length));
  const programs = count(commands, (t) => t.command!.program);
  add(metric("commands.topPrograms", "derived",
    Object.entries(programs).map(([program, n]) => ({ program, count: n })).sort((a, b) => b.count - a.count || a.program.localeCompare(b.program)),
    { detail: { byCategory: count(commands, (t) => t.command!.category) } }));
  const tests = commands.filter((t) => t.command!.category === "test");
  add(metric("tests.runs", "heuristic", tests.length, { detail: { byProgram: count(tests, (t) => t.command!.program) } }));
  const errors = s.toolCalls.filter((t) => t.status === "error");
  add(metric("errors.toolErrors", "exact", errors.length, { detail: { byTool: count(errors, (t) => t.name) } }));
  add(metric("interruptions", "exact", s.toolCalls.filter((t) => t.interrupted).length, { detail: { scope: "tool-runs" } }));

  // Commits: Claude's own `git commit` calls from the transcript; the window's commits from git.
  const claudeCommits = commands.filter((t) => t.command!.git === "commit" && t.status === "ok");
  const git = opts.git;
  const gitOk = git?.status === "ok" ? git : null;
  const gitReason = !git ? "git enrichment not run" : git.status === "ok" ? "" : GIT_REASONS[git.status];
  const confirmed = gitOk
    ? claudeCommits.filter((t) => t.ts && gitOk.commits.some((c: GitCommit) => {
      const d = Date.parse(c.ts) - Date.parse(t.ts!);
      return d >= -60_000 && d <= GIT_GRACE_MS;
    })).length
    : null;
  // Heuristic: it rests on command classification (METRICS.md, weakest-input rule).
  add(metric("commits.byClaude", "heuristic", claudeCommits.length, { detail: { confirmedByGit: confirmed } }));
  const gitDetail = gitOk ? { detail: { window: gitOk.window, hasCommits: gitOk.hasCommits } } : {};
  add(metric("commits.inWindow", "exact", gitOk ? gitOk.commits.length : null, { reason: gitReason, ...gitDetail }));
  add(metric("commits.coAuthored", "exact", gitOk ? gitOk.commits.filter((c) => c.claudeCoAuthored).length : null, { reason: gitReason, ...gitDetail }));
  add(metric("git.lines", "exact", gitOk ? {
    added: gitOk.commits.reduce((n, c) => n + c.added, 0), removed: gitOk.commits.reduce((n, c) => n + c.removed, 0),
  } : null, { reason: gitReason, ...gitDetail }));
  if (git && git.status === "error") warnings.set("git:error", 1);

  // ---- session lore ----
  const perPrompt = new Map<number, ToolCall[]>();
  for (const t of s.toolCalls) if (t.promptIndex !== null) perPrompt.set(t.promptIndex, [...(perPrompt.get(t.promptIndex) ?? []), t]);
  const [rabbitIdx, rabbitCalls] = [...perPrompt].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0] ?? [null, []];
  const promptTs = rabbitIdx === null ? null : s.prompts[rabbitIdx]?.ts ?? null;
  const lastTs = rabbitCalls.map((t) => t.ts).filter((t): t is string => t !== null).sort().at(-1) ?? null;
  add(metric("lore.rabbitHole", "derived", rabbitIdx === null ? null : {
    promptIndex: rabbitIdx, toolCalls: rabbitCalls.length, durationMs: promptTs && lastTs ? Date.parse(lastTs) - Date.parse(promptTs) : null,
  }, { reason: "no tool calls follow a prompt" }));

  const longest = s.turns.reduce<number | null>((m, t) => (m === null || t.durationMs > m ? t.durationMs : m), null);
  add(metric("lore.longestTurn", "derived", longest, { reason: "no turn_duration records", detail: { turns: s.turns.length } }));

  const activity = [...s.prompts, ...s.toolCalls].map((x) => x.ts).filter((t): t is string => t !== null);
  const byHour = Array<number>(24).fill(0);
  for (const ts of activity) byHour[localHour(ts, timeZone)]!++;
  const peak = byHour.indexOf(Math.max(...byHour));
  const peakReason = !activity.length ? "no timestamped activity" : "session spans less than 2 hours";
  add(metric("lore.peakHour", "derived", activity.length && wallMs !== null && wallMs >= 2 * 3_600_000 ? peak : null,
    { reason: peakReason, ...(activity.length ? { detail: { timeZone, byHour } } : {}) }));

  let streak = 0, run = 0;
  for (const t of [...s.toolCalls].sort(byTs)) { run = t.status === "error" ? run + 1 : 0; streak = Math.max(streak, run); }
  add(metric("lore.errorStreak", "derived", s.toolCalls.length ? streak : null, { reason: "no tool calls" }));

  const reads = s.toolCalls.filter((t) => t.name === "Read" && t.status === "ok").length;
  const editCalls = s.toolCalls.filter((t) => EDIT_TOOLS.has(t.name) && t.status === "ok").length;
  add(metric("lore.readEditRatio", "derived", editCalls ? reads / editCalls : null, { reason: "no edits", detail: { reads, edits: editCalls } }));

  const denom = (totals["tokens.input"] ?? 0) + (totals["tokens.cacheRead"] ?? 0) + (totals["tokens.cacheWrite"] ?? 0);
  add(metric("lore.cacheHitRate", weakest(tokenProv, "derived"), tokenSource && denom ? totals["tokens.cacheRead"]! / denom : null,
    { reason: tokenSource ? "no input tokens" : tokenReason }));

  const order = new Map(METRIC_IDS.map((id, i) => [id, i]));
  const sections: Record<Section, Metric[]> = { hard: [], coding: [], lore: [] };
  for (const m of metrics.sort((a, b) => order.get(a.id)! - order.get(b.id)!)) sections[METRICS[m.id].section].push(m);

  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: "session",
    generatedAt: (opts.now ?? new Date()).toISOString(),
    generator: { name: GENERATOR.name, version: GENERATOR.version, pricingTableDate: pricing.date },
    context: { timeZone },
    session: {
      id: s.id, sourceSchemaVersion: s.schemaVersion, project: s.project.name, projectKey: s.project.key, cwd: s.project.cwd,
      entrypoint: s.entrypoint, title: s.title, startedAt: s.startedAt, endedAt: s.endedAt, live: s.status.live,
      complete: s.status.complete, forkOf: s.fork?.parentSessionId ?? null, clientVersions: s.source.clientVersions,
    },
    sections,
    warnings: [...warnings].map(([code, n]) => ({ code, count: n })),
  };
}
