// Phase 1: stream one transcript file and reduce every record to text-free drafts.
// This is the only code that touches raw Claude Code records. Rules: docs/research/M0_FINDINGS.md.
import { statSync } from "node:fs";
import { classifyCommand } from "./commands.ts";
import { readJsonl, type JsonlStats } from "./jsonl.ts";
import type { CommandInfo, CostState, CostStateModel, FileOpKind, PromptKind, SourceFile, Usage } from "./types.ts";

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
// Identifier-like values that may be kept verbatim (skill names, agent types, slash commands).
const safeName = (v: unknown): string | null => { const s = str(v); return s && /^[\w.:@/-]{1,100}$/.test(s) ? s : null; };

const KNOWN_TYPES = new Set([
  "user", "assistant", "system", "attachment", "cost-state", "file-history-snapshot", "file-history-delta",
  "queue-operation", "last-prompt", "ai-title", "mode", "permission-mode", "atis-latch",
]);

export interface Item { seq: number; uuid: string | null; ts: string | null; run: number }
export interface DraftCall extends Item {
  key: string; model: string; final: boolean; stopReason: string | null; serviceTier: string | null; speed: string | null; usage: Usage;
}
export interface DraftTool extends Item {
  id: string; name: string;
  target: { path: string; op: FileOpKind | null } | null; // op null = Write, decided by its result
  command: CommandInfo | null; agentType: string | null; skill: string | null;
}
export interface DraftResult { isError: boolean; interrupted: boolean; op: "create" | "update" | null; added: number | null; removed: number | null }
export interface DraftPrompt extends Item { kind: PromptKind; chars: number }
export interface DraftTurn extends Item { durationMs: number; messageCount: number | null }
export interface DraftSlash extends Item { name: string }
export interface RunState { costState: CostState | null; closed: boolean }

export interface FileScan {
  file: SourceFile;
  records: number;
  stats: JsonlStats;
  uuids: Set<string>;
  firstTs: string | null; // first timestamp in file order = when this file was created (orders forks)
  events: Item[]; // every timestamped record: run bounds and session bounds
  runs: RunState[];
  calls: Map<string, DraftCall>;
  tools: Map<string, DraftTool>;
  results: Map<string, DraftResult>;
  prompts: DraftPrompt[];
  turns: DraftTurn[];
  slash: DraftSlash[];
  title: string | null;
  entrypoint: string | null;
  agentId: string | null;
  versions: Set<string>;
  cwds: string[];
  branches: Set<string>;
  unknownTypes: Map<string, number>;
  synthetic: number;
}

const SYSTEM_TAGS = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|system-reminder)>/;

// M0 §7. A human prompt: something a person (or an SDK caller) asked Claude, not machinery.
export function promptKind(r: Rec): PromptKind | null {
  if (r.type !== "user" || r.isSidechain === true || r.isMeta === true) return null;
  const content = obj(r.message)?.content;
  const blocks = Array.isArray(content) ? content.map(obj) : [{ type: "text", text: content }];
  if (blocks.some((b) => b?.type === "tool_result")) return null;
  const text = str(blocks.find((b) => b?.type === "text")?.text) ?? "";
  if (r.promptSource === "typed" || r.promptSource === "sdk") return r.promptSource;
  if (r.promptSource != null) return null; // e.g. "system" (task notifications)
  if (/^\s*<command-message>/.test(text) && obj(r.origin)?.kind === "human") return "slash";
  // Local slash-command and `!` shell records have no promptSource; recognised by their tag.
  if (SYSTEM_TAGS.test(text) || text.startsWith("[Request interrupted")) return null;
  return text.trim() ? "typed" : null; // versions without promptSource
}

const promptChars = (r: Rec): number => {
  const content = obj(r.message)?.content;
  if (typeof content === "string") return content.length;
  return arr(content).reduce<number>((n, b) => n + (obj(b)?.type === "text" ? (str(obj(b)?.text)?.length ?? 0) : 0), 0);
};

const countLines = (s: string): number => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));

function patchLines(patch: unknown[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const hunk of patch) for (const line of arr(obj(hunk)?.lines)) {
    if (typeof line !== "string") continue;
    if (line[0] === "+") added++;
    else if (line[0] === "-") removed++;
  }
  return { added, removed };
}

// Structured toolUseResult → counts only. Write create: every line of content is added;
// Write update and Edit: +/- lines of structuredPatch (both match cost-state exactly, M0 §6).
function describeResult(t: Rec): Partial<DraftResult> {
  const interrupted = t.interrupted === true;
  if (t.type === "create" && typeof t.content === "string") return { interrupted, op: "create", added: countLines(t.content), removed: 0 };
  if (Array.isArray(t.structuredPatch)) return { interrupted, op: t.type === "update" ? "update" : null, ...patchLines(t.structuredPatch) };
  return { interrupted };
}

function describeTool(name: string, input: Rec | null): Pick<DraftTool, "target" | "command" | "agentType" | "skill"> {
  const d: Pick<DraftTool, "target" | "command" | "agentType" | "skill"> = { target: null, command: null, agentType: null, skill: null };
  const file = (key: string, op: FileOpKind | null) => { const path = str(input?.[key]); d.target = path ? { path, op } : null; };
  switch (name) {
    case "Read": file("file_path", "read"); break;
    case "Write": file("file_path", null); break;
    case "Edit": case "MultiEdit": file("file_path", "edit"); break;
    case "NotebookEdit": file("notebook_path", "edit"); break;
    case "Bash": case "PowerShell": {
      const command = str(input?.command); // classified here, then dropped
      if (command) d.command = classifyCommand(command, name === "Bash" ? "bash" : "powershell");
      break;
    }
    case "Agent": case "Task": d.agentType = safeName(input?.subagent_type); break;
    case "Skill": d.skill = safeName(input?.skill); break;
  }
  return d;
}

function usageOf(u: Rec): Usage {
  const cc = obj(u.cache_creation);
  return {
    input: num(u.input_tokens), output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens),
    cacheWrite5m: cc ? num(cc.ephemeral_5m_input_tokens) : null, cacheWrite1h: cc ? num(cc.ephemeral_1h_input_tokens) : null,
    thinking: num(obj(u.output_tokens_details)?.thinking_tokens), webSearches: num(obj(u.server_tool_use)?.web_search_requests),
  };
}

function costStateOf(r: Rec): CostState {
  const byModel: Record<string, CostStateModel> = {};
  for (const [model, v] of Object.entries(obj(r.modelUsage) ?? {})) {
    const u = obj(v);
    if (u) byModel[model] = {
      input: num(u.inputTokens), output: num(u.outputTokens), thinking: num(u.thinkingTokens), cacheRead: num(u.cacheReadInputTokens),
      cacheWrite: num(u.cacheCreationInputTokens), webSearches: num(u.webSearchRequests), costUSD: num(u.costUSD),
    };
  }
  return {
    totalCostUSD: num(r.totalCostUSD), totalDurationMs: num(r.totalDuration), totalApiDurationMs: num(r.totalAPIDuration),
    totalToolDurationMs: num(r.totalToolDuration), linesAdded: num(r.totalLinesAdded), linesRemoved: num(r.totalLinesRemoved),
    hasUnknownModelCost: r.hasUnknownModelCost === true, startTime: typeof r.startTime === "number" ? r.startTime : null, byModel,
  };
}

export async function scanFile(path: string): Promise<FileScan> {
  const st = statSync(path);
  const s: FileScan = {
    file: { path, sizeBytes: st.size, mtimeMs: st.mtimeMs }, records: 0, stats: { badLines: 0, truncatedTail: false },
    uuids: new Set(), firstTs: null, events: [], runs: [], calls: new Map(), tools: new Map(), results: new Map(),
    prompts: [], turns: [], slash: [], title: null, entrypoint: null, agentId: null, versions: new Set(), cwds: [],
    branches: new Set(), unknownTypes: new Map(), synthetic: 0,
  };
  let seq = 0;
  for await (const value of readJsonl(path, st.size, s.stats)) {
    const r = obj(value);
    if (!r) { s.stats.badLines++; continue; }
    const uuid = str(r.uuid);
    if (uuid) {
      if (s.uuids.has(uuid)) continue; // a record seen twice in one file counts once
      s.uuids.add(uuid);
    }
    s.records++;
    const type = str(r.type) ?? "";
    const ts = str(r.timestamp);
    // Runs (M0 addendum): a cost-state closes the current run; the next timestamped record opens
    // a new one. A second cost-state with no activity in between updates the same run.
    if (ts) {
      s.firstTs ??= ts;
      if (!s.runs.length || s.runs.at(-1)!.closed) s.runs.push({ costState: null, closed: false });
    }
    const item: Item = { seq: seq++, uuid, ts, run: Math.max(0, s.runs.length - 1) };
    if (ts) s.events.push(item);

    const cwd = str(r.cwd);
    if (cwd && !s.cwds.includes(cwd)) s.cwds.push(cwd);
    const branch = str(r.gitBranch);
    if (branch) s.branches.add(branch);
    const version = str(r.version);
    if (version) s.versions.add(version);
    s.entrypoint ??= str(r.entrypoint);
    s.agentId ??= str(r.agentId);

    switch (type) {
      case "assistant": {
        const m = obj(r.message);
        if (!m) break;
        const model = str(m.model) ?? "unknown";
        if (model === "<synthetic>") { s.synthetic++; break; } // client placeholder, not an API call
        const key = str(m.id) ?? str(r.requestId) ?? uuid;
        const usage = obj(m.usage);
        if (key && usage) {
          const first = s.calls.get(key); // position from the first line, usage from the last (M0 §5)
          s.calls.set(key, {
            ...(first ?? item), key, model, usage: usageOf(usage), final: m.stop_reason != null,
            stopReason: str(m.stop_reason), serviceTier: str(usage.service_tier), speed: str(usage.speed),
          });
        }
        for (const b of arr(m.content).map(obj)) {
          const id = str(b?.id), name = str(b?.name);
          if (b?.type !== "tool_use" || !id || !name || s.tools.has(id)) continue;
          s.tools.set(id, { ...item, id, name, ...describeTool(name, obj(b.input)) });
        }
        break;
      }
      case "user": {
        const kind = promptKind(r);
        if (kind) s.prompts.push({ ...item, kind, chars: promptChars(r) });
        const content = obj(r.message)?.content;
        if (typeof content === "string" && !r.isSidechain) {
          const name = content.match(/^\s*<command-name>(\/[\w:.-]{1,60})<\/command-name>/)?.[1];
          if (name) s.slash.push({ ...item, name });
        }
        const results = arr(content).map(obj).filter((b) => b?.type === "tool_result");
        for (const b of results) {
          const id = str(b?.tool_use_id);
          if (id) s.results.set(id, { isError: b?.is_error === true, interrupted: false, op: null, added: null, removed: null });
        }
        const structured = obj(r.toolUseResult); // a plain string here means an error message: ignored
        const target = str(r.sourceToolUseID) ?? (results.length === 1 ? str(results[0]?.tool_use_id) : null);
        const draft = target ? s.results.get(target) : undefined;
        if (structured && draft) Object.assign(draft, describeResult(structured));
        break;
      }
      case "system":
        if (r.subtype === "turn_duration") {
          s.turns.push({ ...item, durationMs: num(r.durationMs), messageCount: typeof r.messageCount === "number" ? r.messageCount : null });
        }
        break;
      case "ai-title": {
        const title = str(r.aiTitle)?.trim();
        if (title) s.title = title.slice(0, 200);
        break;
      }
      case "cost-state": {
        if (!s.runs.length) s.runs.push({ costState: null, closed: false });
        const run = s.runs.at(-1)!;
        run.costState = costStateOf(r);
        run.closed = true;
        break;
      }
      default:
        // Everything else (attachments included) is read no further than its type.
        if (!KNOWN_TYPES.has(type)) {
          const name = /^[\w-]{1,40}$/.test(type) ? type : "?";
          s.unknownTypes.set(name, (s.unknownTypes.get(name) ?? 0) + 1);
        }
    }
  }
  return s;
}
