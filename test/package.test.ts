// Release packaging: what `npm pack` actually puts in the tarball, the compiled build, and the
// package metadata. (The full install-from-tarball check is a release step: docs/RELEASE.md.)
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { GENERATOR } from "../src/receipt/types.ts";

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const build = (outDir: string) => execFileSync(process.execPath, [join("node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json", "--outDir", outDir], { stdio: "pipe" });

// `npm pack --dry-run` runs the `prepare` build and lists exactly what would be published
const packed = JSON.parse(execSync("npm pack --dry-run --json --silent", { encoding: "utf8", maxBuffer: 1 << 24 }))[0] as { files: { path: string; size: number }[]; size: number; name: string; version: string };
const files = packed.files.map((f) => f.path.replace(/\\/g, "/")).sort();

test("package metadata: name, version (= generator version), MIT, bin, engines, one pinned runtime dependency", () => {
  assert.equal(pkg.name, "claude-receipt");
  assert.equal(pkg.version, "0.2.0");
  assert.equal(GENERATOR.version, pkg.version, "receipts record the package version");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.bin, { "claude-receipt": "bin/claude-receipt.js" });
  assert.deepEqual(pkg.engines, { node: ">=24" });
  assert.deepEqual(pkg.dependencies, { "@resvg/resvg-wasm": "2.6.2" });
  // the lockfile agrees
  assert.equal(lock.version, pkg.version);
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  assert.equal(lock.packages["node_modules/@resvg/resvg-wasm"].version, "2.6.2");
  assert.equal(lock.packages["node_modules/@resvg/resvg-wasm"].dependencies, undefined, "resvg-wasm has no dependencies of its own");
  const runtime = Object.entries(lock.packages as Record<string, { dev?: boolean }>).filter(([k, v]) => k && !v.dev).map(([k]) => k);
  assert.deepEqual(runtime, ["node_modules/@resvg/resvg-wasm"], "nothing else installs for users");
  assert.match(readFileSync("LICENSE", "utf8"), /^MIT License\n\nCopyright \(c\) 2026/);
  assert.match(readFileSync("bin/claude-receipt.js", "utf8"), /^#!\/usr\/bin\/env node\n[^]*import "\.\.\/dist\/cli\/main\.js";\n$/);
});

test("tarball contents: compiled JS, executable, fonts, licences; no sources, tests, fixtures, docs or scripts", () => {
  for (const f of ["package.json", "README.md", "LICENSE", "bin/claude-receipt.js", "dist/cli/main.js", "dist/cli/run.js", "dist/cli/export.js", "dist/render/png.js", "dist/assets.js",
    "assets/fonts/IBMPlexMono-Regular.ttf", "assets/fonts/IBMPlexMono-Bold.ttf", "assets/fonts/IBMPlexMono-LICENSE.txt"]) assert.ok(files.includes(f), `missing ${f}`);
  for (const f of files) {
    assert.match(f, /^(package\.json|README\.md|LICENSE|bin\/claude-receipt\.js|dist\/.+\.js|assets\/fonts\/IBMPlexMono-(Regular\.ttf|Bold\.ttf|LICENSE\.txt))$/, `unexpected file in the package: ${f}`);
    assert.ok(!f.startsWith("dist/dev/"), `development script shipped: ${f}`);
  }
  // every compiled module of the app ships (src/dev excepted)
  const want = walk("src").map((p) => relative("src", p).replace(/\\/g, "/")).filter((p) => !p.startsWith("dev/")).map((p) => `dist/${p.replace(/\.ts$/, ".js")}`).sort();
  assert.deepEqual(files.filter((f) => f.startsWith("dist/")), want);
  assert.ok(packed.size < 400_000, `tarball ${packed.size} bytes`);
  const fonts = packed.files.filter((f) => f.path.endsWith(".ttf")).reduce((n, f) => n + f.size, 0);
  assert.ok(fonts / packed.files.reduce((n, f) => n + f.size, 0) > 0.6, "most of the package is the two font files");
});

test("compiled JS: no TypeScript imports, no source maps, no local paths, no ids or fixture content", () => {
  for (const f of walk("dist")) {
    const js = readFileSync(f, "utf8");
    assert.ok(!/from "[^"]+\.ts"|import\("[^"]+\.ts"\)|import "[^"]+\.ts"/.test(js), `${f}: imports a .ts file`);
    assert.ok(!/sourceMappingURL/.test(js), `${f}: source map`);
    assert.ok(!/(?<![A-Za-z])[A-Za-z]:(\\\\|\/)|\/home\/|\/Users\/|\/tmp\//i.test(js), `${f}: absolute local path`); // a drive letter, not "http:/"
    assert.ok(!js.includes(process.cwd()) && !js.includes(process.cwd().replace(/\\/g, "/")), `${f}: build machine path`);
    assert.ok(!/(?:msg|toolu|req|srvtoolu)_[A-Za-z0-9]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(js), `${f}: id-shaped string`);
    assert.ok(!/fixture/i.test(js), `${f}: fixture reference`);
  }
});

test("build is reproducible: two clean builds produce byte-identical output", () => {
  const [a, b] = [0, 1].map(() => { const d = mkdtempSync(join(tmpdir(), "claude-receipt-build-")); made.push(d); build(d); return d; });
  const hashes = (d: string) => walk(d).map((f) => `${relative(d, f).replace(/\\/g, "/")} ${createHash("sha256").update(readFileSync(f)).digest("hex")}`).sort();
  assert.deepEqual(hashes(a!), hashes(b!));
  assert.deepEqual(hashes(a!), hashes("dist"), "the packed dist/ is that same build");
});

test("the built executable runs from another working directory", () => {
  const cwd = mkdtempSync(join(tmpdir(), "claude-receipt-bin-"));
  made.push(cwd);
  const bin = join(process.cwd(), "bin", "claude-receipt.js");
  assert.equal(execFileSync(process.execPath, [bin, "--version"], { cwd, encoding: "utf8" }), `claude-receipt ${pkg.version}\n`);
  assert.match(execFileSync(process.execPath, [bin, "--help"], { cwd, encoding: "utf8" }), /claude-receipt export/);
  assert.ok(statSync(join("dist", "cli", "main.js")).isFile());
});
