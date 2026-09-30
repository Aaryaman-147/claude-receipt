# M1a Findings: parser on real data, performance, limitations

- **Date:** 2026-10-01. Node 26.7 (Windows 11). Claude Code versions seen: 2.1.202, 2.1.280, 2.1.282, 2.1.283, 2.1.284.
- **Scope:** the production source adapter (`src/source/claude-code/`) run read-only over every local session, printing counts only (`node src/dev/parse.ts --all --summary`), plus a synthetic performance check.

Status labels as in `M0_FINDINGS.md`: **CONFIRMED**, **INFERRED**, **UNKNOWN**, plus **LIMITATION** for a known gap in what the parser can do (by design or because the data isn't there).

## 1. Real-data observations

16 local sessions parsed: 8 `cli`, 6 `sdk-cli` (M0 lab runs), 1 `claude-desktop`, and 1 0-byte file (no entrypoint).

| Observation | Status |
|---|---|
| A new entrypoint, `claude-desktop` (Claude Desktop's Claude Code), on version 2.1.284. It parsed with no errors. | CONFIRMED |
| That session contains two record types unknown in M0: `custom-title` (36×, keys `type, customTitle, sessionId`) and `agent-name` (35×, keys `type, agentName, sessionId`). They have no `timestamp` and no `uuid`, so they can't affect runs, bounds or deduplication. Their values are user-facing free-text names. | CONFIRMED |
| **Unknown records are safely ignored and surfaced:** the parser reads them no further than `type`, counts them (`warnings: unknown-record-type:custom-title ×36`, `…:agent-name ×35`) and changes nothing else. The same guarantee is pinned by the `unknown-record` fixture test. No parsing was added for them: nothing in the Session needs their semantics, and their values are free text. | CONFIRMED |
| **`<synthetic>` assistant messages exist** (3 in the Desktop session). All have `isApiErrorMessage: true`, zero usage, `stop_reason: stop_sequence` and a text block: client-generated API error notices, not API calls. The parser skips them and counts `synthetic-message`, so no tokens are lost. Whether they're worth surfacing as an "API errors" count is an M1b metric question. | CONFIRMED (semantics INFERRED from `isApiErrorMessage`) |
| Interactive `cli` sessions with a `cost-state` reconcile with **info-level findings only** (6 info, 0 warnings each: an auxiliary Haiku model plus main-model tokens not in the transcript), exactly as M0 §6 predicted. Headless sessions reconcile exactly. | CONFIRMED |
| Live sessions (this one and the Desktop session) are reported `live: true, complete: false` with no cost-state; the stale `sessions/*.json` left by the M0 killed run is not treated as live. | CONFIRMED |
| Leak check over main and subagent files: 1,279 raw strings of ≥ 20 characters (prompts 89, responses 74, thinking 41, commands 121, file contents 94, edit old/new strings 213, patches 114, tool outputs 310, stdout 100, stderr 22, tool errors 19, queued prompts 11, custom titles 36, agent names 35): **0** appear anywhere in the Session JSON. | CONFIRMED |
| Reconciliation totals across all 16 sessions: 18 info findings, 0 warnings. | CONFIRMED |

## 2. Performance

Synthetic transcripts were built from anonymized fixture lines, with ids rewritten per copy so deduplication keeps every record, and 20 KB of padding per tool result to stand in for large tool outputs. Measured by sampling RSS every 5 ms during `loadSessions`:

| File | Lines | Parse time | RSS growth during parse | Session JSON |
|---|---|---|---|---|
| 10 MB | 5,525 | 0.05 s | +11 MB | 0.4 MB |
| **50 MB** | 27,625 | **0.37 s** | **+17 MB** | 2.1 MB |
| 100 MB | 55,185 | 0.95 s | +19 MB | 4.2 MB |

- **Streaming:** yes. `readJsonl` reads through `readline` over a bounded `createReadStream`, one line at a time. Memory growth is far below file size and nearly flat from 50 to 100 MB.
- **The raw transcript is not retained.** Each record is reduced to small drafts (ids, timestamps, numbers, allowlisted names) and then discarded. What does grow with the file is the Session itself: one entry per API call, tool call, prompt and timestamped record.
- **Caveats:** the synthetic file has an unusually high number of runs and prompts per MB. Peak RSS includes the Node baseline (≈ 100–300 MB here, mostly from generating the test file in the same process). The 3 s target in the roadmap is met by a wide margin.

## 3. M0 rules that are not implemented exactly

Every rule the parser relies on, where it falls short of exact.

| # | Rule / behaviour | Status | What the parser does | Consequence |
|---|---|---|---|---|
| 1 | Fork detection needs the parent transcript | **LIMITATION** | Forks are detected only among sessions parsed together (`loadProject` / `findSession` parse the whole project directory). If the parent was cleaned up, the fork looks like an ordinary session that includes its copied history. | Double counting in future aggregates for such forks. M2 decided not to archive call identifiers (hashed or not), so this stays a limitation; a fork archived while its parent existed keeps `forkOf`, and the archive refuses to let a later receipt drop it. Tested: "a fork parsed without its parent is not detected". |
| 2 | Fork chains (a fork of a fork) | **UNKNOWN** (untested) | Each copied record is attributed to the earliest session containing it, so inherited records are excluded correctly. But `parentSessionId` is the session with the most overlapping records, which may be the root rather than the immediate parent. | Wrong parent label possible; counts unaffected (by reasoning, not by test). |
| 3 | Forks across project directories | **UNKNOWN** | Only sessions in the same project directory are compared. `--fork-session` keeps the `cwd`, so this is expected to be enough. | A fork into another directory would go undetected. |
| 4 | Shape of a user interruption (Esc) | **UNKNOWN** | Never observed. `promptKind` excludes text starting with `[Request interrupted` (assumed shape, in the `prompt-kinds` fixture). `interrupted` on tool calls comes only from Bash results' `interrupted: true` (observed field). | A user interruption may be miscounted as a prompt or not counted at all. |
| 5 | Top-level `agent-*.jsonl` files (older Claude Code versions) | **UNKNOWN** | Not special-cased: any top-level `*.jsonl` is a session. | If they exist on someone's machine, they'd appear as separate sessions, and their usage would not be joined to the parent. |
| 6 | Nested subagents (depth > 1) | **UNKNOWN** | Only `<sessionId>/subagents/*.jsonl` is read, one level. | Deeper storage, if it exists, would be missed. |
| 7 | Interactive `/resume` appends like `--resume` | **INFERRED** | Any appended activity after a cost-state becomes a new run. | If interactive resume forks or copies instead, rule 1 applies. |
| 8 | `/clear`, `/compact`, rewind | **UNKNOWN** | Any new record types they write become unknown-record warnings. | Counts are safe; semantics (e.g. compaction boundaries) are not modelled. |
| 9 | `slash` prompt kind (`<command-message>` + `origin.kind: human`) | **INFERRED** (one sample) | Counted as a prompt. | Possible over- or under-count of skill/slash prompts. |
| 10 | Prompts queued while Claude is busy | **UNKNOWN** | `queue-operation` records are used only as timestamps. | A queued prompt that is never written as a `user` record would be missed. |
| 11 | Cause of the interactive reconciliation gap | **INFERRED** | Reported as info. | Token source selection (cost-state vs transcript) is an M1b decision in `METRICS.md`. |
| 12 | `thinking` tokens are a subset of `output` | **INFERRED** | Stored separately, never added. | None until analytics uses them. |
| 13 | `<synthetic>` messages are API error notices | **INFERRED** (`isApiErrorMessage: true`, zero usage) | Skipped, counted as a warning. | None for tokens. |
| 14 | Tool result ↔ tool call link | **INFERRED** | `tool_result.tool_use_id` for status. Structured results are attached via `sourceToolUseID`, or the record's single `tool_result`. | A record with several tool results and no `sourceToolUseID` gets statuses but no line counts. |
| 15 | Write whose result is missing (killed or live) | **LIMITATION** | `op: "write"` with `added/removed: null`. | Create vs update unknown; lines unknown. |
| 16 | Killed run's in-flight response | **LIMITATION** (source) | Never written by Claude Code, so it's invisible. | Tokens under-reported for killed sessions. |
| 17 | Live detection and PID reuse | **LIMITATION** | A running PID means live; `procStart` is not compared. | A reused PID could make a dead session look live (rare; it self-corrects once the PID ends). |
| 18 | Case-variant project directories | **INFERRED** | `project.key` lowercases Windows `cwd`s so they group together; directories are never merged or decoded. | None known. |
| 19 | Timestamp ordering | **INFERRED** | ISO strings compared lexically; every observed timestamp is UTC `…Z` with milliseconds. | A format change (offsets, no ms) would mis-order runs. |
| 20 | Subagent items' run | **INFERRED** | Assigned by timestamp to the main run whose window contains it. | Only matters for a future `--run`. |
| 21 | Command classification | **LIMITATION** (heuristic by design) | First meaningful segment decides `program`/`category`; any segment decides `git: commit/push`; unknown programs become `other`. | `tests.runs` stays heuristic, as `METRICS.md` says. |
| 22 | `CLAUDE_CONFIG_DIR` relocation | **INFERRED** | Honoured by `claudeHome()`. | Not verified on this machine. |

## 4. Fixture changes in M1a

The anonymizer now:
- maps `gitBranch` values to stable fake names (`branch-1`, …) instead of blanking them to `x`s, because branch names are retained Session metadata and blanked values looked like leaked text;
- keeps `subagent_type` when it's one of the allowlisted agent types (`general-purpose`, `Explore`, `Plan`), like `agentType` in `meta.json`.

Structural effect on the 11 regenerated fixtures: `"gitBranch":"xxxx"` becomes `"gitBranch":"branch-1"` on every record that has a branch, and `"subagent_type":"xxxxxxxxxxxxxxx"` becomes `"subagent_type":"general-purpose"` in the subagent parent. Nothing else changes: line counts, byte lengths of all other strings, ids and numbers are identical. `empty.jsonl` and `prompt-kinds.jsonl` (no branch values) are unchanged.
