# CLAUDE.md

Instructions for agents working in this repository. Read `docs/` before non-trivial changes. The docs are the spec, and if code and docs disagree, raise it; don't silently pick one.

## What this is

Claude Receipt turns Claude Code sessions into receipts: hard stats, coding stats and session lore. It is local-first, privacy-first and honest about what it knows. See `docs/PRD.md`.

## Status

M0 (format verification) done: see `docs/research/M0_FINDINGS.md`. No application code yet. Do not scaffold, install dependencies or write the production parser unless the current task explicitly asks for it.

## Commands

No dependencies and no `package.json` yet. Node ≥ 22.

| Command | What it does |
|---|---|
| `node --test "test/*.test.mjs"` | All tests: M0 rules on fixtures + fixture safety |
| `node scripts/m0/inspect.mjs` | Probe the real `~/.claude/projects`: counts, reconciliation, path rule. Metadata only |
| `node scripts/m0/build-fixtures.mjs` | Regenerate `fixtures/claude-code/2.1.283` from the M0 lab sessions (only on the machine that has them) |
| `node scripts/anonymize-fixture.mjs <out-dir> <in.jsonl>…` | Anonymize transcripts into fixture candidates (review before committing) |
| `node scripts/m0/watch-transcript.mjs <sessionId> [seconds]` | Sample a live transcript for partial writes |

`scripts/m0/rules.mjs` is the tested reference for parsing rules (deduplication, prompt kinds, tolerant JSONL, reconciliation). M1 ports it; don't diverge from it silently.

## Architectural boundaries (do not cross)

```
source/claude-code  →  Session  →  analytics  →  Receipt  →  render/tty | render/json | (future) render/svg
                                        ↓
                                 archive (metrics only)  →  aggregate  →  (future) week / month / wrapped
```

- **source/** is the only code that knows Claude Code's file format. Nothing downstream may read raw JSONL records or know field names like `toolUseResult`.
- **Session** is plain data with no text content (no prompts, responses, file contents or raw commands). The only exception is the Claude Code–generated session title, which is display-only and never archived.
- **analytics/** is pure functions: Session (+ optional git facts) → Receipt. No I/O and no formatting.
- **Receipt contains semantic data, never presentation copy or layout.** Semantic values may be strings (model names, languages, file names, project identifiers, versions) as well as numbers. Labels, headings, formatting (units, rounding, `1h 42m`), playful microcopy, ANSI codes, padding and visual layout belong to the format/render layer.
- **render/json** is a stable, versioned public contract (`schemaVersion`). A breaking change needs a version bump and a note in `docs/ARCHITECTURE.md`.
- **archive/** stores computed metrics only, with a versioned schema. It never deletes entries because a transcript disappeared.
- No plugin framework and no adapter registry. There is exactly one source adapter until a second real format exists.

## Metric rules (the most important section)

- Every metric carries provenance: `exact | derived | heuristic`. Definitions are in `docs/METRICS.md`.
- **Never invent, fake, pad or guess a metric.** If a value can't be determined, it is `null` with a reason, never `0`. Missing is not zero.
- **Never present a heuristic as exact.** Renderers must visibly mark heuristic values (e.g. `~`).
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
