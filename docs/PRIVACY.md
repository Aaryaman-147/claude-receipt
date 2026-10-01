# Privacy Model

Privacy is a defining product property, not a setting. Claude Receipt reads some of the most sensitive files on a developer's machine: full conversations, source code excerpts and command output. It should read as little as it needs, keep less, and share only what the user chooses.

## 1. Principles

1. **Local-only.** No network calls, no telemetry, no accounts, no uploads. Pricing data ships with the package. (If a future feature ever needs the network, it will be opt-in, documented here first, and never involve conversation or code data.)
2. **Read-only toward Claude Code.** Nothing under `~/.claude/` is ever created, modified or deleted, including Claude Code's settings (e.g. `cleanupPeriodDays`), hooks and transcripts.
3. **Metadata by default.** Default metrics use timestamps, counts, token numbers, tool names and file paths, not the meaning of what was said.
4. **Text is opt-in.** Features that interpret prompt or response text are off by default, run in memory, and are never archived.
5. **Minimize storage.** The archive stores computed metrics only.
6. **Redact on export.** Anything that leaves the terminal as a file is redacted by default.

## 2. What Claude Receipt reads

| Path | Why | Handling |
|---|---|---|
| `~/.claude/projects/*/*.jsonl` and `*/<sessionId>/subagents/*.jsonl` | Session and subagent transcripts, the primary source | Streamed. Only whitelisted fields are extracted (see §3). |
| `~/.claude/projects/*/<sessionId>/subagents/*.meta.json` | Subagent type, model and parent call | Only `agentType`, `model`, `toolUseId` are used. `description` (free text) is parsed with the file but never used or kept. |
| `~/.claude/sessions/*.json` | Detecting live sessions | Only `pid` and `sessionId` are used, plus a check that the PID is running (entries go stale after crashes). Never the `*.key` files beside them. |
| `~/.claude/history.jsonl` | Future: long-range activity timestamps | Only `timestamp`, `project`, `sessionId`. Never `display` or `pastedContents`. |
| `git` in a session's `cwd` | Commits in the session window | Only `git rev-parse` and `git log` (no index or working-tree writes: `GIT_OPTIONAL_LOCKS=0`, fsmonitor off). Kept: SHAs, committer timestamps, numstat counts, a Co-Authored-By boolean. `Co-Authored-By` trailer values are checked in memory and dropped; commit messages, authors and file names are never read into the result. |

## 3. What is read transiently versus kept

Some content has to pass through memory to compute a number. It's used and immediately discarded, and is never kept in the Session, Receipt, archive or logs.

| Content | Used for | Kept? |
|---|---|---|
| Prompt text | Character length only (lore) | No, only the length is kept |
| Bash/PowerShell command string | Program name and category (`test`, `git`, …) | No, only `program` + `category` are kept |
| Edit/Write patches and file contents | Counting `+` and `-` lines | No, only the counts are kept |
| Tool output (stdout/stderr) | Nothing by default. Future: test outcome parsing | No |
| Claude response text | Nothing by default. Opt-in: recurring phrases | No (never archived; see §5) |
| `ai-title` | Receipt header in the terminal | Displayed locally. **Not archived.** Redacted in exports. |
| `custom-title`, `agent-name` records (Claude Desktop) | Nothing | No: read no further than their `type`, counted as unknown-record warnings |

`~/.claude` can be relocated with `CLAUDE_CONFIG_DIR`; Claude Receipt reads the same files there.

### What the normalized Session retains (M1a)

The Session (`src/source/claude-code/types.ts`) is the only output of the parser. It keeps exactly:

- **Identifiers:** session id; Claude's opaque API `message.id` per API call (`apiCalls[].key`); tool-use ids; subagent `agentId` and the parent tool-use id. These are random server/client ids with no content. The archive (M2) will store API call ids **hashed** (§5); the Session itself keeps them raw because deduplication needs them.
- **Paths and names (meta, redacted in exports):** project `cwd` (plus any other `cwd`s), project name, **file paths** of Read/Write/Edit/NotebookEdit calls, **git branch names**, tool names (including MCP server/tool names), **slash-command names** (e.g. `/model`, never arguments), **skill names**, **agent-type names**, subagent model names, model names, Claude Code versions, `entrypoint`, source file paths.
- **Numbers and enums:** timestamps, token counts, cost-state totals, durations, line counts, prompt character lengths, run boundaries, statuses, stop reasons, service tier, command `program` (allowlisted names only, otherwise `other`) and `category`, git command kind.
- **Title:** Claude Code's `ai-title`, display only.
- **Diagnostics:** warning codes such as `unknown-record-type:<type>` (type names only).

It never keeps prompt text, response or thinking text, raw commands, command arguments, stdout/stderr, file contents, patches, `meta.json` descriptions, custom titles or agent names. Record uuids are used internally for fork detection and dropped. `test/source/claude-code.test.ts` asserts this for every fixture.

### What the Receipt contains (M1b)

The Receipt (`src/receipt/types.ts`) is computed from the Session (and optional git facts), so it can only hold what those hold. It contains:

- **Session header:** session id, project name, project key, `cwd`, entrypoint, title (display only), start/end timestamps, live/complete flags, parent session id for forks, Claude Code versions, time zone used.
- **Metric values:** numbers, model names, tool names (including MCP server names, marked `sensitive`), allowlisted program names, language names, one file path (`files.mostEdited`, marked `sensitive`), git commit counts and line counts.
- **Details:** per-model token and cost breakdowns, counts by kind/tool/program/category, the git window and an hour-of-day histogram. No text.
- **Reasons and warnings:** fixed strings written by Claude Receipt, and warning codes.

It never contains Session-level identifiers beyond the session id (no API call ids, tool-use ids or agent ids), commit SHAs, prompt/response text, commands, patches or tool output. `test/analytics/receipt.test.ts` checks every fixture Receipt for leaked text, raw-content fields and presentation fields; the M1b real-data check (16 local sessions) found none of 1,728 private strings from their transcripts in any Receipt.

## 4. What is never read

- `~/.claude/.credentials.json`, any `*.key` file (`sessions/*.key`, `daemon/pipe.key`) or token files.
- `credential_org` and other credential- or organization-related attachment records in transcripts. Parsers skip these record types without reading their payloads.
- Environment variables holding secrets, shell snapshots (`~/.claude/shell-snapshots/`), `paste-cache/`, `file-history` backups.
- `~/.claude.json` (account profile, email, name, org). M0 research read its key names and four enum values once to answer the plan question (`docs/research/M0_FINDINGS.md` §8). No reliable plan source was established, and plan display was removed from the product (2026-10-01). **Claude Receipt does not read this file.**
- Transcript fields that carry prompt or title text Claude Receipt doesn't need: `queue-operation.content`, `last-prompt.lastPrompt`, attachment payloads and their `rendered` copies.

## 5. The archive

Location: `~/.claude-receipt/archive/` (overridable via `CLAUDE_RECEIPT_HOME`).

**Stored**: the computed Receipt for each session, which contains:
- session id, project name, `cwd`, start/end timestamps, Claude Code versions;
- numbers (durations, token counts, cost estimate, counts, line counts);
- model names, tool names, program names and command categories, language names;
- the most-edited file path;
- git commit counts, Claude co-authorship counts and line counts for the session window (when available; no SHAs, messages or authors);
- a fork's parent session id (`forkOf`), so aggregates don't double count forked sessions;
- provenance and warnings.

Around the Receipt, each entry (`ArchiveEntry`, `ARCHITECTURE.md` §6) holds only: the schema version, the entry key (a hash of the session id), first/last write times, a hash of the content, and the transcript's total size in bytes and latest modification time (no paths).

**Never stored**: prompt text, Claude response text, AI titles, thinking content, file contents, patches, raw or partial commands, command output, commit messages, author identities, credentials, transcript records, and any API-call, message, request, tool-use or agent id (hashed or not; session ids are the only identifiers). Presentation copy never enters: the Receipt holds semantic values only, and entries with unknown fields are rejected on read.

This is enforced, not just intended: `writeReceipt` archives only validated Receipts and strips the title; `validateEntry` rejects any extra field on read; `test/archive/archive.test.ts` scans archived fixtures for leaked text and ids. The M2 real-data check archived 14 local sessions (into a temporary directory) and found none of 2,176 private transcript strings and none of 3,291 raw telemetry ids in the archive.

The archive is plain JSON so users can inspect it, and deleting the directory removes everything. Claude Receipt never deletes or rewrites entries on its own: malformed, unsupported or conflicting entries are reported and left untouched. A future `claude-receipt archive --purge` may make deletion explicit; no automatic retention or pruning exists.

Opt-in text features (recurring phrases, text-based personality) are computed from the transcript while it still exists and are **not archived**. So they're unavailable for sessions whose transcript has been cleaned up. This trade-off is deliberate.

## 6. Export redaction (future visual receipt and shareable JSON)

Default redaction for anything written to a file or meant for sharing:

| Field | Default in exports |
|---|---|
| Project name | Hidden |
| `cwd`, file paths | Removed; most-edited file shown as extension only (e.g. `*.ts`) |
| Session title | Removed |
| Session id | Truncated (first 4 chars) |
| MCP server names | Grouped (`MCP`) |
| Numbers, models, languages, lore values | Shown |
| Recurring phrases (future, M7) | Never, unless an explicit per-export flag is given |

There is **one opt-out, `--no-redact`**, which exports the unredacted Receipt. The per-field reveal flags once planned here (`--show-project`, `--show-files`, `--show-title`, `--show-tools`) are not part of the product. For the visual receipt (M6, `docs/VISUAL_RECEIPT.md`), `claude-receipt export` applies `redactReceipt()` before rendering, the renderer never knows which fields were redacted, and generated SVG/PNG files contain nothing beyond what is drawn (no hidden metadata). PNGs hold only the `IHDR`, `IDAT` and `IEND` chunks. The default file name is `claude-receipt-<id>.png` with the 4-character redacted id (8 characters with `--no-redact`), never a project, path or title. Export never overwrites an existing file. Exported images are sensitive files like any Receipt; Claude Receipt never uploads them.

The terminal receipt (on your own screen) shows project and file names by default, because it isn't shared unless you choose to share it. `--redact` applies export rules to the terminal too, for screenshots.

As built (M3, `src/receipt/redact.ts`): `--redact` hides the project, project key, `cwd` and title, shortens session and fork-parent ids to 4 characters, shows the most-edited file as its extension only, and groups MCP tools as `MCP`. It is applied to the terminal receipt, `--json`, and `list` (text and JSON). `list` shows only start time, short session id, project name, duration and state. Nothing the CLI prints contains prompt or response text, commands, tool output, or API/message/tool/agent ids; the M3 real-data check found none of 2,281 private strings and none of 3,631 telemetry ids in any output or in the archive.

`--json` is machine output for the user's own scripts. It includes the fields in §5 plus the session title, and nothing else from the "never stored" list. A `--json --redact` combination applies the export rules.

## 7. For contributors

- Debug with schemas and counts, never by printing transcript contents.
- Never commit a real transcript. Fixtures must go through the anonymizer (`ROADMAP.md` M0) and be reviewed.
- Any new field kept in Session, Receipt or archive needs a line in §3 or §5 in the same change.
