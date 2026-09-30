# Architecture

Status: implemented through M1b: `source/claude-code` and the Session (M1a), `analytics`, the Receipt model and its JSON contract, and read-only `git` enrichment (M1b). The archive, renderers and product CLI are specification only; their field names may be refined when built, but the boundaries may not.

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
| `analytics/` | Pure functions: `(Session, GitFacts?) → Receipt` (`buildReceipt`) | Session, GitFacts, pricing table, metric registry |
| `receipt/` | The Receipt model, metric registry and schema validator | Nothing else (shared by analytics, renderers, archive) |
| `archive/` | Read and write `ArchiveEntry` files, migrate old schema versions | Receipt, ArchiveEntry |
| `aggregate/` (future) | `ArchiveEntry[] → PeriodReceipt` | ArchiveEntry |
| `render/tty` | Receipt → terminal text (layout, colour, `~` markers, microcopy) | Receipt |
| `render/json` | Receipt → versioned JSON | Receipt |
| `render/svg` (future) | Receipt → SVG → PNG | Receipt |
| `cli` | Argument parsing, choosing a session, wiring the above | Everything, but only as glue |

Shared helpers used by several renderers (duration and number formatting, the microcopy table keyed by metric id) live in one small `format` module, so TTY and SVG say the same things.

**Rules:**

- Nothing outside `source/claude-code` reads raw records or knows field names like `toolUseResult`, `cost-state` or `structuredPatch`.
- `analytics/` does no I/O. Pricing is a dated data table (`src/analytics/pricing.ts`, overridable via `buildReceipt` options); git facts and the time zone are passed in.
- Renderers never compute metrics. If a renderer needs a number, it belongs in the Receipt.
- No plugin framework or adapter registry. When a second source format appears, `source/` gains a second module and `cli` chooses; nothing else changes.

## 3. Normalized Session model

**Source of truth: [`src/source/claude-code/types.ts`](../src/source/claude-code/types.ts)** (implemented in M1a, `SESSION_SCHEMA_VERSION = 1`). This section summarizes it; the file wins if they disagree.

Plain, serializable data (a Session round-trips through `JSON.stringify` unchanged). **It contains no free text:** no prompts, responses, file contents, patches, command strings or tool output. The single exception is the optional Claude Code–generated `title`, which is display-only and never archived (`PRIVACY.md` §3). Every retained field is listed in `PRIVACY.md` §3.

| Field | Meaning |
|---|---|
| `schemaVersion`, `id` | Model version; Claude Code sessionId (= main file name) |
| `source` | `main` and `subagents` files (path, bytes read, mtime), `clientVersions` |
| `entrypoint` | `cli`, `sdk-cli`, `claude-desktop`, …; headless sessions are included, filtering is possible later |
| `project` | `cwd` from records (never decoded from dir names), `key` (case-insensitive grouping key for Windows paths), `name`, `otherCwds`, `gitBranches` |
| `startedAt`, `endedAt` | Own records only: a fork's copied history is excluded |
| `status` | `live` (running PID), `complete`, `empty`, `truncatedTail`, `badLines` |
| `fork` | `{ parentSessionId, inheritedRecords, inheritedApiCalls }` or `null` |
| `title` | `ai-title`, display only |
| `runs[]` | `{ index, startedAt, endedAt, closed, costState }`: one per process run; the basis for a future `--run` |
| `prompts[]` | `{ ts, run, kind: typed \| sdk \| slash, chars }` |
| `turns[]` | `{ ts, run, durationMs, messageCount }` from `turn_duration` |
| `apiCalls[]` | `{ key, ts, run, agentId, model, final, stopReason, serviceTier, speed, usage }`, one per `message.id`, usage from the last line, own calls only |
| `toolCalls[]` | `{ id, name, ts, run, agentId, promptIndex, status: ok \| error \| no-result, interrupted, file, command, agentType, skill }` |
| `toolCalls[].file` | `{ path, op: read \| create \| update \| edit \| write, added, removed }`; line counts `null` when unknown |
| `toolCalls[].command` | `{ shell, program, category, git }`: `program` from a fixed allowlist, else `other`; never the command string |
| `slashCommands[]` | `{ ts, run, name }`, name only (e.g. `/model`), never arguments |
| `subagents[]` | `{ agentId, agentType, model, parentToolUseId }` from `meta.json` (never `description`) |
| `costState` | Last cumulative `cost-state` snapshot (includes subagents; for forks, inherited usage) |
| `reconciliation` | `Finding[]` (info / warning) or `null` without a cost-state |
| `warnings[]` | `{ code, count }`, e.g. `unknown-record-type:custom-title`, `truncated-tail`, `synthetic-message` |

Every prompt, API call, tool call, turn and slash command carries its `run` index, and subagent items carry `agentId`, so per-run and per-agent views can be derived later without re-parsing.

Implementation: `scan.ts` streams one file and reduces each record to text-free drafts (the only code that reads raw records); `session.ts` assembles Sessions, detects forks and reconciles; `discover.ts` finds files and live sessions; `commands.ts` classifies shell commands; `index.ts` is the public surface. `src/dev/parse.ts` is a development entry point, not the product CLI.

## 4. Receipt model

**Source of truth: [`src/receipt/types.ts`](../src/receipt/types.ts)** (implemented in M1b, `RECEIPT_SCHEMA_VERSION = 1`), checked by [`src/receipt/validate.ts`](../src/receipt/validate.ts). The Receipt is the output of analytics and the input of every renderer and of the archive.

**Rule: the Receipt contains semantic data, never presentation copy or layout.** Values may be numbers, booleans or strings, as long as they mean something independently of how they're shown: model names, language names, file names, project identifiers, versions, archetype ids. What does not belong in the Receipt: labels and headings, formatted values (`1h 42m`, `$12.84`, `12.3k`), playful microcopy, ANSI codes, padding, column widths or anything visual. Those belong to the `format` module and renderers.

```ts
interface Receipt {
  schemaVersion: 1;
  kind: "session";                    // later: "project" | "week" | "month" | "wrapped"
  generatedAt: string;                // ISO UTC
  generator: { name: "claude-receipt"; version: string; pricingTableDate: string };
  context: { timeZone: string };      // IANA zone used for local-time metrics (peak hour)
  session: {
    id: string; sourceSchemaVersion: number; project: string | null; projectKey: string | null; cwd: string | null;
    entrypoint: string | null; title: string | null; startedAt: string | null; endedAt: string | null;
    live: boolean; complete: boolean; forkOf: string | null; clientVersions: string[];
  };
  sections: { hard: Metric[]; coding: Metric[]; lore: Metric[] };
  warnings: { code: string; count: number }[];   // parser warnings + analytics ones (e.g. pricing:unpriced:<model>)
}

interface Metric {                    // one per id in the METRICS registry, typed per id (MetricValueMap)
  id: MetricId;                       // stable registry id, e.g. "tokens.output" (see METRICS.md)
  provenance: "exact" | "derived" | "heuristic";   // of the value, or of the value it would have had
  value: MetricValueMap[id] | null;   // null = unavailable, never 0-as-unknown
  unit?: "ms" | "tokens" | "usd" | "count" | "lines" | "hour" | "ratio";
  unavailableReason?: string;         // present exactly when value is null
  sensitive?: true;                   // paths, tool/server names: renderers redact in exports
  detail?: Record<string, unknown>;   // structured extras (per-model breakdowns, sources, histograms), never prose
}
```

- **Every** registry metric appears exactly once, in registry order, in its registry section; the validator enforces ids, sections, units, `sensitive`, value shapes, and the null ⇔ reason rule, and rejects unknown fields (so presentation copy can't creep in).
- Labels, headings and microcopy come from the `format` module, keyed by `Metric.id` (and by semantic values such as a personality archetype id). This keeps the JSON contract stable when wording changes.
- Order within a section is the rendering order. The renderer may drop items to fit, but may never alter values or provenance.
- Every renderer must keep `exact`, `derived` and `heuristic` visually and semantically distinguishable (`METRICS.md` → Rendering rule); `provenance` is on every metric so no renderer has to guess.
- `render/json` (`src/render/json.ts`) emits exactly this structure. Adding fields or metric ids is non-breaking. Removing or renaming them, or changing a value's type, requires `schemaVersion` + 1.

**Designed for what comes next:**
- *Terminal and SVG/PNG renderers*: everything needed is semantic (values, units, provenance for `~`, `sensitive` for redaction); nothing needs re-deriving.
- *Archive (M2)*: an ArchiveEntry stores this Receipt minus `session.title`; `session.projectKey`, `entrypoint`, `forkOf` and `sourceSchemaVersion` are already here. Hashed API call keys come from the Session at archive time (§6).
- *Week/month aggregation and Wrapped*: per-model token and cost breakdowns (`detail.byModel`), `languages`, `toolCalls.byName`, `commands.topPrograms`, the local-hour histogram (`lore.peakHour.detail.byHour`, kept even when the session is too short for a peak), and `context.timeZone` let aggregates be built from receipts alone, after transcripts are cleaned up.

## 5. Git integration

Implemented in `src/git/index.ts` (M1b). `gitFacts(cwd, startedAt, endedAt)` runs only `git rev-parse` and `git log` in the session `cwd`, with `GIT_OPTIONAL_LOCKS=0`, `core.fsmonitor=false`, no prompts and a timeout:

```ts
type GitFacts =
  | { status: "ok"; hasCommits: boolean; window: { since: string; until: string };
      commits: { sha: string; ts: string; claudeCoAuthored: boolean; added: number; removed: number }[] }
  | { status: "no-cwd" | "no-window" | "not-a-repo" | "git-unavailable" | "error" };
```

- The window is `[startedAt, endedAt + 5 min]` by committer date (commit timestamps can trail the last transcript record slightly), over **local branches and HEAD** (`--branches HEAD`, so a detached HEAD is covered); commits fetched from others stay out unless merged locally.
- Commit messages and author identities are never read into `GitFacts`. `Co-Authored-By` trailer values are checked in memory for "Claude"/`noreply@anthropic.com` and dropped; only the boolean remains. SHAs are sensitive in exports.
- An **empty repository** (no commits yet) is `status: "ok", hasCommits: false`: zero commits in the window is a true zero, so `commits.inWindow` is `0` (exact), not null. Missing `git`, not a repository, a missing directory or a session without timestamps give `null` with the matching reason.
- Analytics stays pure: the caller runs `gitFacts` and passes the result to `buildReceipt`; git metrics are `null` ("git enrichment not run") when it doesn't.

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
2. **Narrow guards at the boundary.** `scan.ts` reads each field it uses through small type guards (`str`, `num`, `obj`, `arr`): a field with an unexpected type becomes `null`/0 for that item rather than crashing or leaking through. No schema library: the standard library covers it.
3. **Versioned fixtures**: `fixtures/claude-code/<version>/<scenario>.jsonl`. When a new Claude Code version changes something, add a fixture for it; old fixtures stay and must keep passing.
4. **Record the `version` field** per session (`clientVersions`) so format-dependent logic can branch if it must.
5. **Reconciliation as a canary**: when `cost-state` is present, compare our token sums per model to it. A mismatch becomes a warning, which is the earliest signal that the format changed.

## 8. Key parsing rules (verified in M0)

Evidence and status for each rule: `docs/research/M0_FINDINGS.md`; limitations and real-data notes: `docs/research/M1_FINDINGS.md`. Implementation: `src/source/claude-code/`; tests: `test/source/`.

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
- **Partial final line**: drop it, flag it, set `status.complete = false`. A bad line mid-file is skipped and counted. Reads are bounded to the file size at open, so lines appended during parsing are ignored.
- **Runs:** a `cost-state` closes a run; a second one with no timestamped record since updates the same run (interactive exits write two); timestamped records after the last one form an open run.
- **Unknown record types** are read no further than their `type`, counted in `warnings` as `unknown-record-type:<type>`, and change nothing else. `<synthetic>` assistant messages (client-generated API error notices, zero usage) are skipped and counted as `synthetic-message`.
- **Never read** attachment payloads (including `credential_org`), `queue-operation.content`, `last-prompt`, or subagent `meta.json` `description`.

## 9. Technology

- **TypeScript on Node ≥ 24.** Node runs the `.ts` sources directly (type stripping), so there is no build step during development; `tsconfig.json` uses `erasableSyntaxOnly` to keep the code strippable. `tsc` only type-checks (`noEmit`). Packaging for npm will need a build step, decided when the CLI ships.
- Runtime dependencies: none so far. Dev-only: `typescript`, `@types/node`.
- Tests: the built-in `node:test` runner.
- Terminal: `picocolors` and `string-width` (exact column alignment including wide characters).
- Future visual renderer: Satori (JSX → SVG) and `@resvg/resvg-js` (SVG → PNG), with no headless browser. Fonts are bundled.
- Every dependency must be justified in the PR that adds it.
