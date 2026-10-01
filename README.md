# Claude Receipt

> Every Claude Code session, itemized.

Claude Receipt is a local-first tool that turns Claude Code sessions into receipts: the hard numbers (time, models, tokens, API-equivalent cost), the coding work (files, lines, languages) and a bit of session lore (the biggest rabbit hole, the peak hour). It works for one session or for a history of sessions (all, the last week or month, one project), in the terminal, as JSON, or as a PNG or SVG image. Everything is computed on your machine from the data Claude Code already writes locally.

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
MOST EDITED ................ file1.txt *

-- SESSION LORE ------------------------
BIGGEST RABBIT HOLE ... 4 calls in 17s *
CACHE HIT RATE ................... 90% *
========================================
plain    recorded directly
  *      computed from data
  ~      heuristic estimate
```

*Excerpt of a terminal receipt rendered from an anonymized test fixture (full version: `test/render/snapshots/ordinary.txt`).*

## Status

**v0.2.1, pre-release.** It parses Claude Code's local session files, computes a Receipt per session, keeps a local metrics-only archive, prints terminal receipts for one session or a history of sessions, and exports either as a PNG or SVG image. The package is built and tested but **not yet published to npm**. See [CHANGELOG.md](CHANGELOG.md).

## Install

Requires **Node 24 or newer**.

```
npm install -g claude-receipt     # once published
npx claude-receipt                # or run it without installing
```

Until the first npm release, install from a checkout:

```
git clone <this repository> && cd claude-receipt
npm install                       # also builds dist/ (the compiled CLI)
npm install -g .                  # or: npm pack, then npm install -g ./claude-receipt-0.2.1.tgz
```

The package contains the compiled JavaScript, the two bundled font files and the licences. Its one runtime dependency is `@resvg/resvg-wasm` (WebAssembly, no native code), which turns the receipt SVG into a PNG.

## Usage

### One session

```
claude-receipt                    # the current or most recent session in this directory
claude-receipt last               # the most recent completed session anywhere
claude-receipt list               # recent sessions, newest first (--limit N)
claude-receipt <session-prefix>   # the session whose id starts with <session-prefix>
claude-receipt last --json        # the Receipt as JSON (a versioned contract for scripts)
claude-receipt last --redact      # project, paths and title hidden, id shortened
```

A prefix must match exactly one session: an unknown or ambiguous prefix exits with status 1 (an ambiguous one lists the matching short ids).

### History

```
claude-receipt all                # every finished session Claude Receipt knows about
claude-receipt week               # sessions started in the last 7 local calendar days, today included
claude-receipt month              # the last 30 local calendar days
claude-receipt week --project     # only this directory's project
claude-receipt all --json         # the HistoryReceipt as JSON
```

A history receipt sums and ranks the per-session metrics that add up cleanly (time, tokens, API EQUIVALENT, prompts, tool calls, lines, languages, tools, models) and adds a few records (longest session, biggest rabbit hole, busiest day, longest streak, peak hour). Per-session file counts and git commit counts are not summed, because they would double count. The header shows what it covers: sessions, projects, first and last dates, days with data, and sessions not counted (still running, or undated in a week or month). A session counts in the period it started in, and live sessions are never counted. Metrics that only some sessions have say so (`based on 11 of 14 sessions: …`), and nothing missing is shown as zero. "All" means every session Claude Receipt has seen: sessions Claude Code cleaned up before the first run are not included.

### One project

```
claude-receipt project nucleus            # every session of the project named "nucleus"
claude-receipt project nucleus week       # ... or month; all is the default
claude-receipt project ../nucleus         # a project by path
claude-receipt project nucleus --json     # the HistoryReceipt as JSON
claude-receipt project nucleus --redact   # the project name becomes ONE PROJECT (HIDDEN)
```

`project <name-or-path>` gives the same history as running `all`, `week` or `month` with `--project` inside that project's directory.

- **By path:** an argument containing a path separator or a drive letter, or `.` or `..`, is a path, resolved against the current directory. Windows paths match case-insensitively and ignore a trailing separator; POSIX paths (macOS, Linux) match exactly, case included.
- **By name:** any other argument is matched against the folder names of the projects Claude Receipt knows: case-insensitively for projects recorded under Windows paths, exactly for POSIX ones.
- **Ambiguous or unknown:** if two projects share a name, or nothing matches, the command exits with status 1 and asks for a path (or `--project` inside the directory). These messages never print a path.
- A project is only addressed through the word `project`: `claude-receipt nucleus` looks for a session id starting with `nucleus`.

### Images

```
claude-receipt export                          # PNG of the current/most recent session, redacted
claude-receipt export last --svg               # the canonical SVG instead
claude-receipt export <session-prefix>         # a specific session
claude-receipt <session-prefix> export         # the same
claude-receipt <session-prefix> export last    # the same: "last" here means that session
claude-receipt export week                     # a history image (also all, month; --project)
claude-receipt project nucleus export          # a project history image
claude-receipt project nucleus month export --svg
claude-receipt export --no-redact              # keep project, title and file names
claude-receipt export last -o my-receipt.png   # choose the file name
```

![A redacted receipt image rendered from an anonymized test fixture](docs/receipt-sample.png)

*A redacted export of an anonymized test fixture (`docs/receipt-sample.png`, regenerated by the test suite).*

- **Format:** PNG by default, at 2× (1248 px wide, from a 576 px receipt on a 624 px canvas), rendered from the same SVG that `--svg` writes. Rendering is deterministic: the same input gives byte-identical SVG and PNG files.
- **Redacted by default:** no project name, paths, session title or file names (the most-edited file shows only its extension); the session id is cut to 4 characters, and a one-project history says `ONE PROJECT (HIDDEN)`. `--no-redact` is the only opt-out. No image ever contains prompts, responses, commands or other conversation text, and PNGs carry no metadata.
- **File names never contain a project name or path:** a session is written to `./claude-receipt-<id>.png` (4 characters redacted, 8 with `--no-redact`), a history to `./claude-receipt-<period>.png`, and a one-project history (`--project` or `project <name-or-path>`) to `./claude-receipt-<period>-project.png`. `.svg` with `--svg`. The path is printed on stdout.
- **Existing files are never overwritten:** if the default name exists, `-2`, `-3`, … are tried; an existing `--output` path makes the export fail with status 1 and leaves the file untouched.
- **The image tells the receipt as a short story:** an opening line, up to three big numbers (a session's duration, tokens out and API EQUIVALENT; a history's sessions, projects and time in sessions), up to five story beats where the data supports them (for example YOU SHIPPED, YOUR TOOLBOX with the top 3 tools, YOUR BIGGEST DAY, NICE RUN, WHERE YOU WORKED), then the remaining supporting rows. A fact shown in the story is not repeated below it. The words around the numbers are fixed, chosen by fixed rules from the data (no AI-generated text, no randomness), and never change a value or its mark. The terminal receipt does not include the story.
- **Text coverage:** images use the bundled IBM Plex Mono: Latin (including accented Western and Central European letters), Cyrillic and common punctuation. Other scripts (Chinese, Japanese, Korean, Greek, Arabic, Hebrew, Devanagari) and emoji show as empty boxes in the PNG; the layout stays intact. In the SVG, a viewer may substitute its own font for those characters.

### Reading a receipt

- **Plain values** were recorded by Claude Code. **Values marked `*`** were computed from recorded data. **Values starting with `~`** are heuristic estimates, and their labels say so too (such as `ACTIVE TIME (EST.)`). Every receipt has a legend for the marks it uses.
- **Observations** (images only): when there is enough data (at least 40 recorded prompts and tool calls, and for a history at least 3 sessions recorded in one time zone), the image may add one time-of-day observation, such as `NIGHT OWL ~` with "Most of your recorded activity happened between 8 PM and 5 AM." It is a heuristic about when activity was recorded, marked `~`, and says nothing about you or your work.
- **Unavailable metrics** are left out and counted (`N metrics unavailable, not shown`), never shown as zero.
- **API EQUIVALENT** is what the tokens would cost at Anthropic's API list prices: Claude Code's own recorded cost when it has one, otherwise computed from a price table that ships with the package. It is an equivalent, not a charge or a bill.
- Some metrics are kept in the Receipt and its JSON but not printed (for example turns, shell commands, detected test runs and commits, tool errors). `--json` has them all.

### The archive

Every run first sweeps Claude Code's local sessions and saves each finished one to `~/.claude-receipt/archive/`: the computed metrics plus the session header (session id, project name and directory, times, Claude Code version) and the most-edited file path, but no prompts, responses, code, tool output, commands or session titles. Receipts survive Claude Code's transcript cleanup. Live sessions are not archived. `--no-archive` makes a run read-only.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `CLAUDE_RECEIPT_HOME` | `~/.claude-receipt` | Where the archive lives (`$CLAUDE_RECEIPT_HOME/archive/`) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code's data is read from (the same variable Claude Code uses) |
| `NO_COLOR` | unset | Plain terminal output without bold/dim |

## Privacy

- Everything runs on your machine. Claude Receipt makes **no network requests** and has no account, telemetry or upload of any kind.
- It reads Claude Code's session files under `~/.claude/` (`projects/`, plus `sessions/` to tell which sessions are still running) read-only. It never reads credentials and never modifies Claude Code's files.
- Default metrics come from metadata (timestamps, token counts, tool names, file paths), not from what you or Claude wrote. The archive holds those metrics and the session header described above, never conversation text.
- The terminal receipt shows project and file names because it stays on your screen; `export` (and `--redact`) hide them. Treat `--no-redact` exports and `--json` output as private.

Details: [docs/PRIVACY.md](docs/PRIVACY.md).

## Limitations

- It reads Claude Code's local session files, whose format is undocumented. It is tested against fixtures from Claude Code 2.1.283 and tolerates unknown records, but a format change can make metrics unavailable until it is updated.
- Receipts exist only for sessions still on disk or already archived. Sessions that Claude Code cleaned up before Claude Receipt first ran cannot be recovered.
- Heuristic metrics and observations (marked `~`) are estimates, not records.
- Images cover only the glyphs of the bundled IBM Plex Mono (see Images).
- v0.2.1 has been tested on Windows only. macOS and Linux have not been verified yet; the POSIX project-path test runs only there.

## Principles

- **Local-first.** Nothing is uploaded anywhere. No account and no network access are needed to produce a receipt.
- **Honest numbers.** Every metric is tagged `exact`, `derived` or `heuristic`, and estimates are never presented as facts. API-equivalent cost is never called "money spent".
- **Private by default.** Default analytics use metadata (timestamps, token counts, tool names, file paths), not what you or Claude wrote.
- **A story, not a dashboard.** Useful engineering stats plus a little session lore, printed like a thermal receipt.

## Documentation

| Doc | Contents |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |
| [docs/PRD.md](docs/PRD.md) | Product, user experience and scope |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, data flow, Session, Receipt and archive models |
| [docs/METRICS.md](docs/METRICS.md) | The metric registry: every metric, its source and provenance; the story rules |
| [docs/VISUAL_RECEIPT.md](docs/VISUAL_RECEIPT.md) | The image: design system, layout, export |
| [docs/PRIVACY.md](docs/PRIVACY.md) | What is read, what is never stored, export redaction |
| [docs/RELEASE.md](docs/RELEASE.md) | Build, package contents, versions, release checklist |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones and acceptance criteria |

## Licence

Claude Receipt is MIT-licensed ([LICENSE](LICENSE)). Third-party components keep their own licences and are not covered by the MIT licence:

- **IBM Plex Mono** Regular and Bold (`assets/fonts/`), bundled unmodified: SIL Open Font License 1.1, see [assets/fonts/IBMPlexMono-LICENSE.txt](assets/fonts/IBMPlexMono-LICENSE.txt). Copyright IBM Corp., Reserved Font Name "Plex".
- **`@resvg/resvg-wasm`**, the npm runtime dependency (installed separately, not bundled): Mozilla Public License 2.0.

## Disclaimer

Claude Receipt is an independent project and is not affiliated with Anthropic. It reads Claude Code's local session files, whose format is undocumented and may change.
