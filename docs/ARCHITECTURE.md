# Architecture

Status: implemented through M3: `source/claude-code` and the Session (M1a), `analytics`, the Receipt model and its JSON contract, read-only `git` enrichment (M1b), the local `archive` (M2), and the `cli` with its archive sweep and the terminal renderer (M3). Aggregation and the image renderer are specification only; their field names may be refined when built, but the boundaries may not.

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
                                                     render/tty    render/json    render/svg   aggregate ──► HistoryReceipt
                                                                               + render/png    (v0.2: Receipts from the archive and the current sweep → all/week/month; wrapped later)
```

## 2. Modules

| Module | Responsibility | Knows about |
|---|---|---|
| `source/claude-code` | Find transcripts, stream-parse JSONL, deduplicate, build a `Session` | Claude Code's file format (the **only** module that does) |
| `git/` | Given a `cwd` and a time window, return `GitFacts` by running `git` read-only | The `git` CLI |
| `analytics/` | Pure functions: `(Session, GitFacts?) → Receipt` (`buildReceipt`) | Session, GitFacts, pricing table, metric registry |
| `receipt/` | The Receipt model, metric registry and schema validator | Nothing else (shared by analytics, renderers, archive) |
| `archive/` | Read and write `ArchiveEntry` files, migrate old schema versions | Receipt, ArchiveEntry |
| `aggregate/` (v0.2) | `Receipt[]` + scope → `HistoryReceipt` (`src/aggregate/`): pure, no I/O, no clock, no transcripts; definitions in `METRICS.md` → Historical metrics | Receipt (the CLI candidate pool: archived and freshly built) |
| `render/view` | Receipt → `ReceiptView` (`sessionView`) and HistoryReceipt → `ReceiptView` (`historyView`), in `src/render/view.ts`: what a printed receipt says, in order (header rows, optional band, sections of rows with provenance and metric ids, emphasis, footnotes). Presentation structure only: no semantic fields, widths, coordinates, ANSI or SVG | Receipt, HistoryReceipt (and `format`) |
| `render/tty` | ReceiptView → terminal text (`src/render/tty.ts`): fits 28–40 columns, leaders, provenance marks, optional ANSI | ReceiptView |
| `render/json` | Receipt or HistoryReceipt → versioned JSON (each contract as is) | Receipt, HistoryReceipt |
| `render/visual` + `render/svg` | ReceiptView → VisualDoc layout (`src/render/visual/`; `layoutReceipt` = `layoutView(sessionView(r))`) → SVG string (`src/render/svg.ts`) → PNG bytes (`src/render/png.ts`, resvg-wasm at 2×); written by `claude-receipt export` (`src/cli/export.ts`) | Receipt (and the bundled font bytes, loaded by the caller via `src/assets.ts`) |
| `cli` | `src/cli/`: argument parsing, the archive sweep, choosing a session or a history period, wiring the above | Everything, but only as glue |

**Rendering path (v0.2):** `Receipt → sessionView() → ReceiptView` and `HistoryReceipt → historyView() → ReceiptView`; the terminal and the visual layout render any `ReceiptView`, so session and history receipts share one visual language (leaders, marks, legend, total rule, unavailable count). Renderer-facing rows carry metric ids as plain strings (a presentation boundary); the Receipt and HistoryReceipt models keep their typed ids.

**History (v0.2, `claude-receipt all | week | month [--project]`):** every run sweeps first, as for any command; the history aggregates the sweep's candidate pool: archived finished sessions plus finished sessions built in this run, keyed by session id so a session that is both archived and on disk counts once. `--no-archive` only stops archive writes; discovery and aggregation are unchanged, and an archive write failure is reported on stderr while the history still uses the pool. `--project` keeps sessions whose `projectKey` equals the current directory's key (the v0.1 key: case-insensitive for Windows paths), never a name match. Period, live, undated and partial-coverage rules: `METRICS.md` → Historical metrics. `--redact` applies `redactHistory` (`src/receipt/redact.ts`) before rendering or JSON; `--json` prints the validated HistoryReceipt. `export all | week | month` writes the history image through the same visual pipeline (`exportHistory`: `layoutView(historyView(h))` → SVG → 2× PNG), redacted by default.

Shared helpers used by several renderers (duration and number formatting, labels and microcopy keyed by metric id, provenance marks and legend) live in one small `format` module (`src/render/format.ts`), so TTY and SVG say the same things. Export redaction (`PRIVACY.md` §6) is a pure Receipt → Receipt transform (`src/receipt/redact.ts`) shared by `--redact` in text and JSON.

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
- *Archive (M2)*: an ArchiveEntry stores this Receipt minus `session.title` (§6); `session.projectKey`, `entrypoint`, `forkOf` and `sourceSchemaVersion` are already here.
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

Implemented in `src/archive/index.ts` (M2). A local, metrics-only record of session Receipts that outlives Claude Code's transcript cleanup.

**Location:** `~/.claude-receipt/archive/`, or `$CLAUDE_RECEIPT_HOME/archive/`. Never inside `~/.claude`. Created on first write.

**Layout:** one file per session, `archive/<key>.json`. There is no database. At expected volumes (a few thousand sessions per year) a directory of small JSON files is simple, inspectable and easy to delete.

**Performance (v0.2): no archive index is required for v0.2.** `scripts/bench-archive.ts` builds synthetic archives of 1,000 and 5,000 validated entries in a temporary home. On the benchmark machine a complete `claude-receipt all` takes about 0.4–0.7 s at 1,000 sessions and about 1.4–2.2 s at 5,000 (the range is the same machine under different load). Nearly all of it is reading, parsing and validating every entry (about 0.3–0.4 ms each, content hash included); aggregation is negligible (about 0.1 s for `all` at 5,000, milliseconds for `week` and `month`). 5,000 sessions is more than a year of heavy use, and every command reads the archive this way, so an index or a validated-entry cache is worth revisiting only when real archives approach that size or commands become noticeably slow. Numbers depend on the machine.

```ts
interface ArchiveEntry {
  archiveSchemaVersion: 1;
  key: string;                          // archiveKey(receipt.session.id), also the file name
  archivedAt: string;                   // first written (ISO UTC)
  updatedAt: string;                    // last written (a continuation of the same session)
  contentHash: string;                  // sha256 of the canonical Receipt without generatedAt
  source: { bytes: number; mtimeMs: number };   // transcript fingerprint: main + subagent files, no paths
  receipt: Receipt;                     // the session Receipt with session.title = null
}
```

**Identity (the key).** `archiveKey(sessionId) = sha256("claude-receipt/archive-key/v1\0" + adapter + "\0" + sessionId)`, first 32 hex characters.
- Filesystem-safe on every platform: 32 lowercase hex characters, so no separators, reserved names (`CON`), case-folding collisions or path traversal, whatever the id contains.
- Deterministic and stable: the same session always maps to the same file, so re-archiving never duplicates.
- Collision-resistant (128 bits) and namespaced by source adapter; independent of project paths, so moving or renaming a project doesn't change it. It reveals nothing beyond what the entry already contains.
- Built only from the session id. No API-call, message, tool-use or agent id is used or stored.

What that means for each kind of session:
- *Normal session:* one entry.
- *Resumed session:* same session id, so the same entry, updated as a continuation when its transcript grows (all runs in one Receipt).
- *Fork:* its own session id, so its own entry, with `receipt.session.forkOf` naming the parent and only its own activity counted.
- *Fork whose parent transcript has disappeared before it was first archived:* not detectable (`M1_FINDINGS.md` §3.1), so archived as an ordinary session including the copied history. A fork archived while its parent existed keeps `forkOf`: a later receipt that lost it is refused (below).
- *Multiple projects / Windows paths:* identity doesn't involve the project; grouping uses `receipt.session.projectKey` (case-insensitive for Windows paths).
- *Duplicate transcripts with the same session id* (e.g. a copied project folder): same key; identical content is a no-op, anything else is a conflict.

**Writing (`writeReceipt(receipt, source)`)** returns `created`, `unchanged`, `updated`, `conflict` or `rejected`:
- *Rejected* (nothing written): a live session (archive it once it has ended), a Receipt that fails `validateReceipt`, an unsupported Receipt `schemaVersion`, an invalid fingerprint.
- *Idempotent:* if the stored `contentHash` equals the new one, the entry is `unchanged` and not rewritten. `generatedAt` is excluded from the hash, so rebuilding the same Receipt later is a no-op.
- *Continuation:* a differing Receipt replaces the entry only if it's the same session, its transcript grew (`source.bytes` larger), it doesn't end earlier, it keeps a known `forkOf`, and it was made by the same generator version in the same time zone. `archivedAt` is kept, `updatedAt` changes.
- *Conflict* (nothing written, existing history untouched): anything else, including an existing entry that is malformed, invalid or of an unsupported version. Recomputing history with a newer generator will be an explicit operation in a later milestone, never a silent overwrite.
- *Atomic:* the entry is written to a temp file in the same directory (`<key>.json.tmp-<pid>-<random>`), flushed, then renamed over `<key>.json`. A reader sees the old entry or the new one, never a partial file under the entry's name. A crash can leave a temp file; readers ignore it, and it's never deleted automatically.

**Reading (`readArchived(sessionId)`, `listArchive()`).** Each file is parsed, migrated if needed, and validated before use:
- `ok`, or `missing` / `malformed` (not JSON, or not an object) / `unsupported` (an `archiveSchemaVersion` newer than supported, or an unsupported Receipt `schemaVersion`) / `invalid` (fails `validateEntry`: unknown fields, key or hash mismatch, a title, a live session, an invalid Receipt).
- `listArchive()` returns the valid entries sorted by session start, plus the problem files. Only `<32 hex>.json` names are considered; temp and foreign files are ignored. Nothing is ever deleted or repaired.

**Schema evolution.** `archiveSchemaVersion` is explicit and checked on every read. `migrateEntry` applies `MIGRATIONS[n]` (version n → n+1) step by step up to the current version; the table is empty while only v1 exists. A version newer than supported, or a missing step, is `unsupported`, never guessed at. When a transcript still exists, re-computing from source is preferred to migrating.

**Contents guarantee:** an ArchiveEntry contains the Receipt (minus `session.title`), a size/mtime fingerprint and hashes, and nothing else; `validateEntry` rejects any other field. See `PRIVACY.md` §5.

**The sweep (M3, `src/cli/sweep.ts`).** Every CLI run (unless `--no-archive`):
1. Reads the archive once (`listArchive`) and the live-session list.
2. For each Claude Code project directory: if every session in it matches its archived fingerprint (`source.bytes` and `source.mtimeMs` from `stat`, no parsing) and none is live, the project is **skipped** and its archived Receipts are used.
3. Otherwise the **whole project** is parsed (fork detection needs every sibling), and Receipts (with git facts) are built and written only for sessions whose fingerprint changed or that are live; unchanged siblings reuse their archived Receipt. `writeReceipt` decides: live sessions are rejected, identical content is unchanged, growth is an update, anything else is a conflict (§6 above). The sweep never overrides those rules.
4. Archived sessions whose transcript is gone join the candidate pool from the archive.

Write failures (e.g. permissions) stop further writes for that run and are reported; the run continues read-only. Conflicts, unreadable entries and non-live rejections are reported on stderr. A session archived by an older generator whose transcript hasn't changed stays as archived (it is skipped by fingerprint): recomputation is never silent, and the CLI notes when the receipt it shows differs from the archived one.

**Deliberately deferred:**
- Explicit recomputation of archived entries with a newer generator, and entry migrations beyond v1.
- Deletion, pruning and retention: only "delete the directory" today; a `claude-receipt archive --purge` may come later.
- Archive-assisted fork detection for forks whose parent transcript is gone: it would need call identifiers in the archive, which the archive deliberately doesn't store.

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

- **TypeScript on Node ≥ 24.** Node runs the `.ts` sources directly (type stripping), so there is no build step during development; `tsconfig.json` uses `erasableSyntaxOnly` to keep the code strippable. `tsc` only type-checks (`noEmit`).
- Runtime dependency: `@resvg/resvg-wasm` (pinned exactly), used only to rasterize the SVG for PNG export. Dev-only: `typescript`, `@types/node`.
- Tests: the built-in `node:test` runner.
- Terminal: no libraries. ANSI codes and display width (wide and combining characters) are implemented in `src/render/` and `format.ts`.
- Packaging (`docs/RELEASE.md`): development runs the TypeScript sources; the npm package ships `dist/`, compiled by plain `tsc` (no bundler), with the fonts and licences.
- Visual renderer (M6, `docs/VISUAL_RECEIPT.md`): Receipt → pure layout model (`VisualDoc`) → hand-written deterministic SVG (canonical) → PNG via `@resvg/resvg-wasm` (pinned; WebAssembly, no native binaries, no system fonts). No Satori, no React or frontend framework, no headless browser. IBM Plex Mono (OFL-1.1) bundled unmodified.
- Every dependency must be justified in the PR that adds it.
