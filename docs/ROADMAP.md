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
- [x] **Layout:** `fixtures/claude-code/<version>/<scenario>.jsonl` (subagent fixture mirrors Claude Code's `<sid>/subagents/` layout). Expectations were first pinned by M0 tests, now ported to `test/source/` (M1a).
  - `<scenario>.expected.json` snapshots were replaced in M1a by per-behaviour assertions and invariant tests.
  - Human review of committed fixtures is still required before the first commit.

**Done when:** every verification has a finding, and the fixtures cover every listed scenario.

---

## M1a: Source adapter, normalized Session

**Status: done (2026-10-01).** Notes, limitations and measurements: `docs/research/M1_FINDINGS.md`. The UNKNOWN and LIMITATION items listed there are accepted as documented limitations and are not to be resolved speculatively; revisit only if a product requirement makes one of them important.

- [x] Project setup: TypeScript (type-check only, Node runs `.ts` directly), Node ≥ 24 pinned in `package.json`, `node:test`. Commands added to `CLAUDE.md`. No linter or formatter is configured; `tsc --strict` is the static check.
- [x] `source/claude-code` produces a `Session` (`src/source/claude-code/types.ts`, `ARCHITECTURE.md` §3) via streaming, with no text content retained.
- [x] M0 rules ported into production code with tests (`test/source/`); the M0 reference module and its tests were removed:
  - tolerant JSONL reading, bounded to the file size at open;
  - last-line-wins deduplication by `message.id`, within and across files;
  - `promptKind`;
  - `reconcile` (info/warning), including line counts.
- [x] Sessions include their `subagents/*.jsonl` files and `meta.json` (agentType, model, parent tool call).
- [x] Forks are detected by uuid overlap among the sessions parsed together. Inherited records and API calls are excluded from the fork's own activity.
- [x] Run boundaries preserved (`Session.runs`, `run` index on every item), including the interactive double-cost-state rule.
- [x] `entrypoint` preserved; headless sessions included.
- [x] Live requires a running PID, not just a `sessions/*.json` entry.
- [x] Discovery never decodes directory names; `project.key` groups `cwd`s case-insensitively on Windows.
- [x] Unknown record types produce warnings, not failures.
- [x] Expected results are pinned by per-behaviour assertions and invariant tests (repeat-idempotence, truncation at every byte, no text in any Session) instead of `.expected.json` snapshots.
- [x] A test asserts that Session JSON for every fixture contains none of the fixture's placeholder text.
- [x] Performance: a 50 MB transcript parses in well under 3 s with bounded memory (measured 0.37 s, see M1 findings).
- [x] Development entry point `src/dev/parse.ts` (Session JSON, or counts only with `--summary`). Not the product CLI.

## M1b: Analytics, Receipt JSON, git enrichment

**Status: done (2026-10-01).** Git enrichment moved here from M4; the product CLI commands moved to M3 (M1b ships a development entry point only).

- [x] Token and cost source selection follows `METRICS.md`: `cost-state` for completed, non-live, non-fork sessions (exact), otherwise the transcript (derived).
- [x] `analytics` (`src/analytics/`) computes every metric marked **MVP** in `METRICS.md` with provenance. Unavailable inputs produce `null` + `unavailableReason`; tests assert the null-instead-of-0 cases (killed session, headless turns, git not run, no edits, no tool calls).
- [x] Pricing table with a date (`src/analytics/pricing.ts`), used only when `cost-state` is unusable. Tested against `cost-state.costUSD` on every completed fixture (exact match).
- [x] Receipt model (`src/receipt/types.ts`, `ARCHITECTURE.md` §4), schema validator (`src/receipt/validate.ts`) and `render/json` with `schemaVersion: 1`.
- [x] `git/` returns `GitFacts` for the session window, read-only. Handles no git, non-repositories, missing directories, empty repositories (a true zero) and detached HEAD without errors. `commits.inWindow`, `commits.coAuthored`, `commits.byClaude` confirmation, `git.lines`. Commit messages and authors are never kept (test).
- [x] A test asserts that Receipt JSON for every fixture contains none of the fixture's placeholder text, no raw-content fields and no presentation fields.
- [x] Development entry point `src/dev/receipt.ts` (Receipt JSON, or provenance/null summary with `--summary`).

## M2: Local archive

**Status: done (2026-10-01).** Design: `ARCHITECTURE.md` §6; privacy boundary: `PRIVACY.md` §5.

- [x] `archive/` (`src/archive/index.ts`) writes `ArchiveEntry` atomically (temp file + rename) to `~/.claude-receipt/archive/<key>.json` (`CLAUDE_RECEIPT_HOME` respected). The key is a hash of the session id, not the raw id.
- [x] Idempotent: re-archiving identical content (ignoring `generatedAt`) is `unchanged` and not rewritten. A resumed session whose transcript grew replaces its entry; any other difference is a `conflict` that leaves history untouched.
- [x] Entries whose transcripts were deleted are kept. A test deletes the fixture source and confirms the entry survives and is still readable.
- [x] Tests confirm that archive files contain no prompt, response, title, patch or command text, and no API-call/message/tool-use/agent ids (checked against fixture placeholders and fake ids). Real-data check: 0 leaks.
- [x] `archiveSchemaVersion: 1`, with a minimal migration boundary (`migrateEntry`, tested with an injected v1 → v2 step). Newer versions are `unsupported`, never guessed.
- [x] A corrupt, unsupported or invalid entry is reported by `readArchived` / `listArchive`, never deleted, and never overwritten.
- Changed from the original plan: hashed API-call keys are **not** archived (the archive holds no call/message ids at all). Consequence: a fork first archived after its parent's transcript was cleaned up can't be recognised as a fork (accepted M1a limitation).
- Moved to M3: the sweep "every CLI run archives new or changed, non-live sessions" (the CLI owns it; `src/dev/archive.ts` does it for development), and skipping unchanged transcripts by fingerprint.

## M3: Terminal receipt and CLI

**Status: implemented (2026-10-01), awaiting review.** Commands and semantics: `PRD.md` §5.4; sweep: `ARCHITECTURE.md` §6.

- [x] Every CLI run sweeps local transcripts and archives new or changed, non-live sessions (`writeReceipt`, `src/cli/sweep.ts`). Project directories whose sessions all match their archived fingerprint (and none is live) are skipped without parsing. Moved here from M2.
- [x] Product CLI (`src/cli/run.ts`, entry `src/cli/main.ts`, bin `bin/claude-receipt.js`): `claude-receipt` (current/most recent session for the directory), `last`, `<sessionId>` (prefix), `list` (`--limit`), `--json` (the M1b Receipt JSON), `--redact`, `--no-archive`. Moved here from M1b.
- [x] `render/tty` renders the Receipt as a narrow receipt (40 columns, down to 28): header, Hard stats, Coding stats, Session lore, footer microcopy, and a legend of the marks in use.
- [x] Null metrics are omitted, never shown as `0`, and their count is stated. Heuristic values carry `~`; derived values carry ` *`; exact values carry neither. A test asserts every rendered metric's mark matches its provenance (all fixtures, plus a receipt with every metric filled, at several widths), and a legend explains the marks in use.
- [x] Cost is labelled `API EQUIVALENT`. The words "spent", "paid", "charged" and "bill" appear nowhere (test).
- [x] Works with `NO_COLOR` and in non-TTY output (plain ASCII; ANSI only on a TTY), and with wide characters in project names (alignment test). Instead of the `string-width` dependency, a small built-in display-width function (wide East Asian and emoji = 2, combining marks = 0). Windows Terminal/PowerShell: ASCII-only output; verified in this environment's terminal, not in a separate console test.
- [x] `--redact` applies export redaction rules (`PRIVACY.md` §6).
- [x] Snapshot tests for three fixtures (`test/render/snapshots/`).
- ~~Not done: `npx claude-receipt` from npm needs the M4 build step~~ Resolved in M4: the package runs compiled `dist/` (`docs/RELEASE.md`).

## M4: v0.1 release

Git enrichment was delivered in M1b.

- [x] Packaging (`docs/RELEASE.md`): `tsc` build to `dist/`, package `claude-receipt@0.1.0` with a `files` allowlist (compiled JS, fonts, licences), tested with `npm pack` and a clean install from the tarball (local, global prefix and `npx`) on Windows. README with real commands and a redacted sample image. npm name `claude-receipt` was unclaimed when checked.
- [ ] Release checklist still open: the clean-install check on macOS and Linux; a repository URL in `package.json`; publishing to npm.
- [x] Project licence: an MIT `LICENSE` file (and `license` in `package.json`), added before packaging. Third-party licences stay with their components and ship with them: IBM Plex Mono (OFL-1.1, with the font files), `@resvg/resvg-wasm` (MPL-2.0).

---

## Post-MVP

### Later (data already preserved, options not built)
- `claude-receipt last --run`: receipt for only the most recent run of a resumed session (uses `Session.runs`).
- Entrypoint filtering, e.g. excluding headless `sdk-cli` sessions (uses `Session.entrypoint`). Headless sessions are included by default.

### M5: Periods (v0.2: `all`, `week`, `month`, `--project`)
- [x] `src/aggregate/`: pure `Receipt[]` + scope → `HistoryReceipt`, computed from the sweep's candidate pool (archived and freshly built Receipts, one per session id). Coverage shows data gaps honestly; partial metrics say how many sessions they cover.
- [x] Local calendar-day periods in the viewer's zone, tested across DST changes and a zone that skips midnight.
- [x] Shared rendering view model (`src/render/view.ts`) for session and history receipts; v0.1 output byte-identical.
- [x] `claude-receipt all | week | month [--project] [--json] [--redact] [--no-archive]` (terminal and JSON).
- [x] SVG/PNG export of a history (`export all | week | month [--project]`), redacted by default; session images byte-identical.
- [x] Synthetic 1,000 / 5,000-session archive benchmarks (`scripts/bench-archive.ts`): no archive index is required for v0.2 (`ARCHITECTURE.md` §6).

### M6: Visual receipt (SVG/PNG)

Specification: `docs/VISUAL_RECEIPT.md`. M6 is being built ahead of M4 and M5; the official numbering is unchanged. It is delivered in four implementation stages with descriptive names (they are not milestone numbers; in conversation they were drafted as "M4a–M4d"):

- [x] **Visual Receipt — Spec:** design system agreed before code (`docs/VISUAL_RECEIPT.md`): 576 px paper on a 624 px canvas (flat backdrop `#E8E5DE`, flat paper `#FAF8F2`, no grain in the MVP), torn sawtooth edges, IBM Plex Mono on a 42-column grid, the terminal's provenance marks and copy.
- [x] **Visual Receipt — SVG:** pure layout model and hand-written deterministic SVG from the same Receipt (the canonical visual output; no Satori, no frontend framework). IBM Plex Mono Regular and Bold bundled unmodified with their OFL-1.1 licence. Golden SVG tests.
- [x] **Visual Receipt — PNG:** PNG rendered from the SVG with `@resvg/resvg-wasm` (pinned) at 2× (1248 px wide). `claude-receipt export`, redacted by default via `redactReceipt()`, with one opt-out, `--no-redact`. PNG determinism and privacy tests.
- [x] Exact, derived and heuristic values are visually distinguishable in the image with the same meaning as in the terminal, with a legend (`METRICS.md` → Rendering rule).
- [x] **Visual Receipt — Packaging:** fonts, licence files and the WASM binary ship in the npm package (coordinated with M4); optional polish such as paper grain only if it doesn't harm readability (not done; none planned for v0.1).
- Image glyph coverage is limited to IBM Plex Mono's; no CJK fallback font is bundled.

### v0.2.1: Receipt story and targeting (presentation and CLI; no model change)
- [x] Deterministic receipt story in images (`src/render/narrative.ts`, `METRICS.md` → Receipt story): opening, up to 3 big numbers sized to never collide, up to 5 beats, at most one heuristic time-of-day observation, closing; no fact repeated.
- [x] Low-value and repeated rows no longer printed (still in `--json` and the archive).
- [x] `<session-prefix> export [last]`; `project <name-or-path> [all | week | month] [export]`; redacted one-project label `ONE PROJECT (HIDDEN)`.
- [x] Package version 0.2.1 separate from generator version 0.2.0 (`RELEASE.md` → Versions). JSON output and archive behaviour byte-identical to 0.2.0.
- [ ] macOS and Linux verification (including the POSIX project-path test).

### M7: Lore expansion and opt-in text features
- [ ] `lore.patterns`, `lore.nightOwl`, metadata-only `lore.personality`, each rule documented in `METRICS.md`.
- [ ] Opt-in `lore.recurringPhrases` (explicit flag or config), never archived, never exported without a per-export flag.

### M8: Claude Wrapped
- [ ] `claude-receipt wrapped [year]` from the archive: yearly story, records, top projects/languages, personality over time. Visual and terminal versions. Honest about coverage (the date data collection began).
