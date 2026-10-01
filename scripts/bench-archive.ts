// Archive and history benchmark (development only; not part of the package).
//
//   node scripts/bench-archive.ts [N ...]        default: 1000 5000
//
// Builds synthetic archives of N session entries in a temporary home and times archive reading,
// validation, aggregation and complete history commands. Entries are real Receipts computed from
// the anonymized fixtures (fixtures/claude-code/), given synthetic ids, dates (spread over a year,
// ~1% undated), projects (50) and time zones (2), and written through the real `writeReceipt`, so
// every file is a genuine, validated archive entry. Nothing here reads or writes ~/.claude or
// ~/.claude-receipt: CLAUDE_CONFIG_DIR and CLAUDE_RECEIPT_HOME point at the temporary home, which is
// deleted afterwards. Timings depend on the machine, disk and Node version; compare runs on one machine.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { aggregate } from "../src/aggregate/index.ts";
import type { Period } from "../src/aggregate/types.ts";
import { validateHistory } from "../src/aggregate/validate.ts";
import { buildReceipt } from "../src/analytics/index.ts";
import { fingerprintOf, listArchive, validateEntry, writeReceipt } from "../src/archive/index.ts";
import { run, type Io } from "../src/cli/run.ts";
import type { Receipt } from "../src/receipt/types.ts";
import { loadSessions, refForFile } from "../src/source/claude-code/index.ts";

const REPO = resolve(import.meta.dirname, "..");
const FIXTURES = join(REPO, "fixtures", "claude-code", "2.1.283");
const NOW = new Date("2026-10-01T12:00:00.000Z"); // fixed, so the period counts are reproducible
const RUNS = 5, PROCESS_RUNS = 3;
const PERIODS: Period[] = ["all", "week", "month"];

type Stats = { median: number; min: number; max: number };
const stats = (xs: number[]): Stats => { const s = [...xs].sort((a, b) => a - b); return { median: s[Math.floor(s.length / 2)]!, min: s[0]!, max: s.at(-1)! }; };
const fmt = (x: Stats) => `${x.median.toFixed(0).padStart(5)} ms  (min ${x.min.toFixed(0)}, max ${x.max.toFixed(0)})`;
async function time(f: () => unknown, runs = RUNS): Promise<Stats> {
  const xs: number[] = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); await f(); xs.push(performance.now() - t); }
  return stats(xs);
}

// Templates: Receipts from anonymized fixtures, with their transcript fingerprints.
const names = ["ordinary.jsonl", "no-tools.jsonl", "killed.jsonl", "write-update-replaceall.jsonl", "resumed.jsonl", "prompt-kinds.jsonl", "forked.jsonl"];
const templates = (await Promise.all(names.map((n) => loadSessions([refForFile(join(FIXTURES, n))])))).flat()
  .map((s) => ({ receipt: buildReceipt(s, { now: NOW, timeZone: "UTC" }), source: fingerprintOf(s) }));

function synthetic(i: number): { receipt: Receipt; source: (typeof templates)[number]["source"] } {
  const { receipt: r, source } = templates[i % templates.length]!;
  const startedAt = i % 97 === 0 ? null : new Date(NOW.getTime() - ((i * 7919 * 60_000) % (365 * 86_400_000))).toISOString();
  const length = r.session.startedAt && r.session.endedAt ? Date.parse(r.session.endedAt) - Date.parse(r.session.startedAt) : 0;
  const n = (i + 1).toString(16);
  const project = `project-${i % 50}`;
  return {
    source,
    receipt: {
      ...r,
      context: { timeZone: i % 10 === 0 ? "Asia/Kolkata" : "UTC" },
      session: {
        ...r.session,
        id: `${n.padStart(8, "0")}-0000-4000-8000-${n.padStart(12, "0")}`,
        title: null, forkOf: null, project, projectKey: `c:\\work\\${project}`, cwd: `C:\\work\\${project}`,
        startedAt, endedAt: startedAt && new Date(Date.parse(startedAt) + length).toISOString(),
      },
    },
  };
}

async function bench(N: number) {
  const root = mkdtempSync(join(tmpdir(), "claude-receipt-bench-"));
  const claude = join(root, "claude"), receiptHome = join(root, "receipt"), archive = join(receiptHome, "archive");
  if ([claude, receiptHome].some((p) => p.startsWith(join(homedir(), ".claude")))) throw new Error("refusing to use a real Claude or Claude Receipt home");
  mkdirSync(join(claude, "projects"), { recursive: true }); // no transcripts: every session comes from the archive
  try {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const { receipt, source } = synthetic(i);
      const w = writeReceipt(receipt, source, { dir: archive, now: NOW });
      if (w.status !== "created") throw new Error(`entry ${i}: ${w.status}`);
    }
    const files = readdirSync(archive).filter((f) => f.endsWith(".json"));
    const bytes = files.reduce((sum, f) => sum + readFileSync(join(archive, f)).length, 0);
    console.log(`\n=== ${N} sessions: ${files.length} entries, ${(bytes / 1048576).toFixed(1)} MB (avg ${(bytes / files.length / 1024).toFixed(1)} KB), written in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

    const parsed = files.map((f) => JSON.parse(readFileSync(join(archive, f), "utf8")));
    const { entries, problems } = listArchive(archive);
    if (entries.length !== N || problems.length) throw new Error(`listArchive: ${entries.length} entries, ${problems.length} problems`);
    const receipts = entries.map((e) => e.receipt);
    const counts = PERIODS.map((p) => `${p} ${aggregate(receipts, { period: p, now: NOW, timeZone: "UTC" }).coverage.sessions}`).join(", ");
    console.log(`sessions per period: ${counts} (${receipts.filter((r) => !r.session.startedAt).length} undated)`);

    const io = (): Io => ({ stdout: () => {}, stderr: () => {}, cwd: root, env: { CLAUDE_CONFIG_DIR: claude, CLAUDE_RECEIPT_HOME: receiptHome }, isTTY: false, timeZone: "UTC", now: NOW });
    const rows: [string, Stats][] = [
      ["archive read + JSON.parse", await time(() => { for (const f of files) JSON.parse(readFileSync(join(archive, f), "utf8")); })],
      ["validateEntry (already parsed)", await time(() => { for (const e of parsed) validateEntry(e); })],
      ["listArchive (read + validate)", await time(() => listArchive(archive))],
    ];
    for (const p of PERIODS) rows.push([`aggregate ${p} (+ validateHistory)`, await time(() => { const h = aggregate(receipts, { period: p, now: NOW, timeZone: "UTC" }); if (validateHistory(h).length) throw new Error("invalid history"); })]);
    for (const p of PERIODS) rows.push([`run ${p} (sweep + aggregate + render)`, await time(async () => { if (await run([p, "--no-archive"], io()) !== 0) throw new Error(`${p} failed`); })]);
    rows.push(["run all --json", await time(async () => { if (await run(["all", "--json", "--no-archive"], io()) !== 0) throw new Error("all --json failed"); })]);
    rows.push(["CLI process: claude-receipt all", await time(() => {
      const r = spawnSync(process.execPath, [join(REPO, "src", "cli", "main.ts"), "all", "--no-archive"], { env: { ...process.env, CLAUDE_CONFIG_DIR: claude, CLAUDE_RECEIPT_HOME: receiptHome }, encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    }, PROCESS_RUNS)]);
    for (const [label, s] of rows) console.log(`${label.padEnd(40)} ${fmt(s)}`);
    const per = rows.find(([l]) => l.startsWith("listArchive"))![1].median / N;
    const mem = process.memoryUsage();
    console.log(`listArchive per entry: ${per.toFixed(2)} ms | this process: rss ${(mem.rss / 1048576).toFixed(0)} MB, heap ${(mem.heapUsed / 1048576).toFixed(0)} MB`);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

const sizes = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
console.log(`claude-receipt archive benchmark | node ${process.version} | ${process.platform} | median of ${RUNS} runs (${PROCESS_RUNS} for the CLI process); timings depend on the machine`);
for (const N of sizes.length ? sizes : [1000, 5000]) await bench(N);
