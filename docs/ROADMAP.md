# Roadmap

The MVP (`v0.1`) is **M0–M4**. The archive comes right after the core model (M2), before the terminal renderer, because every day without it is history lost to Claude Code's transcript cleanup.

Each milestone is done when all of its acceptance criteria are met and its tests pass.

---

## M0: Verification and fixtures

Goal: turn discovery assumptions into verified facts, and build the fixture set everything else is tested against. Output: `docs/research/M0_FINDINGS.md` (verified format behaviour, the Claude Code versions tested and the date) plus fixtures.

**Status: done (2026-09-28)**, with these UNKNOWN items carried forward:
- the on-disk shape of a user interruption;
- interactive `/resume`, `/clear` and `/compact` behaviour;
- nested subagents.

Plan detection was closed by product decision: plan display is removed.

See the findings document.

### Verifications

Each item gets a short written finding in `M0_FINDINGS.md` and at least one fixture that demonstrates it.

- [x] **Resumed sessions.** Run `claude --continue` and `claude --resume <id>` on a finished session. Determine: whether the same `sessionId` and file are appended to, or a new id/file is created; whether `cost-state` resets or accumulates; how the time gap appears. Define how Claude Receipt identifies "one session" in each case.
- [x] **Subagent and sidechain storage.** Run a session that spawns at least one subagent. Determine: where subagent records live (same file with `isSidechain`, or separate files and in which directory); how they link to the parent (`parentUuid`, tool-use id, agent id); whether parent `cost-state` includes subagent usage. Decide whether subagent tokens are counted in session totals and document it.
- [x] **Live and incomplete transcripts.** Parse a transcript while its session is running. Confirm: a partial final line is ignored without error; `sessions/<pid>.json` identifies the live session; `cost-state` is absent until end. Also check a session killed abruptly (no `cost-state`) and a 0-byte transcript (observed on this machine).
- [x] **Windows path handling.** Confirm `cwd` is the reliable project identity. Document how case differences (`OneDrive` vs `onedrive`), trailing separators, drive-letter case and OneDrive paths are normalized for grouping by project. Confirm the parser never decodes directory names.
- [x] **Token deduplication.** On fixtures with multi-block responses (thinking + tool_use + text), confirm deduplication by `message.id` yields per-call usage counted once. Check whether `usage` can differ across lines of the same message (e.g. streaming updates) and, if so, which line wins (expected: the last one).
- [x] **cost-state reconciliation.** For every completed session available: compare deduplicated transcript token sums per model with `cost-state.modelUsage`, and patch-derived lines with `totalLinesAdded/Removed`. Document the expected differences (background models, subagents, thinking tokens) and the tolerance that triggers a warning.
- [x] **Prompt counting rules.** Determine which `user` records are real prompts versus slash commands, hook injections, `isMeta` or interruption markers.
- [x] **Plan source.** Determine whether any non-credential local field reliably states the plan (Pro/Max/API/Team). If one doesn't exist, record that and keep `plan` omitted. Do not read credential files or token fields to answer this.

### Anonymized fixture strategy

- [x] **Anonymizer script** (`scripts/anonymize-fixture.mjs`), using an **allowlist**, not a denylist:
  - Keeps record structure, `type`/`subtype`, all numbers and booleans, timestamps, tool names, model names, `version`, `stop_reason`, and `structuredPatch` line prefixes (`+`, `-`, space).
  - Replaces every other string with a same-length placeholder (so length-based metrics still work). Prompt, response and thinking text become `x…`; patch line bodies become `x…` after the prefix.
  - Maps paths to stable fake paths with the **extension preserved** (`C:\Users\me\proj\src\a1.ts`), and maps `cwd` consistently within a fixture.
  - Maps UUIDs, message ids and request ids to stable fake ids (preserving the duplicate relationships that deduplication depends on).
  - Maps Bash commands to a safe equivalent that preserves the program and category (`pytest tests/…` → `pytest x`).
  - Drops credential and organization attachments entirely.
  - Fails closed: an unknown string-bearing field is replaced, never passed through.
- [x] **The anonymizer has its own test**: a synthetic transcript containing canary secrets (`sk-ant-…`, an email, a home path) produces output containing none of them.
- [x] **Minimal fixtures** for edge cases: partial last line, duplicate message ids, unknown record type, empty file, session with zero tool calls, an Edit with `replaceAll`, a Write `create` versus `update`, a tool error. Most are real anonymized sessions rather than hand-written, which is stronger evidence.
  - Also added: resumed, forked, subagent, killed, missing final newline, prompt kinds.
  - Not done: **an interruption**, because its on-disk shape wasn't observed (UNKNOWN). `prompt-kinds.jsonl` contains an *assumed* interruption record that must be replaced by a real sample.
- [x] **Layout:** `fixtures/claude-code/<version>/<scenario>.jsonl` (subagent fixture mirrors Claude Code's `<sid>/subagents/` layout). Expectations live in `test/m0-rules.test.mjs`.
  - Moved to M1: `<scenario>.expected.json` (the expected Session summary). It depends on the M1 Session model.
  - Human review of committed fixtures is still required before the first commit.

**Done when:** every verification has a finding, and the fixtures cover every listed scenario.

---

## M1: Parser, Session, analytics, `--json`

- [ ] Project setup: TypeScript, minimum Node version pinned, `node:test`, lint/format. Commands added to `CLAUDE.md`.
- [ ] `source/claude-code` produces a `Session` (`ARCHITECTURE.md` §3) from a transcript path via streaming, with no text content retained.
- [ ] All M0 fixtures parse to their `.expected.json` (written in M1 from the M0 test expectations). Unknown records produce warnings, not failures.
- [ ] M0 rules ported from `scripts/m0/rules.mjs` with the same tests:
  - tolerant JSONL reading;
  - last-line-wins deduplication by `message.id`;
  - `promptKind`;
  - `reconcile` (info/warning).
- [ ] Sessions include their `subagents/*.jsonl` files.
- [ ] Forks are detected by uuid / `message.id` overlap. Inherited API calls are excluded, and the fork's `cost-state` is not used for its totals.
- [ ] Token and cost source selection follows `METRICS.md`: `cost-state` for completed non-fork sessions, otherwise the transcript (derived).
- [ ] `isLive` requires a running PID, not just a `sessions/*.json` entry (stale entries exist).
- [ ] Session discovery never decodes directory names, and groups by `cwd` case-insensitively on Windows.
- [ ] `analytics` computes every metric marked **MVP** in `METRICS.md` (except git metrics) with correct provenance. Unavailable inputs produce `null` + `unavailableReason`, and a test asserts no MVP metric is ever `0` because an input was missing.
- [ ] Reconciliation findings follow the M0 rule: transcript below `cost-state` = info, above or model only in transcript = warning. Exact equality is expected for headless sessions.
- [ ] Pricing table file with a date, used only when `cost-state` is absent. Tested against `cost-state.costUSD` on fixtures.
- [ ] `claude-receipt --json`, `last`, `<sessionId>` (prefix), `list`. JSON output snapshot-tested per fixture. `schemaVersion: 1`.
- [ ] A grep-style test asserts that JSON output for a fixture contains none of the fixture's placeholder text strings.
- [ ] Performance: a 50 MB transcript is parsed in under 3 s on a typical laptop, with memory bounded (streaming).

## M2: Local archive

- [ ] `archive/` writes `ArchiveEntry` (`ARCHITECTURE.md` §6) atomically to `~/.claude-receipt/archive/<sessionId>.json` (`CLAUDE_RECEIPT_HOME` respected).
- [ ] Every CLI run sweeps transcripts and archives new or changed, non-live sessions. An unchanged fingerprint means no rewrite.
- [ ] Entries whose transcripts were deleted are kept. A test deletes the fixture source and confirms the entry survives and is still readable.
- [ ] A test confirms that archive files contain no prompt, response, title, patch or command text (checked against fixture placeholders).
- [ ] `archiveSchemaVersion: 1`, with a migration harness in place (a no-op v1 migration test proving the mechanism).
- [ ] A corrupt entry is skipped with a warning and never deleted.

## M3: Terminal receipt

- [ ] `render/tty` renders the Receipt as a narrow receipt (~40 columns): header, Hard stats, Coding stats, Session lore, footer microcopy, and a `~` legend when heuristics are present.
- [ ] Null metrics are omitted, never shown as `0`. Heuristic values always carry `~`.
- [ ] Cost is labelled `API EQUIVALENT`. The words "spent", "paid", "charged" and "bill" appear nowhere (test).
- [ ] Works with `NO_COLOR`, in non-TTY output (pipe), in Windows Terminal and PowerShell, and with wide characters in project names (alignment test with `string-width`).
- [ ] `--redact` applies export redaction rules (`PRIVACY.md` §6).
- [ ] Snapshot tests per fixture.

## M4: Git enrichment → **v0.1 release**

- [ ] `git/` returns `GitFacts` for the session window. Handles no git, non-repositories, empty repositories (no commits) and detached HEAD without errors.
- [ ] `commits.inWindow`, `commits.coAuthored`, `commits.byClaude` confirmation, `git.lines`.
- [ ] Commit messages and authors are never kept (test).
- [ ] Release checklist: README updated with real commands and a real (redacted) sample; npm name confirmed; `npx claude-receipt` works on Windows, macOS and Linux; the privacy doc matches behaviour.

---

## Post-MVP

### Later (data already preserved, options not built)
- `claude-receipt last --run`: receipt for only the most recent run of a resumed session (uses `Session.runs`).
- Entrypoint filtering, e.g. excluding headless `sdk-cli` sessions (uses `Session.entrypoint`). Headless sessions are included by default.

### M5: Periods (`--project`, `--week`, `--month`)
- [ ] Aggregates computed only from archive entries. `agg.coverage` shows data gaps honestly.
- [ ] Local-timezone bucketing with a test across a DST change.

### M6: Visual receipt (SVG/PNG)
- [ ] Design system for the receipt (typography, separators, torn edges, paper texture, microcopy) agreed before code.
- [ ] `render/svg` from the same Receipt model. PNG via resvg. Fonts bundled with licences checked.
- [ ] Export redaction on by default. Golden-image tests.

### M7: Lore expansion and opt-in text features
- [ ] `lore.patterns`, `lore.nightOwl`, metadata-only `lore.personality`, each rule documented in `METRICS.md`.
- [ ] Opt-in `lore.recurringPhrases` (explicit flag or config), never archived, never exported without a per-export flag.

### M8: Claude Wrapped
- [ ] `claude-receipt wrapped [year]` from the archive: yearly story, records, top projects/languages, personality over time. Visual and terminal versions. Honest about coverage (the date data collection began).
