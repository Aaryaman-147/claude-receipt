// v0.2 milestone 3: `claude-receipt all | week | month` (terminal and --json), on throwaway Claude
// homes built from anonymized fixtures. Never touches ~/.claude or ~/.claude-receipt.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { HistoryReceipt } from "../../src/aggregate/types.ts";
import { validateHistory } from "../../src/aggregate/validate.ts";
import { buildReceipt } from "../../src/analytics/index.ts";
import { fingerprintOf, writeReceipt } from "../../src/archive/index.ts";
import { run } from "../../src/cli/run.ts";
import { redactHistory } from "../../src/receipt/redact.ts";
import { loadSessions, refForFile } from "../../src/source/claude-code/index.ts";

const FIX = join("fixtures", "claude-code", "2.1.283");
const NOW = new Date("2026-10-01T12:00:00.000Z"); // fixtures were recorded on 2026-09-28 (UTC)
const FIXTURE_CWD = "C:\\fixture\\project";
const raw = (name: string) => readFileSync(join(FIX, name), "utf8");
const withCwd = (text: string, cwd: string) => text.split(JSON.stringify(FIXTURE_CWD).slice(1, -1)).join(JSON.stringify(cwd).slice(1, -1));

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });
interface Home { claude: string; archive: string; receiptHome: string; env: NodeJS.ProcessEnv; project(dir: string): string }
function home(): Home {
  const root = mkdtempSync(join(tmpdir(), "claude-receipt-history-"));
  made.push(root);
  const claude = join(root, "claude"), receiptHome = join(root, "receipt");
  mkdirSync(join(claude, "projects"), { recursive: true });
  return {
    claude, receiptHome, archive: join(receiptHome, "archive"),
    env: { CLAUDE_CONFIG_DIR: claude, CLAUDE_RECEIPT_HOME: receiptHome },
    project(dir) { const p = join(claude, "projects", dir); mkdirSync(p, { recursive: true }); return p; },
  };
}
const put = (h: Home, dir: string, id: string, text: string) => { const f = join(h.project(dir), `${id}.jsonl`); writeFileSync(f, text); return f; };
const markLive = (h: Home, id: string) => { mkdirSync(join(h.claude, "sessions"), { recursive: true }); writeFileSync(join(h.claude, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: id })); };
async function cli(h: Home, argv: string[], o: { cwd?: string; now?: Date; timeZone?: string } = {}) {
  let out = "", err = "";
  const code = await run(argv, { stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, cwd: o.cwd ?? "C:\\somewhere\\else", env: h.env, isTTY: false, timeZone: o.timeZone ?? "UTC", now: o.now ?? NOW });
  return { code, out, err };
}
const json = async (h: Home, argv: string[], o: Parameters<typeof cli>[2] = {}) => {
  const r = await cli(h, [...argv, "--json"], o);
  assert.equal(r.code, 0, r.err);
  const parsed = JSON.parse(r.out) as HistoryReceipt;
  assert.deepEqual(validateHistory(parsed), [], "valid HistoryReceipt contract");
  return parsed;
};
const A = "aaaa1111-0000-4000-8000-000000000001", B = "bbbb2222-0000-4000-8000-000000000002", C = "cccc3333-0000-4000-8000-000000000003", D = "dddd4444-0000-4000-8000-000000000004";
// Two projects: alpha (ordinary + killed) and beta (no-tools).
function twoProjects() {
  const h = home();
  put(h, "p-alpha", A, withCwd(raw("ordinary.jsonl"), "C:\\work\\alpha"));
  put(h, "p-alpha", B, withCwd(raw("killed.jsonl"), "C:\\work\\alpha"));
  put(h, "p-beta", C, withCwd(raw("no-tools.jsonl"), "C:\\work\\beta"));
  return h;
}

test("all, week and month render the itemized history; v0.1 commands are unchanged", async () => {
  const h = twoProjects();
  for (const [cmd, label] of [["all", "ALL SESSIONS"], ["week", "LAST 7 DAYS"], ["month", "LAST 30 DAYS"]] as const) {
    const r = await cli(h, [cmd]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /C L A U D E {3}R E C E I P T\n +itemized history\n/);
    assert.match(r.out, new RegExp(`PERIOD \\.+ ${label}\\n`));
    assert.match(r.out, /SESSIONS \.+ 3\n/);
    assert.match(r.out, /PROJECTS \.+ 2\n/);
    assert.match(r.out, /-- HARD STATS -+\n/);
    assert.match(r.out, /API EQUIVALENT \.+ \$\d+\.\d\d( \*)?\n/);
    assert.ok(!/LIVE/.test(r.out), "no LIVE band on a history");
    assert.match(r.err, /claude-receipt: 3 finished sessions/);
  }
  const session = await cli(h, ["last"]);
  assert.match(session.out, /itemized session record/);
  assert.ok(!session.out.includes("itemized history"));
});

test("periods: last 7 / 30 local calendar days including today, by startedAt, in the viewer's zone", async () => {
  const h = twoProjects(); // all three started 2026-09-28 ~09:5x UTC
  const sessions = async (cmd: string, now: string, timeZone = "UTC") => {
    const r = await cli(h, [cmd, "--json"], { now: new Date(now), timeZone });
    return r.code === 0 ? (JSON.parse(r.out) as HistoryReceipt).coverage.sessions : 0;
  };
  assert.equal(await sessions("week", "2026-10-04T23:59:00.000Z"), 3, "09-28 is the first of the 7 days ending 10-04");
  assert.equal(await sessions("week", "2026-10-05T00:00:00.000Z"), 0, "a day later it is out");
  assert.equal(await sessions("month", "2026-10-27T12:00:00.000Z"), 3);
  assert.equal(await sessions("month", "2026-10-28T12:00:00.000Z"), 0);
  // 2026-10-05 00:30 UTC is still 10-04 in New York: the session is in that viewer's week
  assert.equal(await sessions("week", "2026-10-05T00:30:00.000Z", "America/New_York"), 3);
  const none = await cli(h, ["week"], { now: new Date("2026-11-30T12:00:00.000Z") });
  assert.deepEqual([none.code, none.out], [1, ""]);
  assert.match(none.err, /no finished sessions in the last 7 days/);
  assert.equal(await sessions("all", "2030-01-01T00:00:00.000Z"), 3, "all has no window");
});

test("--project: the current directory's project key (case-insensitive on Windows), never a name", async () => {
  const h = twoProjects();
  const alpha = await json(h, ["all", "--project"], { cwd: "C:\\WORK\\Alpha\\" });
  assert.equal(alpha.coverage.sessions, 2);
  assert.equal(alpha.scope.projectKey, "c:\\work\\alpha");
  assert.equal(alpha.scope.projectFilter, true);
  const t = await cli(h, ["all", "--project"], { cwd: "C:\\work\\alpha" });
  assert.match(t.out, /PROJECT \.+ alpha\n/);
  assert.ok(!/PROJECTS \.+/.test(t.out), "no project count on a one-project history");
  assert.match(t.err, /for this directory's project/);
  const elsewhere = await cli(h, ["all", "--project"], { cwd: "C:\\work\\gamma" });
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.err, /no finished sessions for this directory's project/);
  // a directory merely named like a project doesn't match
  assert.equal((await cli(h, ["all", "--project"], { cwd: "C:\\elsewhere\\alpha" })).code, 1);
});

test("live sessions are never aggregated and show as excluded; incomplete ones count and show", async () => {
  const h = twoProjects();
  put(h, "p-alpha", D, withCwd(raw("write-update-replaceall.jsonl"), "C:\\work\\alpha"));
  markLive(h, D);
  const all = await json(h, ["all"]);
  assert.equal(all.coverage.sessions, 3);
  assert.equal(all.coverage.liveExcluded, 1);
  assert.equal(all.coverage.incomplete, 1, "killed.jsonl ended without a clean close: counted, flagged");
  const t = await cli(h, ["all"]);
  assert.match(t.out, /LIVE \(NOT COUNTED\) \.+ 1\n/);
  assert.match(t.out, /INCOMPLETE \.+ 1\n/);
  // only a live session: nothing to aggregate
  const lone = home();
  put(lone, "p", A, raw("killed.jsonl"));
  markLive(lone, A);
  const r = await cli(lone, ["all"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no finished sessions \(1 still running\)/);
});

test("undated sessions count in all only, and stay visible in week/month coverage", async () => {
  const h = twoProjects();
  const s = (await loadSessions([refForFile(join(FIX, "no-tools.jsonl"))]))[0]!;
  const r = buildReceipt(s, { now: NOW, timeZone: "UTC" });
  const undated = { ...r, session: { ...r.session, id: D, title: null, startedAt: null, endedAt: null } };
  assert.equal(writeReceipt(undated, fingerprintOf(s), { dir: h.archive }).status, "created"); // archive-only: no transcript
  const all = await json(h, ["all"]);
  assert.deepEqual([all.coverage.sessions, all.coverage.undated], [4, 1]);
  const week = await json(h, ["week"]);
  assert.deepEqual([week.coverage.sessions, week.coverage.undated], [3, 1]);
  assert.match((await cli(h, ["all"])).out, /UNDATED \.+ 1\n/);
  assert.match((await cli(h, ["week"])).out, /UNDATED \(NOT COUNTED\) \.+ 1\n/);
});

test("archive + fresh candidates: a session is counted once; --no-archive still discovers and aggregates", async () => {
  const h = twoProjects();
  const ro = await json(h, ["all", "--no-archive"]);
  assert.equal(ro.coverage.sessions, 3);
  assert.ok(!existsSync(h.receiptHome), "--no-archive wrote nothing");
  assert.match((await cli(h, ["all", "--no-archive"])).err, /nothing archived \(--no-archive\)/);
  const first = await json(h, ["all"]);
  assert.equal(first.coverage.sessions, 3);
  assert.equal(readdirSync(h.archive).filter((f) => f.endsWith(".json")).length, 3);
  // now every session is both archived and on disk; then one grows (re-parsed, fresh) while archived
  assert.equal((await json(h, ["all"])).coverage.sessions, 3);
  appendFileSync(join(h.claude, "projects", "p-beta", `${C}.jsonl`), "\n");
  const again = await json(h, ["all"]);
  assert.equal(again.coverage.sessions, 3, "archived + fresh copy of one session counts once");
  assert.ok(!again.warnings.some((w) => w.code === "duplicate-session"));
  // a transcript that disappeared still counts from the archive
  rmSync(join(h.claude, "projects", "p-alpha", `${A}.jsonl`));
  assert.equal((await json(h, ["all"])).coverage.sessions, 3);
});

test("archive write failure: reported on stderr, the history still aggregates the whole candidate pool", async () => {
  const h = twoProjects();
  mkdirSync(h.receiptHome, { recursive: true });
  writeFileSync(h.archive, "a file where the archive directory should be");
  const r = await cli(h, ["all", "--json"]);
  assert.equal(r.code, 0);
  assert.match(r.err, /archive not (writable|readable)/);
  const x = JSON.parse(r.out) as HistoryReceipt;
  assert.deepEqual(validateHistory(x), []);
  assert.equal(x.coverage.sessions, 3);
  assert.equal(readFileSync(h.archive, "utf8"), "a file where the archive directory should be", "nothing half-written");
});

test("--json: the validated HistoryReceipt contract, no presentation, provenance/null/sensitivity preserved", async () => {
  const h = twoProjects();
  const r = await cli(h, ["all", "--json"]);
  assert.ok(r.out.endsWith("}\n") && !/\x1b\[|\.{3}|C L A U D E|itemized|LEGEND|plain {4}recorded/.test(r.out), "no terminal formatting");
  const x = JSON.parse(r.out) as HistoryReceipt;
  assert.deepEqual(validateHistory(x), []);
  assert.deepEqual([x.kind, x.schemaVersion, x.scope.period, x.context.timeZone], ["history", 1, "all", "UTC"]);
  const ms = Object.values(x.sections).flat();
  assert.ok(ms.every((m) => ["exact", "derived", "heuristic"].includes(m.provenance)));
  assert.ok(ms.filter((m) => m.value === null).every((m) => typeof m.unavailableReason === "string"));
  assert.ok(ms.find((m) => m.id === "agg.toolCalls.byName")!.sensitive && ms.find((m) => m.id === "agg.topProjects")!.sensitive);
  assert.equal(ms.find((m) => m.id === "agg.duration.active")!.provenance, "heuristic");
  assert.ok(!/"(label|text|x|y|width|rows|footnotes|bold)"\s*:/.test(r.out), "no view fields");
});

test("partial coverage: metrics based on fewer than all sessions say so; missing is never zero", async () => {
  const h = twoProjects();
  const x = await json(h, ["all"]);
  const tokens = Object.values(x.sections).flat().find((m) => m.id === "agg.tokens.input")!;
  const t = await cli(h, ["all"]);
  if (tokens.covered.sessions < tokens.covered.of) assert.match(t.out.replace(/\n/g, " "), new RegExp(`based on ${tokens.covered.sessions} of ${tokens.covered.of} sessions: [^]*TOKENS IN`));
  for (const m of Object.values(x.sections).flat().filter((m) => m.value === null)) assert.ok(!new RegExp(`\\b${m.id}\\b`).test(t.out));
  assert.ok(Object.values(x.sections).flat().some((m) => m.covered.sessions < m.covered.of), "fixtures include partial metrics");
  assert.match(t.out, /\d+ metrics? unavailable, not shown/);
});

test("--redact: no project names or paths, MCP tools grouped, still a valid contract (terminal and JSON)", async () => {
  const h = twoProjects();
  const red = await json(h, ["all", "--project", "--redact"], { cwd: "C:\\work\\alpha" });
  assert.equal(red.scope.projectKey, null);
  assert.equal(red.scope.projectFilter, true);
  const top = Object.values(red.sections).flat().find((m) => m.id === "agg.topProjects")!;
  assert.deepEqual([top.value, top.unavailableReason], [null, "hidden by redaction"]);
  const text = JSON.stringify(red);
  assert.ok(!/alpha|beta|work|C:\\\\/.test(text), "no project name or path");
  for (const argv of [["all", "--redact"], ["week", "--redact"], ["all", "--project", "--redact"]]) {
    const t = await cli(h, argv, { cwd: "C:\\work\\alpha" });
    assert.equal(t.code, 0);
    assert.ok(!/alpha|beta|work/.test(t.out), `${argv.join(" ")}: names or paths in terminal output`);
  }
  assert.match((await cli(h, ["all", "--project", "--redact"], { cwd: "C:\\work\\alpha" })).out, /PROJECT \.+ ONE PROJECT \(HIDDEN\)\n/);
  // MCP grouping is structural, on the value, before serialization
  const unred = await json(h, ["all"]);
  const withMcp = { ...unred, sections: { ...unred.sections, hard: unred.sections.hard.map((m) => (m.id === "agg.toolCalls.byName" ? { ...m, value: { mcp__srv__a: 2, mcp__other__b: 1, Bash: 2 } } : m)) } } as HistoryReceipt;
  const g = redactHistory(withMcp).sections.hard.find((m) => m.id === "agg.toolCalls.byName")!;
  assert.deepEqual(g.value, { MCP: 3, Bash: 2 });
  assert.deepEqual(validateHistory(redactHistory(withMcp)), []);
});

test("mixed recorded time zones: the aggregate is kept and the warning is surfaced", async () => {
  const h = home();
  put(h, "p", A, raw("ordinary.jsonl"));
  assert.equal((await cli(h, ["last"], { timeZone: "UTC" })).code, 0); // archived with UTC receipts
  put(h, "q", C, withCwd(raw("no-tools.jsonl"), "C:\\work\\beta"));
  const x = await json(h, ["all"], { timeZone: "Asia/Kolkata" });
  assert.deepEqual(x.coverage.timeZones, ["Asia/Kolkata", "UTC"]);
  assert.ok(x.warnings.some((w) => w.code === "mixed-time-zones"));
  const peak = Object.values(x.sections).flat().find((m) => m.id === "agg.peakHour")!;
  if (peak.value !== null) assert.match((await cli(h, ["all"], { timeZone: "Asia/Kolkata" })).out.replace(/\n/g, " "), /PEAK HOUR uses each session's recorded time zone/);
});

test("no sessions and usage errors", async () => {
  const empty = home();
  for (const cmd of ["all", "week", "month"]) {
    const r = await cli(empty, [cmd]);
    assert.deepEqual([r.code, r.out], [1, ""]);
    assert.match(r.err, /no finished sessions/);
  }
  const h = twoProjects();
  for (const argv of [["--project"], ["last", "--project"], ["list", "--project"], ["all", "week"], ["all", "--limit", "3"], ["week", "x"], ["month", "--png"]]) {
    const r = await cli(h, argv);
    assert.deepEqual([r.code, r.out], [2, ""], argv.join(" "));
    assert.match(r.err, /usage: claude-receipt/);
  }
  assert.match((await cli(h, ["--help"])).out, /all {12}history: every finished session/);
});

test("privacy: history terminal and JSON output, redacted or not, hold no transcript text, telemetry ids, session ids or titles", async () => {
  const h = home();
  const names = readdirSync(FIX).filter((f) => f.endsWith(".jsonl"));
  const ids = names.map((_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`);
  names.forEach((n, i) => put(h, `p${i % 3}`, ids[i]!, raw(n)));
  const telemetry = new Set(names.flatMap((n) => raw(n).match(/(?:msg|toolu|req)_fixture[0-9a-f]{12}|\ba[0-9a-f]{12}\b/g) ?? []));
  assert.ok(telemetry.size > 10);
  const outputs: string[] = [];
  for (const cmd of ["all", "week", "month"]) for (const extra of [[], ["--redact"], ["--json"], ["--json", "--redact"], ["--project"], ["--project", "--json"]]) {
    const r = await cli(h, [cmd, ...extra], { cwd: FIXTURE_CWD });
    assert.ok(r.code === 0 || r.code === 1, r.err);
    outputs.push(r.out + r.err);
  }
  const text = outputs.join("\n");
  for (const t of telemetry) assert.ok(!text.includes(t), `telemetry id ${t}`);
  for (const id of ids) assert.ok(!text.includes(id), `session id ${id}`);
  assert.ok(!/x{3,}/.test(text), "placeholder transcript text");
  assert.ok(!/<(command|local-command|bash|task-notification|system-reminder)/.test(text));
  assert.ok(!/"(content|text|thinking|command|stdout|stderr|patch|message|prompt|description|uuid|requestId|agentId|title|cwd)"\s*:/.test(text));
});

// ---- export all | week | month (v0.2 milestone 4) ----

const outDir = () => { const d = mkdtempSync(join(tmpdir(), "claude-receipt-history-export-")); made.push(d); return d; };
const pngInfo = (b: Buffer) => { const t: string[] = []; for (let o = 8; o < b.length; o += 12 + b.readUInt32BE(o)) t.push(b.toString("latin1", o + 4, o + 8)); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), chunks: [...new Set(t)].sort() }; };
const drawn = (svg: string) => svg.replace(/@font-face\{[^}]*\}/g, "");

test("export all|week|month: a history image (PNG default, --svg), named by period, redacted by default", async () => {
  const h = twoProjects();
  for (const [cmd, label] of [["all", "ALL SESSIONS"], ["week", "LAST 7 DAYS"], ["month", "LAST 30 DAYS"]] as const) {
    const dir = outDir();
    const svg = await cli(h, ["export", cmd, "--svg"], { cwd: dir });
    assert.equal(svg.code, 0, svg.err);
    assert.equal(svg.out, `${join(dir, `claude-receipt-${cmd}.svg`)}\n`);
    assert.match(svg.err, /history exported: 3 finished sessions/);
    const text = drawn(readFileSync(join(dir, `claude-receipt-${cmd}.svg`), "utf8"));
    assert.ok(text.includes(">itemized history</text>") && text.includes(`>${label}</text>`));
    assert.ok(!/alpha|beta|work/.test(text), "redacted by default: no project names or paths");
    const png = await cli(h, ["export", cmd], { cwd: dir });
    assert.equal(png.code, 0, png.err);
    const info = pngInfo(readFileSync(join(dir, `claude-receipt-${cmd}.png`)));
    const height = Number(text.match(/height="(\d+)"/)![1]);
    assert.deepEqual([info.w, info.h, info.chunks], [1248, height * 2, ["IDAT", "IEND", "IHDR"]]);
  }
});

test("export history: --no-redact shows project names; --project with --redact shows no key, path or name; never overwrites", async () => {
  const h = twoProjects();
  const dir = outDir();
  const raw2 = await cli(h, ["export", "all", "--svg", "--no-redact"], { cwd: dir });
  assert.equal(raw2.code, 0, raw2.err);
  assert.match(raw2.err, /history exported without redaction/);
  assert.ok(drawn(readFileSync(join(dir, "claude-receipt-all.svg"), "utf8")).includes(">alpha</text>"), "top projects shown when not redacted");
  // project-filtered (cwd = the project, a path that is never written to: --output goes to a temp dir)
  const pd = outDir();
  const proj = await cli(h, ["export", "week", "--project", "--svg", "-o", join(pd, "x.svg")], { cwd: "C:\\work\\alpha" });
  assert.equal(proj.code, 0, proj.err);
  const ptext = drawn(readFileSync(join(pd, "x.svg"), "utf8"));
  assert.ok(ptext.includes(">ONE PROJECT (HIDDEN)</text>") && !/alpha|beta|work/.test(ptext), "project-filtered and redacted: no key, path or name");
  // repeated exports get -2, -3; an existing --output is refused untouched
  const rep = outDir();
  for (let i = 0; i < 3; i++) assert.equal((await cli(h, ["export", "all", "--svg"], { cwd: rep })).code, 0);
  assert.deepEqual(readdirSync(rep).sort(), ["claude-receipt-all-2.svg", "claude-receipt-all-3.svg", "claude-receipt-all.svg"]);
  assert.equal(readFileSync(join(rep, "claude-receipt-all.svg"), "utf8"), readFileSync(join(rep, "claude-receipt-all-2.svg"), "utf8"), "deterministic");
  writeFileSync(join(rep, "keep.png"), "precious");
  const refused = await cli(h, ["export", "week", "-o", "keep.png"], { cwd: rep });
  assert.deepEqual([refused.code, refused.out], [1, ""]);
  assert.match(refused.err, /keep\.png already exists; not overwritten/);
  assert.equal(readFileSync(join(rep, "keep.png"), "utf8"), "precious");
});

test("export history: the -project default name, --no-archive, no sessions, usage errors; session export unchanged", async () => {
  const h = twoProjects();
  // a project-filtered export from inside a real directory that is the project's cwd
  const projDir = outDir();
  const ph = home();
  put(ph, "p", A, withCwd(raw("ordinary.jsonl"), projDir));
  const pe = await cli(ph, ["export", "all", "--project", "--svg"], { cwd: projDir });
  assert.equal(pe.code, 0, pe.err);
  assert.equal(pe.out, `${join(projDir, "claude-receipt-all-project.svg")}\n`);
  assert.ok(!drawn(readFileSync(join(projDir, "claude-receipt-all-project.svg"), "utf8")).includes(projDir.split(/[\\/]/).pop()!), "no directory name in the redacted image");
  // --no-archive: exports without writing the archive
  const ro = outDir();
  const r = await cli(h, ["export", "all", "--svg", "--no-archive"], { cwd: ro });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /nothing archived \(--no-archive\)/);
  assert.ok(!existsSync(h.receiptHome));
  // nothing in the period: exit 1, no file
  const none = outDir();
  const empty = await cli(h, ["export", "week"], { cwd: none, now: new Date("2027-01-01T00:00:00.000Z") });
  assert.deepEqual([empty.code, empty.out], [1, ""]);
  assert.match(empty.err, /no finished sessions in the last 7 days/);
  assert.deepEqual(readdirSync(none), []);
  for (const argv of [["export", "all", "--json"], ["export", "all", "week"], ["export", "week", "--redact", "--no-redact"], ["export", "last", "--project"]]) {
    const u = await cli(h, argv, { cwd: none });
    assert.deepEqual([u.code, u.out], [2, ""], argv.join(" "));
  }
  // session export is unchanged: a prefix, the 4-character redacted name
  const s = outDir();
  const se = await cli(h, ["export", "aaaa", "--svg"], { cwd: s });
  assert.equal(se.out, `${join(s, "claude-receipt-aaaa.svg")}\n`);
  assert.ok(drawn(readFileSync(join(s, "claude-receipt-aaaa.svg"), "utf8")).includes(">itemized session record</text>"));
});

test("privacy: exported history SVG/PNG files, redacted or not, hold no transcript text, telemetry or session ids", async () => {
  const h = home();
  const names = readdirSync(FIX).filter((f) => f.endsWith(".jsonl"));
  const ids = names.map((_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`);
  names.forEach((n, i) => put(h, `p${i % 3}`, ids[i]!, withCwd(raw(n), `C:\\Users\\someone\\secret-${i % 3}`)));
  const telemetry = new Set(names.flatMap((n) => raw(n).match(/(?:msg|toolu|req)_fixture[0-9a-f]{12}|\ba[0-9a-f]{12}\b/g) ?? []));
  const dir = outDir();
  for (const cmd of ["all", "week", "month"]) for (const flags of [["--svg"], ["--svg", "--no-redact"], ["--png"], ["--png", "--no-redact"]]) {
    const r = await cli(h, ["export", cmd, ...flags, "-o", `${cmd}${flags.join("")}.${flags[0]!.slice(2)}`], { cwd: dir });
    assert.equal(r.code, 0, r.err);
  }
  for (const f of readdirSync(dir)) {
    const buf = readFileSync(join(dir, f));
    if (f.endsWith(".png")) { assert.deepEqual(pngInfo(buf).chunks, ["IDAT", "IEND", "IHDR"], f); continue; }
    const svg = drawn(buf.toString("utf8"));
    for (const t of telemetry) assert.ok(!svg.includes(t), `${f}: telemetry id`);
    for (const id of ids) assert.ok(!svg.includes(id), `${f}: session id`);
    assert.ok(!/x{3,}|someone|Users|<!--|<title|<desc|<metadata|data-/.test(svg), `${f}: transcript text, path or metadata`);
    if (!f.includes("no-redact")) assert.ok(!/secret-\d/.test(svg), `${f}: redacted export shows a project name`);
  }
});
