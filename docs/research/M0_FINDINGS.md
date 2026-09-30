# M0 Findings: Claude Code local format

- **Tested against:** Claude Code **2.1.283** (older transcripts on disk: 2.1.202, 2.1.280, 2.1.282), Windows 11, Node 22.18.
- **Date:** 2026-09-28.
- **Method:** controlled headless sessions (`claude -p --model haiku`) in a throwaway scratch directory named `m0 lab/Proj.Dots_und-ü` (space, dots, underscore and a non-ASCII character on purpose), plus read-only inspection of existing transcripts. Probes print metadata and numbers only.
- **Cost of experiments:** about $0.20 of Haiku usage (per `cost-state`) across 8 short runs. The killed run's usage is unrecorded by design, see §3.

| Label | Meaning |
|---|---|
| **CONFIRMED** | Observed directly, reproduced, and pinned by a test or probe in this repo |
| **INFERRED** | Strongly supported, but not fully reproduced (e.g. only in headless mode, or only one sample) |
| **UNKNOWN** | Not safely or reliably determined |

Evidence tools:
- `scripts/m0/watch-transcript.mjs`: samples a transcript while it's being written.
- During M0, a probe script and a reference rule module with its own tests were used. In M1a they were replaced by the production parser (`src/source/claude-code/`), its tests (`test/source/`) and the development entry point `node src/dev/parse.ts --all --summary`, which prints the same metadata-only view. The originals are in git history (commit `9b061fb`).

---

## 1. Resumed sessions

| Finding | Status |
|---|---|
| `--resume <id>` and `--continue` **append to the same file** and keep the same `sessionId`. | CONFIRMED (headless). Test: `resumed` |
| Each process exit appends a new `cost-state`. Its values are **cumulative for the session file**, and `startTime` stays the original start. | CONFIRMED. Test: `resumed` (3 cost-states, strictly increasing) |
| `cost-state.totalDuration` is the **sum of process run times**, not wall-clock time. It rose 22.0 s → 25.7 s → 29.1 s across three runs spread over ~3 minutes. | CONFIRMED |
| `--fork-session` creates a **new sessionId and a new file**, and **copies the parent's history** into it: same record `uuid`s, same `message.id`s and `requestId`s, original timestamps, but `sessionId` rewritten to the fork's id. | CONFIRMED. Test: `forked` |
| The fork's `cost-state` **includes the parent's usage up to the fork** (fork 0.0606 = parent 0.0570 + its own 0.0036). | CONFIRMED |
| There is **no explicit link** from a fork to its parent (the parent sessionId appears nowhere in the fork file). A fork can only be detected by overlapping `uuid` / `message.id` with another transcript. | CONFIRMED |
| Interactive `/resume` behaves like `--resume` (appends). | INFERRED (not reproducible without a TTY) |
| Behaviour of `/clear`, `/compact` and rewind on file identity. | UNKNOWN (not tested in M0) |

**Implications:**
- One transcript file = one Claude Receipt session, and a session can span several runs and days. Wall-clock duration includes the gaps between them, so active time and `cost-state.totalDuration` matter.
- A resumed session's receipt covers everything in the file. Splitting into per-run segments at `cost-state` records is possible later.
- **Aggregation must deduplicate API calls globally by `message.id`**, or forks double-count tokens and cost.
- **A fork's `cost-state` must not be used as that session's own total.** Use the fork's non-inherited records instead.

## 2. Subagents / sidechains

| Finding | Status |
|---|---|
| Subagent transcripts live in `projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`, with a sibling `agent-<agentId>.meta.json`. | CONFIRMED. Test: `subagent` |
| Subagent records carry the **parent's `sessionId`** (no own session id), plus `agentId` and `isSidechain: true`. Parent records have `isSidechain: false`. | CONFIRMED |
| `meta.json` fields: `agentType`, `model`, `toolUseId` (links to the parent's Agent `tool_use`), `spawnDepth`, `requestShape`, `requestNonInteractive`, and `description` (**free text**, treat as private). | CONFIRMED |
| Parent and subagent share **no** `message.id`s, so there's no double counting inside a session. | CONFIRMED |
| **The parent's `cost-state` includes subagent usage.** Parent-only transcript totals fall short of it, and parent + subagent totals match it exactly. | CONFIRMED |
| The parent's Agent `toolUseResult` holds launch metadata (`agentId`, `status: async_launched`, `resolvedModel`, `outputFile`) but no token counts. | CONFIRMED |
| Nested subagents (depth > 1) are stored the same way. | UNKNOWN |

**Implication:** a session's source is its main file **plus** every `subagents/*.jsonl` under `<sessionId>/`. Discovery must scan both levels.

## 3. Live / incomplete transcripts

| Finding | Status |
|---|---|
| Claude Code appends **whole lines**. 7,545 samples taken every ~5 ms during a live run never saw a file ending mid-line. | CONFIRMED (one Windows run; `watch-transcript.mjs`) |
| Finished files end with `\n`. | CONFIRMED |
| **0-byte transcripts exist** on disk (a session opened with no activity). | CONFIRMED |
| A session **killed** mid-response has **no `cost-state`**, and the **in-flight response is never written** (no assistant record at all). The tokens it consumed are invisible. The file still ends cleanly. | CONFIRMED. Test: `killed` |
| Within one response, an earlier line can carry **partial streaming usage** (`stop_reason: null`, 4 output tokens) and a later line the final usage (407). | CONFIRMED (in a subagent file). Test: `subagent … last line must win` |
| `~/.claude/sessions/<pid>.json` lists running sessions (`sessionId`, `cwd`, `kind`, `entrypoint`, `status`, `startedAt`, `updatedAt`, `procStart`). **It goes stale when a process is killed**: the killed run's file remained with `status: "busy"` although the PID was dead. | CONFIRMED |
| Headless runs are registered as `kind: "interactive"` with `entrypoint: "sdk-cli"`. Normal CLI sessions have `entrypoint: "cli"`. | CONFIRMED |

**Parser rules** (implemented in `src/source/claude-code/jsonl.ts` and `discover.ts`, tested in `test/source/`):
- Read a snapshot. A final line that fails to parse is dropped and flagged `truncatedTail`. An unparseable line elsewhere is skipped and counted. A missing final newline on a valid line is fine.
- `isLive` = a `sessions/*.json` entry for the sessionId **and** its PID is running (optionally cross-checked with `procStart`). File existence alone is wrong.
- Never archive a live session as final. Re-archive when the fingerprint changes.

## 4. Windows path handling

| Finding | Status |
|---|---|
| Project dir name = `cwd` with **every character outside `[A-Za-z0-9]` replaced by `-`**: `\`, `:`, space, `.`, `_` and non-ASCII (`ü`). Checked against every transcript that has a `cwd` (12, in 6 project directories): 11/11 with names ≤ 200 characters matched, and the one long path is the truncation case below. | CONFIRMED |
| Names over **200 characters are truncated to 200 and given a hash suffix** (`…-ykgzkb`). Even re-encoding a known path can't reproduce the name. | CONFIRMED (219-char cwd → 207-char dir) |
| Claude Code **fails to start** in a directory whose path is over 260 characters (exit 126). | CONFIRMED |
| The `cwd` field in records keeps the exact path: drive letter, backslashes, and UTF-8 intact (`ü` round-trips). | CONFIRMED |
| The same folder typed with different case produces different project dirs (a lowercase `…-onedrive-desktop-…` dir exists alongside `OneDrive`). | INFERRED (its transcripts had been cleaned up, so its `cwd` couldn't be compared) |

**Rule:**
- Associate a transcript with its project **only via the `cwd` field** in its records. Never decode directory names.
- When grouping by project on Windows, compare `cwd`s case-insensitively with trailing separators stripped.
- The file name (minus `.jsonl`) is the sessionId, and records confirm it.

## 5. Token deduplication

| Finding | Status |
|---|---|
| One API response is written as **several `assistant` lines** (one per content block: thinking, text, tool_use) that repeat the same `message.id`, the same `requestId` and, when complete, identical `usage`. Naive summing double-counts (exactly 2× in the `ordinary` fixture). | CONFIRMED. Test: `ordinary` |
| Lines of one message can disagree when an earlier line was written mid-stream (see §3). **The last line in file order holds the final usage.** | CONFIRMED |
| Across all transcripts on disk: 0 cases of one `message.id` with two different `requestId`s. The only `message.id`s found in more than one file were fork copies (7). | CONFIRMED |
| Assistant records with model `<synthetic>` (client-generated, not API calls). | UNKNOWN (none observed; the rule skips them defensively) |

**Rule:**
- Key = `message.id`, falling back to `requestId`, then the record `uuid`. **The last line wins** within a file.
- Across files (forks), deduplicate globally by the same key, so each API call is counted once.
- `message.id` alone is sufficient: it's a server-issued, globally unique id, and a composite key (`message.id` + `requestId`) would add nothing, since both are copied together into forks.
- Deduplication rule: `src/source/claude-code/scan.ts` (within a file) and `session.ts` (across files). Tests: `test/source/claude-code.test.ts`, on the `ordinary`, `subagent` and `forked` fixtures.

## 6. cost-state reconciliation

Comparison of deduplicated transcript tokens (main file + subagent files) with the last `cost-state`, per model and per field (input, output, cache read, cache write, thinking):

| Session kind | Result | Status |
|---|---|---|
| Headless, with or without subagents, resumed, forked | **Exact match** on every field, including `thinkingTokens` (= sum of `usage.output_tokens_details.thinking_tokens`) | CONFIRMED (4 sessions) |
| Headless line counts | Edit/Write `structuredPatch` + Write create = `totalLinesAdded/Removed` exactly | CONFIRMED |
| Interactive | `cost-state` is **higher** than the transcript. Main model short by one or more full-context calls (e.g. −51,370 cache-read tokens), plus a Haiku model present **only** in `cost-state` | CONFIRMED (2 sessions) |
| Cause of the interactive gap: auxiliary calls (title generation, prompt suggestions, summaries, permission classifier) that are billed but not written as assistant records | INFERRED (no record identifies them) |
| `cost-state` exists even in sessions with zero API calls (opened and closed, $0) | CONFIRMED |
| `thinkingTokens` is a subset of `outputTokens` (not additional) | INFERRED (output ≥ thinking everywhere; not proven) |

**Warning versus error** (implemented as `reconcile()`, tested). Reconciliation never blocks a receipt:
- **info** (expected): `cost-state` exceeds the transcript, or a model appears only in `cost-state`. That's normal in interactive sessions.
- **warning**: the transcript **exceeds** `cost-state`, or a model appears only in the transcript. That means double counting or a format change.
- **error**: none. Errors are reserved for an unreadable source.

**Implication for metrics:**
- For a **completed, non-fork** session, `cost-state` is the most complete token and cost source, because it includes auxiliary calls.
- For live sessions, killed sessions and forks, the transcript-derived value is used and labelled `derived`, with a note that auxiliary calls are excluded.

## 7. Prompt counting

Observed `user` record shapes across all transcripts (tags and flags only):

| Shape | Human prompt? |
|---|---|
| string content, `promptSource: "typed"`, `origin.kind: "human"` (interactive) | **yes** (`typed`) |
| string content, `promptSource: "sdk"` (headless `-p`) | **yes** (`sdk`) |
| `<command-message>…` with `origin.kind: "human"`, no promptSource (skill/slash command that sends a prompt) | **yes** (`slash`); one sample, INFERRED |
| `<command-name>…`, `<local-command-stdout>…` (local slash commands like `/model`) | no (counted as slash commands) |
| `<local-command-caveat>…` with `isMeta: true` | no |
| `<bash-input>…` / `<bash-stdout>…` (user `!` shell commands) | no (user shell, not a prompt) |
| `<task-notification>…`, `promptSource: "system"` | no |
| list content with `tool_result` | no |
| `isMeta: true` text (injected context) | no |
| `isSidechain: true` (the subagent's task prompt) | no |

Rule: `promptKind()` in `src/source/claude-code/scan.ts`, pinned by `prompt-kinds.jsonl`. Status: **CONFIRMED** for typed, sdk, tool_result, isMeta, command/local-command, bash, task-notification and sidechain. **INFERRED** for `slash` (one sample).

**UNKNOWN:**
- The on-disk shape of a user interruption. `[Request interrupted…]` wasn't observed in any transcript. The fixture record for it is an **assumption**, not an observation, and must be replaced by a real sample.
- Messages queued while Claude is busy (`queue-operation` records exist but the promotion path wasn't traced).

Privacy note: `queue-operation.content`, `last-prompt.lastPrompt` and `ai-title.aiTitle` contain prompt or title text. The parser never needs them.

## 8. Plan detection

| Finding | Status |
|---|---|
| Transcripts, `cost-state`, `sessions/*.json` and the `-p` JSON result contain **no plan field**. (`-p` result has `costBasis: "list"` and `provider: "firstParty"`, which aren't plans.) | CONFIRMED |
| `~/.claude.json` (not the credentials file) has an `oauthAccount` object whose `organizationType` held a plan-like value of the form `claude_<plan>`. `billingType` held a payment-channel value (not a tier), and `seatTier` and `userRateLimitTier` were null. M0 read only key names plus these four enum values. The account's actual values are deliberately not recorded here. | CONFIRMED (field exists) |
| `organizationType` reliably maps to the plan (Pro/Max/Team/Enterprise), stays current (it's a cached profile with `profileFetchedAt`), and reflects the plan **at the time of a past session** | **UNKNOWN**: one sample, undocumented semantics, and it describes *now*, not when a session ran |
| API-key, Bedrock and Vertex users | UNKNOWN (no `oauthAccount` expected; not tested) |

**Decision (product, 2026-10-01):** **PLAN is removed from the product.** `organizationType` is not read: it is undocumented and reflects current rather than historical state. To be reconsidered only if Claude Code exposes reliable session-level plan information.

---

## Other observations

- `projects/<dir>/memory/` directories exist next to transcripts (Claude Code's auto-memory). They aren't session data and are ignored.
- `entrypoint` separates CLI sessions (`cli`) from headless/automation runs (`sdk-cli`). Product decision: headless sessions are included by default, and `entrypoint` is kept for future filtering.

## Addendum (2026-10-01): run boundaries

| Finding | Status |
|---|---|
| An interactive CLI exit writes **two** `cost-state` records, separated only by an untimestamped `last-prompt` (6 of 6 interactive sessions on disk; `totalDuration` differs by ~15 ms). Headless runs write one per run. | CONFIRMED |

**Rule:** a `cost-state` closes the current run. A further `cost-state` with no timestamped record since the previous one updates that same run's snapshot. Timestamped records after the last `cost-state` form an open run. "Runs = number of cost-states" (as first stated in METRICS) was wrong for interactive sessions.
- Attachment records (injected context: skills, hooks, environment, deferred tools) make up most of a small transcript's bytes and carry nothing Claude Receipt needs. `credential_org` attachments exist and must be skipped.
- The M0 lab sessions remain in `~/.claude/projects/…m0-lab…` and there's a stale `~/.claude/sessions/<pid>.json` from the killed run. Claude Receipt never modifies `~/.claude`. The user can remove them, and Claude Code's cleanup will too.

## Fixtures produced

`fixtures/claude-code/2.1.283/`, generated by `scripts/m0/build-fixtures.mjs` through the allowlist anonymizer `scripts/anonymize-fixture.mjs`:

| Fixture | Shows |
|---|---|
| `ordinary.jsonl` | Write (create), Edit, Bash success, Bash error, split responses (duplicate ids), completed cost-state |
| `resumed.jsonl` | 3 runs in one file, cumulative cost-states |
| `forked.jsonl` | Copied history with shared uuids/ids, new sessionId, inherited cost |
| `subagent/<sid>.jsonl` + `subagent/<sid>/subagents/agent-<id>.{jsonl,meta.json}` | Sidechain layout, partial-usage line |
| `killed.jsonl` | No cost-state, no assistant records |
| `write-update-replaceall.jsonl` | Write create → Read (`{type:"text", file:{…}}`) → Write **update** (own `structuredPatch`) → Edit with `replaceAll: true`. Lines match cost-state (+5 −2) |
| `no-tools.jsonl` | One prompt, zero tool calls (recorded in the >200-char path directory) |
| `truncated-tail.jsonl`, `no-final-newline.jsonl`, `unknown-record.jsonl`, `empty.jsonl` | Derived edge cases |
| `prompt-kinds.jsonl` | One record per observed user-record shape, with `_expect` |

Fixtures keep structure, numbers, timestamps, enum values, tool and model names, and system tags. Every other string is replaced by same-length `x`s (newlines kept). IDs and paths are mapped consistently across files. `test/fixture-safety.test.mjs` proves planted secrets don't survive, and that every string in every fixture has a known-safe shape.
