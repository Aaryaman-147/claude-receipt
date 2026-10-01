# Claude Receipt

> Every Claude Code session, itemized.

Claude Receipt is a local-first tool that turns a Claude Code session into a receipt: the hard numbers (time, models, tokens, API-equivalent cost), the coding work (files, lines, commands, tests, commits) and a bit of session lore (the biggest rabbit hole, the peak hour, what kind of session it was).

The long-term goal is "Spotify Wrapped for Claude Code": session receipts, weekly and monthly summaries, and a yearly Claude Wrapped. All of it is computed on your machine from the data Claude Code already writes locally.

```
/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\

      C L A U D E   R E C E I P T
        itemized session record
========================================
SESSION ..................... ordinary
PROJECT ...................... project
STATUS ...................... COMPLETE

-- HARD STATS --------------------------
DURATION ......................... 21s *
ACTIVE TIME (EST.) .............. ~21s
TOKENS OUT ....................... 908
API EQUIVALENT ................. $0.05

-- CODING STATS ------------------------
LINES ADDED ....................... +3 *
TEST RUNS DETECTED ................ ~0

-- SESSION LORE ------------------------
BIGGEST RABBIT HOLE ... 4 calls in 17s *
CACHE HIT RATE ................... 90% *
========================================
plain    recorded directly
  *      computed from data
  ~      heuristic estimate
```

*Excerpt of a receipt rendered from an anonymized test fixture (full version: `test/render/snapshots/ordinary.txt`).*

## Status

**Experimental, pre-release.** It parses Claude Code's local session files, computes a Receipt, keeps a local metrics-only archive, prints a terminal receipt, and exports the receipt as a PNG or SVG image. It is not published to npm yet (packaging is M4), so run it from a checkout. Weekly/monthly summaries and Wrapped come later ([roadmap](docs/ROADMAP.md)).

## Usage

Requires Node 24 or newer. From a checkout, run `npm install` once (it installs the one runtime dependency, `@resvg/resvg-wasm`, used for PNG export), then:

```
node src/cli/main.ts                   # current or most recent session in this directory
node src/cli/main.ts last              # most recent completed session anywhere
node src/cli/main.ts list              # recent sessions (--limit N)
node src/cli/main.ts <session-prefix>  # a specific session
node src/cli/main.ts last --json       # the Receipt as JSON
node src/cli/main.ts last --redact     # hide project, paths and title for sharing
```

`npm link` in the checkout installs a `claude-receipt` command with the same arguments.

Every run also archives finished sessions to `~/.claude-receipt/archive/` (metrics only, no conversation text), so they survive Claude Code's transcript cleanup. `--no-archive` makes a run read-only. `CLAUDE_CONFIG_DIR` and `CLAUDE_RECEIPT_HOME` relocate the Claude Code data and the archive.

### Shareable image

```
node src/cli/main.ts export                    # PNG of the current/most recent session, redacted
node src/cli/main.ts export last --svg         # the canonical SVG instead
node src/cli/main.ts export <session-prefix> -o my-receipt.png
node src/cli/main.ts export --no-redact        # keep project, title and file names
```

- The default is a **PNG at 2× (1248 px wide)**, rendered from the same SVG that `--svg` writes. Session choice is the same as for the terminal receipt (`last`, a prefix, or the current directory's latest session; a live session is exported as a snapshot marked LIVE).
- **Redacted by default:** no project name, paths, session title or file names (the most-edited file shows only its extension), and the session id is cut to 4 characters. `--no-redact` is the only opt-out. No image ever contains prompts, responses, commands or other conversation text.
- The file goes to `./claude-receipt-<id>.png` (`-2`, `-3`, … if that exists) or to `--output <file>`. **Existing files are never overwritten**: an existing `--output` path makes the export fail. The path is printed on stdout.
- **Text coverage:** images use the bundled IBM Plex Mono (OFL-1.1): Latin (including accented Western and Central European letters), Cyrillic and common punctuation. Other scripts (Chinese, Japanese, Korean, Greek, Arabic, Hebrew, Devanagari) and emoji show as empty boxes in the PNG; the layout stays intact. In the SVG, a viewer may substitute its own font for those characters.

On the receipt, plain values were recorded by Claude Code, values ending in `*` were computed from recorded data, and values starting with `~` are estimates.

## Principles

- **Local-first.** Nothing is uploaded anywhere. No account and no network access are needed to produce a receipt.
- **Honest numbers.** Every metric is tagged `exact`, `derived` or `heuristic`, and estimates are never presented as facts. API-equivalent cost is never called "money spent".
- **Private by default.** Default analytics use metadata (timestamps, token counts, tool names, file paths), not what you or Claude wrote. Features that need conversation text are opt-in.
- **A story, not a dashboard.** Useful engineering stats plus playful session lore, printed like a real thermal receipt.

## Documentation

| Doc | Contents |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product, user experience, MVP and future direction |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, data flow, Session, Receipt and archive models |
| [docs/METRICS.md](docs/METRICS.md) | The metric registry: every metric, its source and provenance |
| [docs/PRIVACY.md](docs/PRIVACY.md) | What is read, what is never stored, export redaction |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones and acceptance criteria |

## Disclaimer

Claude Receipt is an independent project and is not affiliated with Anthropic. It reads Claude Code's local session files, whose format is undocumented and may change.
