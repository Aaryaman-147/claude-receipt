// The normalized Session: the only shape that leaves source/claude-code.
// It holds no free text (docs/PRIVACY.md §3): no prompts, responses, file contents,
// patches, command strings or tool output. The single exception is `title`.

export const SESSION_SCHEMA_VERSION = 1;

export interface SourceFile {
  path: string;
  sizeBytes: number; // bytes read (the snapshot taken when parsing started)
  mtimeMs: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m: number | null; // null when the transcript has no TTL breakdown
  cacheWrite1h: number | null;
  thinking: number; // believed to be a subset of output (M0 §6), never add to totals
  webSearches: number;
}

export interface ApiCall {
  key: string; // message.id (fallback requestId, then record uuid)
  ts: string | null; // first line of the response
  run: number;
  agentId: string | null; // null = main thread, otherwise the subagent
  model: string;
  final: boolean; // the kept line has a stop_reason (false = cut off mid-stream)
  stopReason: string | null;
  serviceTier: string | null;
  speed: string | null;
  usage: Usage; // from the LAST line of the response (M0 §5)
}

export type CommandCategory = "test" | "build" | "install" | "git" | "run" | "search" | "fs" | "other";

export interface CommandInfo {
  shell: "bash" | "powershell";
  program: string; // from a fixed allowlist, otherwise "other"; never the raw command
  category: CommandCategory;
  git: "commit" | "push" | "other" | null; // any `git commit` segment wins
}

// "write" = a Write whose result is missing, so create vs update is unknown
export type FileOpKind = "read" | "create" | "update" | "edit" | "write";

export interface FileOp {
  path: string;
  op: FileOpKind;
  added: number | null; // null = unknown (no result, error, or a tool without patches)
  removed: number | null;
}

export interface ToolCall {
  id: string;
  name: string; // "Bash", "Edit", "mcp__server__tool", ...
  ts: string | null;
  run: number;
  agentId: string | null;
  promptIndex: number | null; // index into Session.prompts; subagent calls inherit their Agent call's
  status: "ok" | "error" | "no-result";
  interrupted: boolean;
  file: FileOp | null;
  command: CommandInfo | null;
  agentType: string | null; // Agent tool: subagent type
  skill: string | null; // Skill tool: skill name
}

export type PromptKind = "typed" | "sdk" | "slash";

export interface Prompt {
  ts: string | null;
  run: number;
  kind: PromptKind;
  chars: number; // length only; the text is never kept
}

export interface Turn {
  ts: string | null;
  run: number;
  durationMs: number;
  messageCount: number | null;
}

export interface SlashCommand {
  ts: string | null;
  run: number;
  name: string; // e.g. "/model"; arguments are never kept
}

export interface CostStateModel {
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheWrite: number;
  webSearches: number;
  costUSD: number;
}

// Claude Code's own cumulative totals for the session file (M0 §1, §6)
export interface CostState {
  totalCostUSD: number;
  totalDurationMs: number; // sum of process run times, not wall clock
  totalApiDurationMs: number;
  totalToolDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
  hasUnknownModelCost: boolean;
  startTime: number | null;
  byModel: Record<string, CostStateModel>;
}

export interface Run {
  index: number;
  startedAt: string | null;
  endedAt: string | null;
  closed: boolean; // ended with a cost-state (a clean process exit)
  costState: CostState | null; // cumulative snapshot at the end of this run
}

export interface Subagent {
  agentId: string;
  agentType: string | null;
  model: string | null;
  parentToolUseId: string | null; // the Agent tool call that spawned it
}

export interface Finding {
  level: "info" | "warning";
  code: "only-in-cost-state" | "only-in-transcript" | "cost-state-exceeds-transcript" | "transcript-exceeds-cost-state" | "lines-mismatch";
  model?: string;
  field?: string;
  diff?: number;
}

export interface Warning {
  code: string;
  count: number;
}

export interface Session {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: string;
  source: { adapter: "claude-code"; main: SourceFile; subagents: SourceFile[]; clientVersions: string[] };
  entrypoint: string | null; // "cli" | "sdk-cli" | ... (headless sessions are included)
  project: {
    cwd: string | null; // from records, never decoded from the directory name
    key: string | null; // grouping key: case-insensitive, no trailing separator, for Windows paths
    name: string | null;
    otherCwds: string[];
    gitBranches: string[];
  };
  startedAt: string | null; // own records only (a fork's copied history is excluded)
  endedAt: string | null;
  status: { live: boolean; complete: boolean; empty: boolean; truncatedTail: boolean; badLines: number };
  fork: { parentSessionId: string; inheritedRecords: number; inheritedApiCalls: number } | null;
  title: string | null; // Claude Code's ai-title: display only, never archived
  runs: Run[];
  prompts: Prompt[];
  turns: Turn[];
  apiCalls: ApiCall[]; // deduplicated, own calls only (main thread + subagents)
  toolCalls: ToolCall[];
  slashCommands: SlashCommand[];
  subagents: Subagent[];
  costState: CostState | null; // last snapshot; includes subagents; for forks includes inherited usage
  reconciliation: Finding[] | null; // null when there is no cost-state to compare with
  warnings: Warning[];
}
