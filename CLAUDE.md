# CLAUDE.md

Instructions for agents working in this repository. Read `docs/` before non-trivial changes. The docs are the spec, and if code and docs disagree, raise it; don't silently pick one.

## What this is

Claude Receipt turns Claude Code sessions into receipts: hard stats, coding stats and session lore. It is local-first, privacy-first and honest about what it knows. See `docs/PRD.md`.

## Status

- M0 (format verification): done, see `docs/research/M0_FINDINGS.md`.
- M1a (source adapter + normalized Session in `src/source/claude-code/`): implemented, see `docs/research/M1_FINDINGS.md`.
- M1b (analytics in `src/analytics/`, Receipt model + validator in `src/receipt/`, Receipt JSON in `src/render/json.ts`, read-only git in `src/git/`): implemented.
- M2 (local metrics-only archive in `src/archive/`): implemented.
- M3 (CLI in `src/cli/` with the archive sweep, terminal renderer in `src/render/tty.ts` + `format.ts`, redaction in `src/receipt/redact.ts`): implemented.
- M6 (visual receipt): specified in `docs/VISUAL_RECEIPT.md` and being built ahead of M4/M5, in stages named "Visual Receipt — Spec / SVG / PNG / Packaging" (descriptive stage names, not milestone numbers; never renumber the official roadmap). Spec and SVG stages are done: `src/render/visual/spec.ts` (design tokens), `src/render/visual/layout.ts` (Receipt → VisualDoc), `src/render/svg.ts` (VisualDoc → SVG), `src/assets.ts` (loads the bundled fonts in `assets/fonts/`). PNG and `export` are not built.
- M4 (v0.1 release), M5 (periods), M7+ (lore, Wrapped): not started. Don't build anything beyond the current task.
- The visual renderer is a pure consumer of the Receipt, exactly like the terminal renderer: no filesystem, git, archive, transcript or environment access, no new analytics, and the same provenance marks and copy from `src/render/format.ts`.

## Commands

Node ≥ 24 runs the TypeScript sources directly (no build step). Dev-only dependencies: `typescript`, `@types/node` (`npm install`). No runtime dependencies. No linter is configured.

| Command | What it does |
|---|---|
| `npm test` | All tests: parser (`test/source/`), analytics and Receipt contract (`test/analytics/`), git enrichment on throwaway repos (`test/git/`), archive (`test/archive/`), renderer and snapshots (`test/render/`), CLI and sweep (`test/cli/`), fixture safety |
| `node src/cli/main.ts [last \| list \| <prefix>] [--json] [--redact] [--no-archive]` | The product CLI (also `npm run receipt --`, or `claude-receipt` after `npm link`). Writes to the real archive unless `--no-archive` or `CLAUDE_RECEIPT_HOME` points elsewhere |
| `npm run typecheck` | `tsc` in strict mode, no emit |
| `node src/dev/parse.ts <main.jsonl>...` | Parse transcripts together (forks detected among them) and print Session JSON |
| `node src/dev/parse.ts --session <id\|prefix>` / `--all` | Same for local sessions under `CLAUDE_CONFIG_DIR` or `~/.claude` |
| `node src/dev/parse.ts … --summary` | Counts only. **Use this on real sessions**; full Session JSON contains paths and titles |
| `node src/dev/receipt.ts <main.jsonl>...` / `--session <id>` / `--all` | Session → git (read-only) → Receipt JSON. Flags: `--no-git`, `--tz <zone>` |
| `node src/dev/receipt.ts … --summary` | Provenance and null reasons per metric, no values. **Use this on real sessions** |
| `node src/dev/archive.ts --all [--dir <path>]` | Archive every non-live local session (development sweep). Writes to the real archive unless `--dir` or `CLAUDE_RECEIPT_HOME` points elsewhere; prints status counts only |
| `node scripts/m0/build-fixtures.mjs` | Regenerate `fixtures/claude-code/2.1.283` from the M0 lab sessions (only on the machine that has them) |
| `node scripts/anonymize-fixture.mjs <out-dir> <in.jsonl>…` | Anonymize transcripts into fixture candidates (review before committing) |
| `node scripts/m0/watch-transcript.mjs <sessionId> [seconds]` | Sample a live transcript for partial writes |

`src/source/claude-code/` is the only code that reads Claude Code's format. Its rules are pinned by `test/source/`; change a rule only together with its test and the findings doc.

## Architectural boundaries (do not cross)

```
source/claude-code  →  Session  →  analytics  →  Receipt  →  render/tty | render/json | render/visual → render/svg
                                        ↓
                                 archive (metrics only)  →  aggregate  →  (future) week / month / wrapped
```

- **source/** is the only code that knows Claude Code's file format. Nothing downstream may read raw JSONL records or know field names like `toolUseResult`.
- **Session** is plain data with no text content (no prompts, responses, file contents or raw commands). The only exception is the Claude Code–generated session title, which is display-only and never archived.
- **analytics/** is pure functions: Session (+ optional git facts) → Receipt. No I/O and no formatting.
- **Receipt contains semantic data, never presentation copy or layout.** Semantic values may be strings (model names, languages, file names, project identifiers, versions) as well as numbers. Labels, headings, formatting (units, rounding, `1h 42m`), playful microcopy, ANSI codes, padding and visual layout belong to the format/render layer.
- **render/json** is a stable, versioned public contract (`schemaVersion`). A breaking change needs a version bump and a note in `docs/ARCHITECTURE.md`.
- **archive/** stores computed metrics only (the Receipt without its title), with a versioned schema, keyed by a hash of the session id. It never deletes entries because a transcript disappeared, never overwrites a conflicting or unreadable entry, and never stores API-call, message, tool-use or agent ids (hashed or not).
- No plugin framework and no adapter registry. There is exactly one source adapter until a second real format exists.

## Metric rules (the most important section)

- Every metric carries provenance: `exact | derived | heuristic`. Definitions are in `docs/METRICS.md`.
- **Never invent, fake, pad or guess a metric.** If a value can't be determined, it is `null` with a reason, never `0`. Missing is not zero.
- **Never present a heuristic as exact.** Renderers must visibly mark heuristic values (e.g. `~`).
- **Exact, derived and heuristic stay visually and semantically distinguishable in every renderer** (terminal, SVG/PNG, aggregates, Wrapped). Derived and heuristic values, including the playful lore ones (rabbit hole, error streak, active time, test runs, Claude-authored commits), are never presented or worded as directly recorded facts. See `docs/METRICS.md` → Rendering rule.
- A new metric needs an entry in `docs/METRICS.md` (source, provenance, calculation, limitations, privacy) in the same change.
- Cost is **API-equivalent**. Never label it "spent", "paid", "charged" or "bill".
- **No plan/subscription information.** It was removed from the product (see `docs/PRD.md` §4). Never read `~/.claude.json`.
- Headless (`sdk-cli`) sessions are included by default. Keep `entrypoint` so filtering stays possible.
- A session's receipt covers all of its runs. Keep run boundaries in the Session and never collapse them away.
- Token usage must be deduplicated by API message id (Claude Code writes one response across several lines that repeat the same `usage`).

## Privacy rules

See `docs/PRIVACY.md`. In short:

- Never read `~/.claude/.credentials.json`, `*.key` files or credential/org attachments. Never print tokens, keys or secrets.
- Never modify anything under `~/.claude/` or Claude Code's configuration.
- No network calls. Pricing data ships with the package.
- Default metrics must not need prompt or response text. Text-based features are opt-in, computed in memory and not archived.
- Don't store raw shell commands (they can contain secrets). Store the program name and category only.
- When debugging, inspect schemas and counts, not conversation contents.

## Code expectations

- TypeScript on Node (version pinned at M1). Minimal dependencies, and every new dependency needs a reason.
- Stream JSONL line by line. Tolerate unknown record types and a truncated final line (sessions are written live).
- Store timestamps in UTC and convert to local time only in renderers or when bucketing by local hour or day.
- Use `cwd` from records, never decode Claude Code's encoded project directory names.
- Tests run against anonymized fixtures in `fixtures/`. Parser behaviour changes need a fixture that shows it.
- Never commit a real transcript. Fixtures go through the anonymizer and are reviewed before commit.
- Keep it boring: no abstractions ahead of need, fewest files that stay readable.
