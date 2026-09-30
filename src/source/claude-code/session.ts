// Phase 2: turn file scans into Sessions. Handles forks (copied history), subagents,
// run boundaries and cost-state reconciliation. Rules: docs/research/M0_FINDINGS.md.
import type { DraftCall, DraftResult, DraftTool, FileScan, Item } from "./scan.ts";
import {
  SESSION_SCHEMA_VERSION,
  type ApiCall, type CostState, type FileOp, type Finding, type Run, type Session, type Subagent, type ToolCall, type Warning,
} from "./types.ts";

export interface SessionInput {
  id: string;
  main: FileScan;
  subagents: { scan: FileScan; meta: Subagent }[];
  live: boolean;
}

interface Inheritance { parentId: string; uuids: Set<string>; callKeys: Set<string> }

export interface ModelTokens { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number }

export function tokensByModel(calls: Iterable<Pick<ApiCall, "model" | "usage">>): Record<string, ModelTokens> {
  const out: Record<string, ModelTokens> = {};
  for (const { model, usage: u } of calls) {
    const t = (out[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 });
    t.input += u.input; t.output += u.output; t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite; t.thinking += u.thinking;
  }
  return out;
}

// M0 §6. Never throws, never blocks a receipt.
//   info    = cost-state above the transcript (auxiliary calls; normal in interactive sessions)
//   warning = transcript above cost-state, a model only in the transcript, or a line-count mismatch
const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "thinking"] as const;
export function reconcile(ours: Record<string, ModelTokens>, cs: CostState, lines?: { added: number; removed: number }): Finding[] {
  const findings: Finding[] = [];
  for (const model of new Set([...Object.keys(ours), ...Object.keys(cs.byModel)])) {
    const a = ours[model], b = cs.byModel[model];
    if (!a) { findings.push({ level: "info", code: "only-in-cost-state", model }); continue; }
    if (!b) { findings.push({ level: "warning", code: "only-in-transcript", model }); continue; }
    for (const field of FIELDS) {
      const diff = a[field] - b[field];
      if (diff > 0) findings.push({ level: "warning", code: "transcript-exceeds-cost-state", model, field, diff });
      if (diff < 0) findings.push({ level: "info", code: "cost-state-exceeds-transcript", model, field, diff });
    }
  }
  if (lines) {
    if (lines.added !== cs.linesAdded) findings.push({ level: "warning", code: "lines-mismatch", field: "added", diff: lines.added - cs.linesAdded });
    if (lines.removed !== cs.linesRemoved) findings.push({ level: "warning", code: "lines-mismatch", field: "removed", diff: lines.removed - cs.linesRemoved });
  }
  return findings;
}

const minTs = (items: Item[]) => items.reduce<string | null>((m, i) => (i.ts && (!m || i.ts < m) ? i.ts : m), null);
const maxTs = (items: Item[]) => items.reduce<string | null>((m, i) => (i.ts && (!m || i.ts > m) ? i.ts : m), null);

// Grouping key for project identity: Windows paths compare case-insensitively (M0 §4).
export function projectKey(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "") || cwd;
  return /^[A-Za-z]:[\\/]|^\\\\/.test(cwd) ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
}

function fileOp(t: DraftTool, res: DraftResult | undefined): FileOp | null {
  if (!t.target) return null;
  const known = res !== undefined && !res.isError && t.target.op !== "read";
  return {
    path: t.target.path,
    op: t.target.op ?? res?.op ?? "write",
    added: known ? res.added : null,
    removed: known ? res.removed : null,
  };
}

function toolCall(t: DraftTool, res: DraftResult | undefined, agentId: string | null, run: number, promptIndex: number | null): ToolCall {
  return {
    id: t.id, name: t.name, ts: t.ts, run, agentId, promptIndex,
    status: !res ? "no-result" : res.isError ? "error" : "ok",
    interrupted: res?.interrupted ?? false,
    file: fileOp(t, res), command: t.command, agentType: t.agentType, skill: t.skill,
  };
}

const apiCall = ({ key, ts, model, final, stopReason, serviceTier, speed, usage }: DraftCall, run: number, agentId: string | null): ApiCall =>
  ({ key, ts, run, agentId, model, final, stopReason, serviceTier, speed, usage });

function linesOf(tools: DraftTool[], results: Map<string, DraftResult>) {
  let added = 0, removed = 0;
  for (const t of tools) {
    const op = fileOp(t, results.get(t.id));
    added += op?.added ?? 0;
    removed += op?.removed ?? 0;
  }
  return { added, removed };
}

function assemble(input: SessionInput, inh: Inheritance | null): Session {
  const { main } = input;
  const inherited = (i: Item) => inh !== null && i.uuid !== null && inh.uuids.has(i.uuid);
  const own = <T extends Item>(items: Iterable<T>) => [...items].filter((i) => !inherited(i));

  // Runs come from the main file only (subagent files have no cost-state).
  const mainEvents = own(main.events);
  const runs: Run[] = main.runs.map((r, index) => {
    const ev = mainEvents.filter((e) => e.run === index);
    return { index, startedAt: minTs(ev), endedAt: maxTs(ev), closed: r.closed, costState: r.costState };
  });
  const runAt = (ts: string | null) => runs.reduce((idx, r, i) => (ts && r.startedAt && r.startedAt <= ts ? i : idx), 0);

  const prompts = own(main.prompts);
  const promptIndexAt = (seq: number) => {
    let idx: number | null = null;
    prompts.forEach((p, i) => { if (p.seq < seq) idx = i; });
    return idx;
  };

  const mainTools = own(main.tools.values()).map((t) => toolCall(t, main.results.get(t.id), null, t.run, promptIndexAt(t.seq)));
  const byId = new Map(mainTools.map((t) => [t.id, t]));
  const subTools = input.subagents.flatMap(({ scan, meta }) => {
    const promptIndex = meta.parentToolUseId ? (byId.get(meta.parentToolUseId)?.promptIndex ?? null) : null;
    return [...scan.tools.values()].map((t) => toolCall(t, scan.results.get(t.id), meta.agentId, runAt(t.ts), promptIndex));
  });

  const calls = new Map<string, ApiCall>();
  for (const c of main.calls.values()) {
    if (!inherited(c) && !inh?.callKeys.has(c.key)) calls.set(c.key, apiCall(c, c.run, null));
  }
  for (const { scan, meta } of input.subagents) {
    for (const c of scan.calls.values()) if (!calls.has(c.key)) calls.set(c.key, apiCall(c, runAt(c.ts), meta.agentId));
  }

  // Reconciliation compares everything cost-state counted: all calls, inherited ones included.
  const costState = main.runs.findLast((r) => r.costState)?.costState ?? null;
  const scans = [main, ...input.subagents.map((s) => s.scan)];
  let reconciliation: Finding[] | null = null;
  if (costState) {
    const everything = scans.flatMap((s) => [...s.calls.values()]);
    const lines = scans.map((s) => linesOf([...s.tools.values()], s.results)).reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }));
    reconciliation = reconcile(tokensByModel(everything), costState, lines);
  }

  const status = {
    live: input.live,
    empty: main.records === 0,
    truncatedTail: scans.some((s) => s.stats.truncatedTail),
    badLines: scans.reduce((n, s) => n + s.stats.badLines, 0),
    complete: false,
  };
  status.complete = !status.live && !status.empty && !status.truncatedTail && runs.length > 0 && runs.at(-1)!.closed;

  const tally = new Map<string, number>();
  const warn = (code: string, n = 1) => { if (n > 0) tally.set(code, (tally.get(code) ?? 0) + n); };
  for (const s of scans) {
    for (const [type, n] of s.unknownTypes) warn(`unknown-record-type:${type}`, n);
    warn("bad-lines", s.stats.badLines);
    warn("truncated-tail", s.stats.truncatedTail ? 1 : 0);
    warn("synthetic-message", s.synthetic);
    warn("tool-result-without-call", [...s.results.keys()].filter((id) => !s.tools.has(id)).length);
  }
  const tools = [...mainTools, ...subTools];
  if (status.complete) warn("tool-call-without-result", tools.filter((t) => t.status === "no-result").length);
  for (const f of reconciliation ?? []) if (f.level === "warning") warn(`reconciliation:${f.code}`);
  const warnings: Warning[] = [...tally].map(([code, count]) => ({ code, count }));

  const cwds = [...new Set([...main.cwds, ...input.subagents.flatMap((s) => s.scan.cwds)])];
  const cwd = cwds[0] ?? null;
  const allEvents = [...mainEvents, ...input.subagents.flatMap((s) => s.scan.events)];

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: input.id,
    source: {
      adapter: "claude-code",
      main: main.file,
      subagents: input.subagents.map((s) => s.scan.file),
      clientVersions: [...new Set(scans.flatMap((s) => [...s.versions]))].sort(),
    },
    entrypoint: main.entrypoint,
    project: {
      cwd,
      key: cwd === null ? null : projectKey(cwd),
      name: cwd === null ? null : cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd,
      otherCwds: cwds.slice(1),
      gitBranches: [...new Set(scans.flatMap((s) => [...s.branches]))].sort(),
    },
    startedAt: minTs(allEvents),
    endedAt: maxTs(allEvents),
    status,
    fork: inh && {
      parentSessionId: inh.parentId,
      inheritedRecords: inh.uuids.size,
      inheritedApiCalls: [...main.calls.values()].filter((c) => inherited(c) || inh.callKeys.has(c.key)).length,
    },
    title: main.title,
    runs,
    prompts: prompts.map(({ ts, run, kind, chars }) => ({ ts, run, kind, chars })),
    turns: own(main.turns).map(({ ts, run, durationMs, messageCount }) => ({ ts, run, durationMs, messageCount })),
    apiCalls: [...calls.values()],
    toolCalls: tools,
    slashCommands: own(main.slash).map(({ ts, run, name }) => ({ ts, run, name })),
    subagents: input.subagents.map((s) => s.meta),
    costState,
    reconciliation,
    warnings,
  };
}

// Builds Sessions for a set of transcripts that may fork from each other (M0 §1): a file
// sharing record uuids with an earlier-created file is a fork, and the shared records are
// inherited copies, excluded from its own activity. Only the inputs given are compared, so
// a fork whose parent transcript is gone is not detected here (the archive handles that later).
export function buildSessions(inputs: SessionInput[]): Session[] {
  const order = [...inputs].sort((a, b) =>
    (a.main.firstTs ?? "￿").localeCompare(b.main.firstTs ?? "￿") || a.id.localeCompare(b.id));
  const owner = new Map<string, string>();
  const seenCalls = new Set<string>();
  const built = new Map<string, Session>();
  for (const input of order) {
    const overlap = new Map<string, number>();
    const uuids = new Set<string>();
    for (const u of input.main.uuids) {
      const o = owner.get(u);
      if (o) { uuids.add(u); overlap.set(o, (overlap.get(o) ?? 0) + 1); }
    }
    let parentId: string | null = null;
    for (const [id, n] of overlap) if (parentId === null || n >= overlap.get(parentId)!) parentId = id;
    const callKeys = new Set([...input.main.calls.keys()].filter((k) => seenCalls.has(k)));
    built.set(input.id, assemble(input, parentId ? { parentId, uuids, callKeys } : null));
    for (const u of input.main.uuids) if (!owner.has(u)) owner.set(u, input.id);
    for (const s of [input.main, ...input.subagents.map((x) => x.scan)]) for (const k of s.calls.keys()) seenCalls.add(k);
  }
  return inputs.map((i) => built.get(i.id)!);
}
