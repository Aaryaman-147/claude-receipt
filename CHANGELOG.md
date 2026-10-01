# Changelog

## 0.2.1 (unreleased)

Presentation and CLI release. The Receipt and HistoryReceipt JSON contracts, the metric computation and the archive format are unchanged: receipts still record generator version 0.2.0, and `--json` output is byte-identical to 0.2.0.

**The image receipt tells a short story**

- Layout, top to bottom: an opening line; up to three big numbers (a session's duration, tokens out and API EQUIVALENT; a history's sessions, projects and time in sessions); up to five story beats where the data supports them (YOUR BIGGEST DAY, YOU SHIPPED, DOWN THE RABBIT HOLE, THE LONG ONE, YOUR TOOLBOX with the top 3 tools, NICE RUN, WHERE YOU WORKED, THE LONGEST TURN); the supporting HARD STATS, CODING STATS and SESSION LORE rows; at most one time-of-day observation (NIGHT OWL, EARLY BIRD or AFTER HOURS), always marked `~` as a heuristic; and a closing line.
- Selection is deterministic: fixed thresholds and priorities, and fixed wording from one table (`docs/METRICS.md` → Receipt story). There is no AI-generated text and no randomness. The opening and closing lines don't change under redaction.
- A fact appears once: a beat that would repeat a big number is dropped (a session's THE LONG ONE repeated its duration), header rows already shown as big numbers are dropped, and supporting rows skip what the story showed.
- Big numbers are sized so they never collide: each column is as wide as its widest value or label, and the row uses the largest size at which all of them fit. A derived value keeps its `*` raised beside it.
- Still 576 px paper on a 624 px canvas (PNG 1248 px wide), IBM Plex Mono, torn edges, leaders and double rules. Receipts are taller than in 0.2.0.

**Fewer repeated or low-value rows**

- No longer printed (terminal and image): turns, shell commands, top programs, detected test runs, tool errors, interrupted tool runs, detected Claude commits, runs, Claude Code open time, reads per edit, longest error streak, commits in window, co-authored commits and git lines. They remain in the Receipt, `--json` and the archive.
- The `N metrics unavailable, not shown` count covers printed metrics only.

**Targeting**

- `claude-receipt <session-prefix> export [last]` exports that session, the same as `export <session-prefix>`; `last` there never selects another session.
- `claude-receipt project <name-or-path> [all | week | month] [--json] [--redact]` and `project <name-or-path> [all | week | month] export [--png | --svg] [-o <file>] [--no-redact]`: the history of one project, by folder name or path, the same as `--project` inside that directory. Windows paths and names match case-insensitively, POSIX ones exactly. An ambiguous or unknown project exits 1 without printing a path. `all | week | month --project` is unchanged.

**Privacy**

- A redacted one-project history now says `ONE PROJECT (HIDDEN)` (previously `THIS DIRECTORY`).
- Project exports are redacted by default and named `claude-receipt-<period>-project.png` (or `.svg`), never with a project name or path. Existing files are never overwritten.
- No network access, telemetry or new stored data.

**Versions**

- The package version (0.2.1, `claude-receipt --version`) and the receipt generator version (still 0.2.0) are now separate: the generator changes only when the metric computation does (`docs/RELEASE.md`).

## 0.2.0

- History receipts across sessions: `all`, `week`, `month`, `--project`, in the terminal, as JSON (the HistoryReceipt contract) and as images (`export all | week | month`).

## 0.1.0

- Session receipts from Claude Code's local session files: terminal, JSON, and PNG/SVG export (redacted by default), with a local metrics-only archive.
