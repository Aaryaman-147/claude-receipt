# Claude Receipt

> Every Claude Code session, itemized.

Claude Receipt is a local-first tool that turns a Claude Code session into a receipt: the hard numbers (time, models, tokens, API-equivalent cost), the coding work (files, lines, commands, tests, commits) and a bit of session lore (the biggest rabbit hole, the peak hour, what kind of session it was).

The long-term goal is "Spotify Wrapped for Claude Code": session receipts, weekly and monthly summaries, and a yearly Claude Wrapped. All of it is computed on your machine from the data Claude Code already writes locally.

```
        CLAUDE RECEIPT
   ----------------------------
   SESSION        a3f9…  14:02
   PROJECT        claude-receipt
   DURATION              1h 42m
   ............................
   PROMPTS                   23
   TOOL CALLS               187
   LINES              +412 -97
   ............................
   API EQUIVALENT        $12.84
   ============================
      THANK YOU FOR SHIPPING
```

*Illustrative mock-up only. None of this output exists yet.*

## Status

**Experimental. Pre-implementation.** This repository currently contains the product and technical planning documents, plus the M0 research into Claude Code's local format ([findings](docs/research/M0_FINDINGS.md), anonymized fixtures and verification tests). There is no working CLI, no parser and no package to install yet.

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
