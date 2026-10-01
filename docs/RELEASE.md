# Release

How Claude Receipt is built and checked before a release. Nothing here publishes anything.

## Build

- Development runs the TypeScript sources directly (Node ≥ 24 type stripping); `tsconfig.json` is check-only.
- The package ships compiled JavaScript: `npm run build` runs `tsc -p tsconfig.build.json`, which compiles `src/` (except `src/dev/`) to `dist/` as plain ESM and rewrites `.ts` import specifiers to `.js`. No bundler, no source maps, no declarations. Two clean builds are byte-identical (tested).
- `npm install` in a checkout and `npm pack` run the build through the `prepare` script. `dist/` is not committed.
- `bin/claude-receipt.js` imports `dist/cli/main.js`. Fonts are found relative to the compiled module (`dist/assets.js` → `../assets/fonts/`), and the resvg WebAssembly binary through Node's module resolution, so both work from any working directory and inside `node_modules`.

## Versions

Two versions, changed independently (since 0.2.1):

- **Package version** (`version` in `package.json`, `VERSION` in `src/cli/run.ts`, printed by `claude-receipt --version`): the product release. It changes with every release.
- **Generator version** (`GENERATOR.version` in `src/receipt/types.ts`): the version of the semantic metric computation. Every Receipt, HistoryReceipt and archive entry records it. It changes only when the computation changes (a metric's value, provenance or availability for the same transcript). A presentation or CLI release keeps it. The archive never updates an entry made by a different generator version: an unchanged transcript keeps its archived Receipt, and a grown one becomes a conflict (`ARCHITECTURE.md` §6). Moving the generator is therefore a deliberate step; moving it without a computation change would only turn resumed sessions into conflicts.

0.2.1 is a presentation and CLI release: package 0.2.1, generator 0.2.0. `test/package.test.ts` and `test/archive/upgrade.test.ts` pin both.

The JSON schema versions (`schemaVersion` of the Receipt and the HistoryReceipt) are a third, separate contract, bumped only for a breaking change to the JSON shape (`ARCHITECTURE.md`).

## Package contents

`files` in `package.json` allowlists `bin/`, `dist/` and `assets/fonts/`; npm adds `package.json`, `README.md` and `LICENSE`. `test/package.test.ts` checks the real `npm pack` file list against that allowlist (no sources, tests, fixtures, docs, scripts or changelog), scans the compiled JS for local paths and ids, checks that `package.json`, the lockfile and `VERSION` agree, and that the built executable runs.

The tarball is about 200 KB (about 540 KB unpacked); most of it is the two IBM Plex Mono files.

## Licences

- Claude Receipt: MIT (`LICENSE`).
- IBM Plex Mono Regular and Bold (`assets/fonts/`): SIL Open Font License 1.1, shipped unmodified with `assets/fonts/IBMPlexMono-LICENSE.txt`.
- `@resvg/resvg-wasm` 2.6.2 (the only runtime dependency, installed by npm from its own published package): MPL-2.0, declared in its `package.json` (the package ships no separate licence file). It is used unmodified and not bundled into Claude Receipt's tarball, so its MPL-2.0 source is the upstream project's.

## Checklist before publishing

1. `npm test`, `npm run typecheck`, `git diff --check`.
2. `npm pack`, then in a fresh directory outside the repository: `npm install <tarball>` (and `npm install -g --prefix <tmp> <tarball>`), and run the installed `claude-receipt` from an unrelated working directory with a temporary `CLAUDE_RECEIPT_HOME`: `--help`, `--version`, the default receipt, `last`, `list`, `--json`, `all`, `project <name>`, `export` (PNG), `export --svg`, `export --no-redact`, `<prefix> export`, `project <name> export`, an `--output` that already exists (must fail untouched), and `npx --package <tarball> claude-receipt --version`.
3. The same on macOS and Linux (the POSIX project-path test runs only there).
4. Bump the package version in `package.json` and `VERSION` (`src/cli/run.ts`) together, and sync the lockfile (`npm install --package-lock-only`). Bump `GENERATOR.version` only if the metric computation changed (see Versions). Add a `CHANGELOG.md` entry.
