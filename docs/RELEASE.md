# Release

How Claude Receipt is built and checked before a release. Nothing here publishes anything.

## Build

- Development runs the TypeScript sources directly (Node ≥ 24 type stripping); `tsconfig.json` is check-only.
- The package ships compiled JavaScript: `npm run build` runs `tsc -p tsconfig.build.json`, which compiles `src/` (except `src/dev/`) to `dist/` as plain ESM and rewrites `.ts` import specifiers to `.js`. No bundler, no source maps, no declarations. Two clean builds are byte-identical (tested).
- `npm install` in a checkout and `npm pack` run the build through the `prepare` script. `dist/` is not committed.
- `bin/claude-receipt.js` imports `dist/cli/main.js`. Fonts are found relative to the compiled module (`dist/assets.js` → `../assets/fonts/`), and the resvg WebAssembly binary through Node's module resolution, so both work from any working directory and inside `node_modules`.

## Package contents

`files` in `package.json` allowlists `bin/`, `dist/` and `assets/fonts/`; npm adds `package.json`, `README.md` and `LICENSE`. `test/package.test.ts` checks the real `npm pack` file list against that allowlist (no sources, tests, fixtures, docs or scripts), scans the compiled JS for local paths and ids, checks that `package.json`, the lockfile and the generator version agree, and that the built executable runs.

The tarball is about 200 KB (about 530 KB unpacked); most of it is the two IBM Plex Mono files.

## Licences

- Claude Receipt: MIT (`LICENSE`).
- IBM Plex Mono Regular and Bold (`assets/fonts/`): SIL Open Font License 1.1, shipped unmodified with `assets/fonts/IBMPlexMono-LICENSE.txt`.
- `@resvg/resvg-wasm` 2.6.2 (the only runtime dependency, installed by npm): MPL-2.0.

## Checklist before publishing

1. `npm test`, `npm run typecheck`, `git diff --check`.
2. `npm pack`, then in a fresh directory outside the repository: `npm install <tarball>` (and `npm install -g --prefix <tmp> <tarball>`), and run the installed `claude-receipt` from an unrelated working directory with a temporary `CLAUDE_RECEIPT_HOME`: `--help`, `--version`, the default receipt, `last`, `list`, `--json`, `export` (PNG), `export --svg`, `export --no-redact`, an `--output` that already exists (must fail untouched), and `npx --package <tarball> claude-receipt --version`.
3. The same on macOS and Linux.
4. Bump `version` in `package.json` and `GENERATOR.version` in `src/receipt/types.ts` together (a test enforces it), and sync the lockfile (`npm install --package-lock-only`).
