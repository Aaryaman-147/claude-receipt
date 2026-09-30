# Architecture

Status: proposed and approved in direction; not yet implemented. The types below are specifications, not code. Field names may be refined in M1, but the boundaries may not.

## 1. Data flow

```
~/.claude/projects/**/<sessionId>.jsonl ─┐
~/.claude/sessions/<pid>.json ───────────┼─► source/claude-code ──► Session
~/.claude/history.jsonl (future) ────────┘                              │
                                                 git/ ──► GitFacts ─────┤ (optional)
                                                                        ▼
                                                                    analytics
                                                                        │
                                                                        ▼
                                                                     Receipt ─────────► archive/ (ArchiveEntry, metrics only)
                                                          ┌─────────────┼──────────────┐          │
                                                          ▼             ▼              ▼          ▼
                                                     render/tty    render/json    render/svg   aggregate ──► PeriodReceipt
                                                                                  (future)     (future)      (week/month/wrapped)
```

## 2. Modules

| Module | Responsibility | Knows about |
|---|---|---|
| `source/claude-code` | Find transcripts, stream-parse JSONL, deduplicate, build a `Session` | Claude Code's file format (the **only** module that does) |
| `git/` | Given a `cwd` and a time window, return `GitFacts` by running `git` read-only | The `git` CLI |
| `analytics/` | Pure functions: `(Session, GitFacts?) → Receipt` | Session, GitFacts, pricing table, metric registry |
| `archive/` | Read and write `ArchiveEntry` files, migrate old schema versions | Receipt, ArchiveEntry |
| `aggregate/` (future) | `ArchiveEntry[] → PeriodReceipt` | ArchiveEntry |
| `render/tty` | Receipt → terminal text (layout, colour, `~` markers, microcopy) | Receipt |
| `render/json` | Receipt → versioned JSON | Receipt |
| `render/svg` (future) | Receipt → SVG → PNG | Receipt |
| `cli` | Argument parsing, choosing a session, wiring the above | Everything, but only as glue |

Shared helpers used by several renderers (duration and number formatting, the microcopy table keyed by metric id) live in one small `format` module, so TTY and SVG say the same things.

**Rules:**

- Nothing outside `source/claude-code` reads raw records or knows field names like `toolUseResult`, `cost-state` or `structuredPatch`.
- `analytics/` does no I/O. Pricing is a data file passed in.
- Renderers never compute metrics. If a renderer needs a number, it belongs in the Receipt.
- No plugin framework or adapter registry. When a second source format appears, `source/` gains a second module and `cli` chooses; nothing else changes.

## 3. Normalized Session model

Plain, serializable data. **It contains no free text:** no prompts, responses, file contents, command strings or tool output. The single exception is the optional Claude Code–generated `title`, which is display-only and never archived (`PRIVACY.md` §3).

```ts
type Provenance = "exact" | "derived" | "heuristic";

interface Session {
  id: string;                        // Claude Code sessionId (UUID) = main file name
  source: { adapter: "claude-code"; files: SourceFile[]; clientVersions: string[] };  // main file + subagents/*.jsonl
  entrypoint: string;                // "cli" (human) | "sdk-cli" (headless/automation) | …
  project: { cwd: string; name: string; gitBranches: string[] };   // cwd from records, never from dir names
  startedAt: string;                 // ISO UTC, first timestamped record
  endedAt: string;                   // ISO UTC, last timestamped record
  runs: Run[];                       // run boundaries (each resume = a run); prompts, calls and tool calls carry their run index
  isLive: boolean;                   // a sessions/<pid>.json names this session AND that PID is running
  isComplete: boolean;               // false if truncated tail or no cost-state (live or killed)
  fork?: { parentSessionId: string; inheritedApiCalls: number };   // detected by uuid overlap (M0 §1)
  title?: string;                    // ai-title (see PRIVACY.md: treated as sensitive in exports)

  prompts: { ts: string; chars: number; kind: "typed" | "sdk" | "slash" }[];   // M0 §7 rule
  turns: { ts: string; durationMs: number; messageCount: number }[];           // from turn_duration
  apiCalls: ApiCall[];               // deduplicated by message.id, last line wins; excludes inherited fork copies
  toolCalls: ToolCall[];
  slashCommands: { ts: string; name: string }[];
  interruptions: number;
  subagents: { agentId: string; agentType: string; model?: string; apiCalls: number }[];  // from meta.json (never `description`)
  costState?: CostState;             // last cost-state record, if any (cumulative; includes subagents; includes inherited usage for forks)
  warnings: string[];                // e.g. "unknown record type: foo (3x)", reconciliation findings
}

interface SourceFile { path: string; sizeBytes: number; mtimeMs: number }

interface ApiCall {
  messageId: string;
  ts: string;
  model: string;
  isSidechain: boolean;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number };
  serviceTier?: string;
  speed?: string;
}

interface ToolCall {
  id: string;
  ts: string;
  name: string;                      // "Bash", "Edit", "Read", "mcp__x__y", ...
  isError: boolean;
  interrupted: boolean;
  promptIndex: number;               // which user prompt this call belongs to
  file?: { path: string; op: "read" | "create" | "update" | "edit"; added: number; removed: number };
  command?: { program: string; category: CommandCategory };   // never the raw command string
  git?: { kind: "commit" | "push" | "other" };                // from command classification
}

type CommandCategory = "test" | "build" | "install" | "git" | "run" | "search" | "fs" | "other";

interface CostState {
  totalCostUSD: number;
  totalDurationMs: number;
  totalApiDurationMs: number;
  totalToolDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
  hasUnknownModelCost: boolean;
  byModel: Record<string, { input: number; output: number; thinking: number; cacheRead: number; cacheWrite: number; webSearches: number; costUSD: number }>;
}
```

The Bash command string is read from the transcript in memory **only** to classify it (`program`, `category`, `git.kind`) and is then discarded.

## 4. Receipt model

The Receipt is the output of analytics and the input of every renderer and of the archive.

**Rule: the Receipt contains semantic data, never presentation copy or layout.** Values may be numbers, booleans or strings, as long as they mean something independently of how they're shown: model names, language names, file names, project identifiers, versions, archetype ids. What does not belong in the Receipt: labels and headings, formatted values (`1h 42m`, `$12.84`, `12.3k`), playful microcopy, ANSI codes, padding, column widths or anything visual. Those belong to the `format` module and renderers.

```ts
interface Receipt {
  schemaVersion: 1;
  generatedAt: string;
  generator: { name: "claude-receipt"; version: string; pricingTableDate: string };
  kind: "session";                   // later: "project" | "week" | "month" | "wrapped"
  session: { id: string; project: string; cwd: string; entrypoint: string | null; title?: string; startedAt: string; endedAt: string; runs: number; isLive: boolean; clientVersions: string[] };
  sections: {
    hard: Metric[];
    coding: Metric[];
    lore: Metric[];
  };
  warnings: string[];
}

interface Metric<V = unknown> {
  id: string;                        // stable registry id, e.g. "tokens.output" (see METRICS.md)
  provenance: Provenance;
  value: V | null;                   // null = unavailable, never 0-as-unknown
  unit?: "ms" | "tokens" | "usd" | "count" | "lines" | "hour" | "percent";
  unavailableReason?: string;        // required when value is null
  sensitive?: boolean;               // renderer must redact in exports (paths, project names, titles)
  detail?: Record<string, unknown>;  // structured extras, e.g. per-model breakdown
}
```

- Labels, headings and microcopy come from the `format` module, keyed by `Metric.id` (and by semantic values such as a personality archetype id). This keeps the JSON contract stable when wording changes.
- Order within a section is the rendering order. The renderer may drop items to fit, but may never alter values or provenance.
- `render/json` emits exactly this structure. Adding fields or metric ids is non-breaking. Removing or renaming them, or changing a value's type, requires `schemaVersion` + 1.

## 5. Git integration

`git/` runs read-only commands (`git rev-parse`, `git log --since --until`, `git show --numstat`) in `session.cwd`:

```ts
interface GitFacts {
  isRepo: boolean;
  commits: { sha: string; ts: string; claudeCoAuthored: boolean; added: number; removed: number }[];
  hasUncommittedChanges?: boolean;
}
```

- The window is `[startedAt, endedAt + 5 min]` (commit timestamps can trail the last transcript record slightly).
- Commit messages and author identities are not kept (only the `Co-Authored-By: Claude` boolean). SHAs are sensitive in exports.
- Missing `git`, not a repository, or an empty repository means `GitFacts` is absent and the git metrics are `null` with a reason.

## 6. Archive

**Location:** `~/.claude-receipt/archive/`. Override with `CLAUDE_RECEIPT_HOME`. Never inside `~/.claude`.

**Layout:** one file per session: `archive/<sessionId>.json`. There is no database. At expected volumes (a few thousand sessions per year) a directory of small JSON files is simple, inspectable and easy to delete. Revisit only if aggregation becomes measurably slow.

```ts
interface ArchiveEntry {
  archiveSchemaVersion: 1;
  sessionId: string;
  archivedAt: string;
  generatorVersion: string;
  sourceFingerprint: { files: SourceFile[] };   // size + mtime → detects changes
  sourceStillExists?: boolean;                   // updated opportunistically
  apiCallKeys: string[];                         // sha256(message.id) truncated to 16 hex chars, for cross-session dedupe
  fork?: { parentSessionId: string };            // detected at archive time
  receipt: Receipt;                              // the computed session receipt with session.title removed
}
```

`apiCallKeys` exists because forks copy their parent's API calls (M0 §1). Aggregation must count each call once, even after the parent's transcript has been cleaned up. Hashed ids are opaque and carry no content.

**Write policy:**

- Every CLI run sweeps `~/.claude/projects/*/*.jsonl` (plus each session's `<sessionId>/subagents/*.jsonl`) and (re)archives sessions that are new or whose fingerprint changed, and are not live. A session counts as live only if its `sessions/<pid>.json` PID is actually running (stale entries exist after crashes). Cost: parsing a few MB, which is acceptable. It can be optimized with fingerprints alone.
- Fork detection: a session whose record uuids or `message.id`s overlap an earlier session (in transcripts or in archived `apiCallKeys`) is a fork. Its receipt counts only its own, non-inherited API calls, and its `cost-state` (which includes inherited usage) is not used for its totals.
- An entry whose transcript has disappeared is **kept as is**. The archive is the long-term record.
- Writes are atomic (write a temp file, then rename).

**Schema evolution:**

- Readers accept every `archiveSchemaVersion` up to the current one via pure migration functions `vN → vN+1`, tested with fixtures of each old version.
- When a transcript still exists, re-computing from source is preferred to migrating.
- An entry that fails to parse or migrate is skipped with a warning, never deleted.

**Contents guarantee:** an ArchiveEntry contains only what the Receipt contains, minus `session.title` (the one free-text field, which is never archived). See `PRIVACY.md` for the exhaustive list of what is stored.

## 7. Source format change strategy

Claude Code's transcript format is undocumented and changes between versions (this machine: 2.1.283).

1. **One adapter, tolerant parsing.** Unknown record types and unknown fields are ignored and counted into `Session.warnings`. They never crash the parser.
2. **Zod (or equivalent) only at the boundary**, validating just the fields we use, so a changed field fails loudly as a warning plus a `null` metric rather than as a wrong number.
3. **Versioned fixtures**: `fixtures/claude-code/<version>/<scenario>.jsonl`. When a new Claude Code version changes something, add a fixture for it; old fixtures stay and must keep passing.
4. **Record the `version` field** per session (`clientVersions`) so format-dependent logic can branch if it must.
5. **Reconciliation as a canary**: when `cost-state` is present, compare our token sums per model to it. A mismatch becomes a warning, which is the earliest signal that the format changed.

## 8. Key parsing rules (verified in M0)

Evidence and status for each rule: `docs/research/M0_FINDINGS.md`. Reference implementation and tests: `scripts/m0/rules.mjs`, `test/m0-rules.test.mjs`.

- **Session = one main file.** `--resume` and `--continue` append to it. `--fork-session` creates a new file containing a copy of the parent's history.
- **Subagents** live in `<sessionId>/subagents/agent-<agentId>.jsonl` (+ `.meta.json`), with the parent's sessionId and `isSidechain: true`. They are part of the session. The parent `cost-state` includes them.
- **Token deduplication**: key = `message.id` (then `requestId`, then `uuid`). **The last line in file order wins**, because earlier lines of a response can hold partial streaming usage. Deduplicate globally across files so fork copies count once.
- **cost-state** is cumulative, and a new one is appended per process exit. Use the last one. It is absent for live and killed sessions. For forks it includes inherited usage.
- **Token source:** last `cost-state` for completed non-fork sessions (includes auxiliary calls not in the transcript). Otherwise the deduplicated transcript sum, labelled derived.
- **Reconciliation:** transcript below `cost-state` = info (auxiliary calls, normal in interactive sessions). Transcript above `cost-state`, or a model only in the transcript = warning. Never an error.
- **Prompts:** `promptSource` `typed` or `sdk`, or a `<command-message>` with `origin.kind: human`. Excluded: tool results, `isMeta`, sidechains, local-command / bash / task-notification records.
- **Tool errors**: `tool_result.is_error === true`. `toolUseResult` is then a plain string with no structured exit code.
- **Line counts** come from `Edit` `structuredPatch` lines (`+` and `-` prefixes) and `Write` (`create`: all lines of `content`; `update`: from `structuredPatch`). They match `cost-state` totals exactly.
- **Project identity** comes from the `cwd` field only. Directory names are lossy (every non-`[A-Za-z0-9]` → `-`) and truncated with a hash suffix above 200 characters. Group `cwd`s case-insensitively on Windows.
- **Partial final line**: drop it, flag it, set `isComplete = false`. A bad line mid-file is skipped and counted.
- **Never read** attachment payloads (including `credential_org`), `queue-operation.content`, `last-prompt`, or subagent `meta.json` `description`.

## 9. Technology

- **TypeScript on Node** (minimum version pinned in M1; target the current LTS).
- Tests: the built-in `node:test` runner unless M1 finds a concrete reason otherwise.
- Terminal: `picocolors` and `string-width` (exact column alignment including wide characters).
- Future visual renderer: Satori (JSX → SVG) and `@resvg/resvg-js` (SVG → PNG), with no headless browser. Fonts are bundled.
- Every dependency must be justified in the PR that adds it.
