# Product Requirements: Claude Receipt

## 1. Summary

Claude Receipt tells the story of a Claude Code session as a receipt. It combines factual engineering metrics with playful session lore, and presents them as a physical thermal receipt. It runs entirely on the user's machine.

It is **not** a token and cost tracker with a receipt skin. Tokens and cost are one section of the receipt, not its purpose.

## 2. Users

- **Claude Code users** who want to see what happened in a session: "what did we just do for two hours?"
- **Developers who share their work**: a receipt screenshot or image is a fun, low-effort artefact for social media, a team channel or a stand-up.
- **Heavy users** who want a longer view (weeks, months, a yearly Wrapped).

## 3. Product principles

1. **Tell a story.** Every receipt mixes three categories:
   - **Hard stats**: duration, models, tokens, API-equivalent cost, prompts, tool calls.
   - **Coding stats**: files, lines, languages, commands, tests, errors, commits.
   - **Session lore**: biggest rabbit hole, longest turn, peak hour, unusual patterns, personality.
2. **Honest numbers.** Every metric has provenance (`exact | derived | heuristic`). Hard and coding stats are exact or derived wherever possible. Lore may be heuristic but is always marked as such. The three provenances stay visually and semantically distinguishable on every surface: derived and heuristic values are never presented as recorded facts. Unknown values are omitted, never shown as zero.
3. **Private by default.** Nothing leaves the machine. Default analytics read metadata, not conversation meaning. Text-based features are opt-in. Exports are redacted by default where appropriate.
4. **Feels like a real receipt.** Narrow, monochrome, typographic, itemized, with playful microcopy. Not a dashboard squeezed into a rectangle.
5. **History survives.** Claude Code deletes old transcripts (30 days by default). Claude Receipt archives computed metrics so long-term summaries remain possible.

## 4. Cost language

- The cost line is always labelled **API EQUIVALENT**. It means "what these tokens would cost at API list prices", not what the user paid.
- The words "spent", "paid", "charged", "bill" and "cost you" are never used.
- **There is no PLAN line.** Plan and subscription display was removed from the product on 2026-10-01. M0 found no reliable, historical, session-level source (`M0_FINDINGS.md` §8), and `~/.claude.json` is not read. This will be reconsidered only if Claude Code exposes reliable session-level plan information.

```
API EQUIVALENT        $12.84
```

## 4a. Which sessions count

- **Headless / SDK sessions** (`entrypoint: "sdk-cli"`, e.g. `claude -p`) are legitimate Claude Code activity. They are **included by default** in receipts and in future aggregates and Wrapped. `entrypoint` is kept in the Session and archive so filtering can be added later; no filtering option exists yet.
- **Resumed sessions**: a session id's receipt covers **the whole session, across every run** (each resume is a run). Run boundaries are preserved in the Session model so a future `claude-receipt last --run` (most recent run only) can be added. It is not implemented.

## 5. User experience

### 5.1 Terminal receipt (MVP)

Running `claude-receipt` in a project directory prints a receipt for the current or most recent session in that directory. The layout is a narrow column (about 40 characters) with:

- A header: logo text, session id (short), date, project name.
- **Hard stats** section.
- **Coding stats** section.
- **Session lore** section (a few items, not all).
- A footer with playful microcopy (e.g. "THANK YOU FOR SHIPPING", "NO REFUNDS ON TOKENS").
- A small legend if any heuristic (`~`) values are present.

It must render correctly with or without colour (`NO_COLOR`), in narrow terminals, and on Windows terminals.

As built (M3): 40 columns (down to 28 on narrow terminals), ASCII only apart from user-supplied names, ANSI bold/dim only on a TTY without `NO_COLOR`. Every metric shows its provenance (plain = recorded, ` *` = computed, `~` = estimated) with a legend. Metrics that are unavailable are left out and counted ("N metrics unavailable, not shown"). A live session is marked `LIVE`. Archive status and problems are printed on stderr, never inside the receipt.

### 5.2 JSON output (MVP)

`--json` prints the Receipt model as JSON: a stable, versioned contract for scripts. The visual renderer consumes the same Receipt model.

### 5.3 Visual receipt (first-class; built as M6, shipped in v0.1)

A generated SVG/PNG receipt image:

- physical thermal receipt; narrow vertical layout
- monochrome or near-monochrome
- excellent monospace/typewriter typography
- itemized statistics; dotted and solid separators
- perforated/torn paper edges; subtle paper texture
- playful microcopy; minimal surrounding interface

It is driven by the same Receipt model as the terminal. Exports are redacted by default (see `PRIVACY.md`).

Specified in `docs/VISUAL_RECEIPT.md`:
- IBM Plex Mono; a 576 px paper (80 mm thermal roll width) on a flat `#E8E5DE` backdrop; flat `#FAF8F2` paper (the subtle texture above is deferred: no grain in the MVP).
- SVG as the canonical output; PNG at 2×.
- The same provenance marks as the terminal.
- `claude-receipt export` redacted by default, with one opt-out, `--no-redact`.
- Image glyphs are limited to the bundled font's coverage (no CJK fallback yet).

### 5.4 Commands

| Command | Meaning | Phase |
|---|---|---|
| `claude-receipt` | Current or most recent session for the current directory, falling back to the most recent session anywhere. "Most recent" = latest recorded activity (`endedAt`, then `startedAt`, then id). May be a live session (shown as LIVE, not archived) | MVP (M3) |
| `claude-receipt last` | The most recent completed session anywhere (not live, last run closed), same ordering | MVP (M3) |
| `claude-receipt <sessionId>` | A specific session (a unique prefix is enough; ambiguous prefixes are an error) | MVP (M3) |
| `claude-receipt --json` | The Receipt JSON contract (combines with the above; `list --json` prints semantic rows) | MVP (M3) |
| `claude-receipt list` | Recent sessions (default 20, `--limit N`): start time, short id, project, duration, state; sessions whose transcript is gone come from the archive | MVP (M3) |
| `claude-receipt all` / `week` / `month` | History receipt: every finished session, or the last 7 / 30 local calendar days (terminal, `--json`, and `export all|week|month` as SVG/PNG) | v0.2 (M5, in development) |
| `claude-receipt all\|week\|month --project` | The same, for the current directory's project | v0.2 (M5, in development) |
| `claude-receipt export` | SVG/PNG receipt, redacted by default (`--no-redact` to opt out) | v0.1 (M6, built ahead of M5) |
| `claude-receipt wrapped [year]` | Yearly Claude Wrapped | Future (M8) |

Every run archives newly seen or changed sessions as a side effect, so history accumulates from the first use (see `ARCHITECTURE.md` §6). `--no-archive` makes a run read-only; `--redact` applies the export redaction rules (`PRIVACY.md` §6). Exit codes: 0 success, 1 nothing to show (no sessions, no match, ambiguous prefix), 2 usage error.

## 6. MVP scope

**In:**

- Parse Claude Code transcripts for one session into a normalized Session.
- Compute the MVP metrics in `METRICS.md` (those marked MVP) with provenance.
- Terminal receipt, `--json`, `last`, `<sessionId>`, `list`.
- Git enrichment when the session `cwd` is a git repository: commits in the session window, `Co-Authored-By: Claude` attribution.
- Local metrics archive with a versioned schema, written on every run.
- Anonymized fixture test suite.
- SVG/PNG export (`claude-receipt export`) and the visual design system: originally postponed, built ahead of schedule as M6 (`VISUAL_RECEIPT.md`).

**Out (postponed):**

- `wrapped`. (`all`, `week`, `month` and `--project` are v0.2.)
- Any feature that reads prompt or response text (recurring phrases, text-based personality).
- `--run` (receipt for only the latest run of a resumed session). The data is preserved; the option isn't built.
- Entrypoint filtering (e.g. excluding headless sessions). The data is preserved; the option isn't built.
- Subagent breakdowns (until M0 verifies storage).
- Cross-project or cross-session comparisons.
- Automatic Claude Code hooks (e.g. printing a receipt on session end). The tool never edits Claude Code configuration; users may add a hook themselves, following documentation we provide later.

## 7. Success criteria for the MVP

- A user can install and run it with a single command and get a correct receipt for their latest session.
- Token totals match Claude Code's own `cost-state` totals where those exist (see `ROADMAP.md` M0/M1).
- No metric ever shows a fabricated value. Unknowns are omitted and heuristics are marked.
- Running it never modifies `~/.claude`, and it makes no network calls.

## 8. Future direction

- **Periods** (M5, v0.2): `all`, `week`, `month` and `--project` history receipts from the archive and the current sweep (`METRICS.md` → Historical metrics).
- **Visual receipt** (M6): the shareable artefact, with redaction on by default.
- **Claude Wrapped** (M8): the yearly story, with top projects, languages, busiest day, longest session and personality over time.
- **Opt-in text lore** (M7): recurring Claude phrases and text-informed personality, computed in memory and never archived as text.
- **Comparisons**: this session versus your average, and project against project.

## 9. Open questions

- The npm package name `claude-receipt`: check availability before M1.
- Whether "current session" should prefer a live session over the most recent completed one when both exist in the same directory (decide in M2 from real use).
