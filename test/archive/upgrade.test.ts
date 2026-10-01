// v0.2.0 is the first version bump: entries archived by 0.1.0 must stay readable and must never be
// silently recomputed by the newer generator. A 0.1.0 session whose transcript later changes is a
// conflict (the archived entry is kept, byte for byte), exactly as docs/ARCHITECTURE.md §6 says.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { HistoryReceipt } from "../../src/aggregate/types.ts";
import { buildReceipt } from "../../src/analytics/index.ts";
import { archiveKey, fingerprintOf, listArchive, readArchived, writeReceipt } from "../../src/archive/index.ts";
import { run } from "../../src/cli/run.ts";
import { GENERATOR, type Receipt } from "../../src/receipt/types.ts";
import { loadSessions, refForFile } from "../../src/source/claude-code/index.ts";

const FIX = join("fixtures", "claude-code", "2.1.283");
const NOW = new Date("2026-10-01T12:00:00.000Z");
const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "claude-receipt-upgrade-")); made.push(d); return d; };
const asV010 = (r: Receipt): Receipt => ({ ...r, generator: { ...r.generator, version: "0.1.0" } });
const A = "aaaa1111-0000-4000-8000-000000000001", B = "bbbb2222-0000-4000-8000-000000000002";

test("the generator stays 0.2.0 under package 0.2.1 (docs/RELEASE.md), and a v0.1.0 archive entry still reads back valid", async () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(GENERATOR.version, "0.2.0");
  assert.equal(pkg.version, "0.2.1", "a presentation and CLI release does not move the generator");
  const s = (await loadSessions([refForFile(join(FIX, "ordinary.jsonl"))]))[0]!;
  const dir = tmp();
  assert.equal(writeReceipt(asV010(buildReceipt(s, { now: NOW, timeZone: "UTC" })), fingerprintOf(s), { dir }).status, "created");
  const read = readArchived(s.id, dir);
  assert.equal(read.status, "ok");
  assert.equal(read.status === "ok" && read.entry.receipt.generator.version, "0.1.0");
  const { entries, problems } = listArchive(dir);
  assert.deepEqual([entries.length, problems.length], [1, 0]);
});

test("a 0.1.0 entry is not silently recomputed by 0.2.0: a changed transcript is a conflict and the entry is kept", async () => {
  const s = (await loadSessions([refForFile(join(FIX, "ordinary.jsonl"))]))[0]!;
  const dir = tmp();
  const old = asV010(buildReceipt(s, { now: NOW, timeZone: "UTC" }));
  writeReceipt(old, fingerprintOf(s), { dir });
  const file = join(dir, `${archiveKey(s.id)}.json`);
  const before = readFileSync(file);
  // the same session, grown (a continuation), built by the current generator
  const grown = { ...fingerprintOf(s), bytes: fingerprintOf(s).bytes + 100 };
  const w = writeReceipt(buildReceipt(s, { now: NOW, timeZone: "UTC" }), grown, { dir });
  assert.equal(w.status, "conflict");
  assert.match("reason" in w ? w.reason : "", /generator version/);
  assert.ok(readFileSync(file).equals(before), "the archived 0.1.0 entry is byte-identical");
});

test("through the CLI: unchanged 0.1.0 sessions are served from the archive; a changed one is a reported conflict, kept, and counted once", async () => {
  const root = tmp(), claude = join(root, "claude"), home = join(root, "receipt"), archive = join(home, "archive");
  mkdirSync(join(claude, "projects", "p"), { recursive: true });
  const fa = join(claude, "projects", "p", `${A}.jsonl`), fb = join(claude, "projects", "p", `${B}.jsonl`);
  writeFileSync(fa, readFileSync(join(FIX, "ordinary.jsonl")));
  writeFileSync(fb, readFileSync(join(FIX, "no-tools.jsonl")));
  // archive both as a 0.1.0 install would have
  for (const f of [fa, fb]) {
    const s = (await loadSessions([refForFile(f)]))[0]!;
    assert.equal(writeReceipt(asV010(buildReceipt(s, { now: NOW, timeZone: "UTC" })), fingerprintOf(s), { dir: archive }).status, "created");
  }
  const fileA = join(archive, `${archiveKey(A)}.json`), beforeA = readFileSync(fileA);
  const cli = async (argv: string[]) => {
    let out = "", err = "";
    const code = await run(argv, { stdout: (x) => { out += x; }, stderr: (x) => { err += x; }, cwd: root, env: { CLAUDE_CONFIG_DIR: claude, CLAUDE_RECEIPT_HOME: home }, isTTY: false, timeZone: "UTC", now: NOW });
    return { code, out, err };
  };
  // unchanged transcripts: skipped by fingerprint, the archived 0.1.0 receipts are used as they are
  const h1 = await cli(["all", "--json"]);
  assert.equal(h1.code, 0, h1.err);
  const x1 = JSON.parse(h1.out) as HistoryReceipt;
  assert.equal(x1.coverage.sessions, 2);
  assert.deepEqual(x1.coverage.generatorVersions, ["0.1.0"]);
  // session A grows: the 0.2.0 receipt conflicts with the 0.1.0 entry, which is kept
  appendFileSync(fa, "\n");
  const h2 = await cli(["all", "--json"]);
  assert.equal(h2.code, 0, h2.err);
  assert.match(h2.err, /archive conflict for aaaa1111: .*generator version/);
  assert.ok(readFileSync(fileA).equals(beforeA), "the 0.1.0 entry is untouched");
  const x2 = JSON.parse(h2.out) as HistoryReceipt;
  assert.equal(x2.coverage.sessions, 2, "the changed session still counts once");
  assert.deepEqual(x2.coverage.generatorVersions, ["0.1.0", "0.2.0"], "the history says which generators its sessions came from");
});
