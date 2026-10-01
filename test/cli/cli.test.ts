// M3: the claude-receipt command and its archive sweep, run against throwaway Claude homes built
// from anonymized fixtures. Never touches ~/.claude or ~/.claude-receipt.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildReceipt } from "../../src/analytics/index.ts";
import { archiveKey, fingerprintOf, listArchive, writeReceipt } from "../../src/archive/index.ts";
import { run } from "../../src/cli/run.ts";
import { sweep } from "../../src/cli/sweep.ts";
import type { Receipt } from "../../src/receipt/types.ts";
import { validateReceipt } from "../../src/receipt/validate.ts";
import { loadSessions, refForFile } from "../../src/source/claude-code/index.ts";

const FIX = join("fixtures", "claude-code", "2.1.283");
const NOW = new Date("2026-10-01T00:00:00.000Z");
const FIXTURE_CWD = "C:\\fixture\\project";
const raw = (name: string) => readFileSync(join(FIX, name), "utf8");
// fixture JSONL stores the cwd with escaped backslashes
const withCwd = (text: string, cwd: string) => text.split(JSON.stringify(FIXTURE_CWD).slice(1, -1)).join(JSON.stringify(cwd).slice(1, -1));

// every temp dir this file makes is removed when the file finishes, pass or fail
const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

interface Home { claude: string; receiptHome: string; archive: string; env: NodeJS.ProcessEnv; project(dir: string): string }
function home(): Home {
  const root = mkdtempSync(join(tmpdir(), "claude-receipt-cli-"));
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
async function cli(h: Home, argv: string[], cwd = "C:\\somewhere\\else") {
  let out = "", err = "";
  const code = await run(argv, { stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, cwd, env: h.env, isTTY: false, timeZone: "UTC", now: NOW });
  return { code, out, err };
}
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const snapshot = (dir: string) => files(dir).map((f) => `${f}:${readFileSync(join(dir, f), "utf8")}`).join("\n");

const A = "aaaa1111-0000-4000-8000-000000000001", B = "bbbb2222-0000-4000-8000-000000000002", C = "cccc3333-0000-4000-8000-000000000003";

// ---- default command, last, prefix ----

test("default: the most recent session for the current directory, else the most recent anywhere", async () => {
  const h = home();
  put(h, "p-here", A, raw("ordinary.jsonl")); // 09:52, cwd = fixture project
  put(h, "p-other", B, withCwd(raw("write-update-replaceall.jsonl"), "C:\\work\\other")); // later, other project
  const inside = await cli(h, [], FIXTURE_CWD);
  assert.equal(inside.code, 0);
  assert.match(inside.out, /SESSION \.+ aaaa1111/, "this directory's session, although another is newer");
  const outside = await cli(h, [], "C:\\unrelated");
  assert.match(outside.out, /SESSION \.+ bbbb2222/, "falls back to the most recent anywhere");
});

test("default may show a live session (marked, not archived); last never does", async () => {
  const h = home();
  put(h, "p", A, raw("ordinary.jsonl"));
  put(h, "p", B, raw("killed.jsonl")); // newest, still "running"
  markLive(h, B);
  const r = await cli(h, [], FIXTURE_CWD);
  assert.match(r.out, /SESSION \.+ bbbb2222/);
  assert.match(r.out, /STATUS \.+ LIVE/);
  assert.match(r.out, /\[ LIVE SESSION: STILL RUNNING \]/);
  assert.match(r.err, /bbbb2222 not archived: the session is still running/);
  assert.ok(!existsSync(join(h.archive, `${archiveKey(B)}.json`)), "live sessions are not archived");
  assert.ok(existsSync(join(h.archive, `${archiveKey(A)}.json`)), "finished ones are");
  const last = await cli(h, ["last"]);
  assert.match(last.out, /SESSION \.+ aaaa1111/);
});

test("last: most recent completed session anywhere, by recorded timestamps; incomplete ones are skipped", async () => {
  const h = home();
  put(h, "p1", A, raw("ordinary.jsonl")); // complete, 09:52
  put(h, "p2", B, withCwd(raw("no-tools.jsonl"), "D:\\other")); // complete, later
  put(h, "p3", C, raw("killed.jsonl")); // incomplete, latest
  const r = await cli(h, ["last"]);
  assert.equal(r.code, 0);
  const expected = (await loadSessions([refForFile(join(FIX, "no-tools.jsonl"))]))[0]!.endedAt! > (await loadSessions([refForFile(join(FIX, "ordinary.jsonl"))]))[0]!.endedAt! ? "bbbb2222" : "aaaa1111";
  assert.match(r.out, new RegExp(`SESSION \\.+ ${expected}`));
  assert.ok(!r.out.includes("cccc3333"));
});

test("resumed session: last shows every run, and the archive entry is updated in place", async () => {
  const h = home();
  put(h, "p", A, raw("ordinary.jsonl"));
  await cli(h, ["last"]);
  const first = files(h.archive);
  put(h, "p", A, raw("resumed.jsonl")); // two more runs appended to the same session
  const r = await cli(h, ["last"]);
  assert.match(r.err, /aaaa1111 updated in the local archive/);
  assert.deepEqual(files(h.archive), first, "same single entry");
  // every run is in the receipt (the runs count is data, no longer a printed row since v0.2.1)
  const runs = (JSON.parse((await cli(h, ["last", "--json"])).out) as Receipt).sections.hard.find((m) => m.id === "session.runs")!;
  assert.deepEqual([runs.value, runs.provenance], [3, "derived"]);
  assert.ok(!/RUNS \.+/.test(r.out));
});

test("session id prefix: unique match renders; ambiguous or unknown prefixes fail clearly", async () => {
  const h = home();
  put(h, "p", A, raw("ordinary.jsonl"));
  put(h, "p", "aaaa9999-0000-4000-8000-000000000009", raw("no-tools.jsonl"));
  assert.match((await cli(h, ["aaaa1"])).out, /SESSION \.+ aaaa1111/);
  const amb = await cli(h, ["aaaa"]);
  assert.deepEqual([amb.code, amb.out], [1, ""]);
  assert.match(amb.err, /"aaaa" matches 2 sessions/);
  const none = await cli(h, ["ffff"]);
  assert.deepEqual([none.code, /no session matches "ffff"/.test(none.err)], [1, true]);
});

// ---- list ----

test("list: newest first, compact columns, --limit, and no private telemetry", async () => {
  const h = home();
  put(h, "p1", A, raw("ordinary.jsonl"));
  put(h, "p2", B, withCwd(raw("write-update-replaceall.jsonl"), "C:\\work\\beta"));
  put(h, "p3", C, raw("killed.jsonl"));
  const r = await cli(h, ["list"]);
  assert.equal(r.code, 0);
  const rows = r.out.split("\n").filter((l) => /^\d{4}-/.test(l));
  assert.equal(rows.length, 3);
  const whens = rows.map((l) => l.slice(0, 16));
  assert.deepEqual(whens, [...whens].sort().reverse(), "newest first");
  assert.match(r.out, /^WHEN +SESSION +PROJECT +DURATION +STATE/);
  assert.match(r.out, /\* computed from recorded data/, "the computed duration is marked and explained");
  assert.ok(rows.some((l) => /beta/.test(l)) && rows.some((l) => /incomplete/.test(l)));
  assert.equal((await cli(h, ["list", "--limit", "1"])).out.split("\n").filter((l) => /^\d{4}-/.test(l)).length, 1);
  assert.ok(!/xxx|toolu_|msg_|req_/.test(r.out));
});

test("list --json: semantic rows with duration provenance; --redact hides projects and shortens ids", async () => {
  const h = home();
  put(h, "p", A, raw("ordinary.jsonl"));
  const rows = JSON.parse((await cli(h, ["list", "--json"])).out);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["archived", "complete", "duration", "endedAt", "entrypoint", "id", "live", "project", "projectKey", "startedAt", "transcript"]);
  assert.deepEqual([rows[0].id, rows[0].duration.provenance, rows[0].archived], [A, "derived", true]);
  const red = JSON.parse((await cli(h, ["list", "--json", "--redact"])).out);
  assert.deepEqual([red[0].id, red[0].project, red[0].projectKey], ["aaaa", null, null]);
});

// ---- --json ----

test("--json prints the Receipt contract (not the archive format), valid, provenance intact, no ANSI", async () => {
  const h = home();
  put(h, "p", A, raw("ordinary.jsonl"));
  const r = await cli(h, ["--json", "aaaa"]);
  const receipt = JSON.parse(r.out) as Receipt;
  assert.deepEqual(validateReceipt(receipt), []);
  assert.ok(!("archiveSchemaVersion" in receipt) && !("contentHash" in receipt));
  assert.ok(!/\x1b/.test(r.out));
  const direct = buildReceipt((await loadSessions([refForFile(join(h.claude, "projects", "p", `${A}.jsonl`))]))[0]!, { timeZone: "UTC", now: NOW });
  const prov = (x: Receipt) => Object.values(x.sections).flat().map((m) => [m.id, m.provenance, m.value]);
  assert.deepEqual(prov(receipt), prov(direct), "same values and provenance as analytics");
  const red = JSON.parse((await cli(h, ["--json", "--redact", "aaaa"])).out) as Receipt;
  assert.deepEqual(validateReceipt(red), []);
  assert.deepEqual([red.session.id, red.session.project, red.session.cwd], ["aaaa", null, null]);
});

// ---- errors ----

test("no sessions: a clear message, exit 1; list is empty but succeeds; nothing is created", async () => {
  const h = home();
  const r = await cli(h, []);
  assert.deepEqual([r.code, r.out], [1, ""]);
  assert.match(r.err, /no Claude Code sessions found/);
  assert.equal((await cli(h, ["last"])).code, 1);
  const l = await cli(h, ["list"]);
  assert.deepEqual([l.code, /no sessions found/.test(l.err)], [0, true]);
  assert.ok(!existsSync(h.receiptHome), "no archive home created for nothing");
});

test("only a live session: shown, but the archive home is not created", async () => {
  const h = home();
  put(h, "p", A, raw("killed.jsonl"));
  markLive(h, A);
  assert.equal((await cli(h, [])).code, 0);
  assert.ok(!existsSync(h.receiptHome));
});

test("usage errors exit 2 with help; --help and --version succeed", async () => {
  const h = home();
  for (const argv of [["--bogus"], ["a", "b"], ["last", "--limit", "3"], ["list", "--limit", "0"]]) {
    const r = await cli(h, argv);
    assert.deepEqual([r.code, r.out], [2, ""], argv.join(" "));
    assert.match(r.err, /usage: claude-receipt/);
  }
  assert.match((await cli(h, ["--help"])).out, /usage: claude-receipt/);
  assert.match((await cli(h, ["--version"])).out, /^claude-receipt \d/);
});

test("malformed transcript: tolerated (bad lines counted), still rendered and archived", async () => {
  const h = home();
  put(h, "p", A, `not json at all\n${raw("ordinary.jsonl")}{"type":\n`);
  const r = await cli(h, ["aaaa"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /SESSION \.+ aaaa1111/);
  assert.equal(listArchive(h.archive).entries.length, 1);
});

test("archive conflict: reported on stderr, the existing entry kept, the fresh receipt still shown", async () => {
  const h = home();
  const f = put(h, "p", A, raw("ordinary.jsonl"));
  const s = (await loadSessions([refForFile(f)]))[0]!;
  const old = buildReceipt(s, { timeZone: "UTC", now: NOW });
  const older = { ...old, generator: { ...old.generator, version: "0.0.0-older" } };
  // an entry from an older generator, for a smaller (earlier) state of the transcript
  writeReceipt(older, { ...fingerprintOf(s), bytes: fingerprintOf(s).bytes - 10 }, { dir: h.archive });
  const before = snapshot(h.archive);
  const r = await cli(h, ["aaaa"]);
  assert.equal(r.code, 0);
  assert.match(r.err, /archive conflict for aaaa1111: generator version differs.*existing entry kept/);
  assert.match(r.err, /archive keeps an earlier version \(conflict\)/);
  assert.equal(snapshot(h.archive), before, "history untouched");
  assert.match(r.out, /SESSION \.+ aaaa1111/);
});

test("same transcript archived by an older generator: skipped by fingerprint, and the note says the archive differs", async () => {
  const h = home();
  const f = put(h, "p", A, raw("ordinary.jsonl"));
  const s = (await loadSessions([refForFile(f)]))[0]!;
  const old = buildReceipt(s, { timeZone: "UTC", now: NOW });
  writeReceipt({ ...old, generator: { ...old.generator, version: "0.0.0-older" } }, fingerprintOf(s), { dir: h.archive });
  const before = snapshot(h.archive);
  const r = await cli(h, ["aaaa"]);
  assert.match(r.err, /aaaa1111 the local archive keeps an earlier version of this receipt/);
  assert.equal(snapshot(h.archive), before, "recomputation is never silent");
});

test("unwritable archive (permission-style failure): reported, rendering still works, nothing half-written", async () => {
  const h = home();
  put(h, "p", A, raw("ordinary.jsonl"));
  mkdirSync(h.receiptHome, { recursive: true });
  writeFileSync(h.archive, "a file where the archive directory should be");
  const r = await cli(h, ["aaaa"]);
  assert.equal(r.code, 0);
  assert.match(r.err, /archive not writable/);
  assert.match(r.out, /SESSION \.+ aaaa1111/);
  assert.equal(readFileSync(h.archive, "utf8"), "a file where the archive directory should be");
});

test("malformed archive entries are reported and left untouched", async () => {
  const h = home();
  put(h, "p", A, raw("ordinary.jsonl"));
  mkdirSync(h.archive, { recursive: true });
  const bad = join(h.archive, `${archiveKey(B)}.json`);
  writeFileSync(bad, "{ torn");
  const r = await cli(h, ["aaaa"]);
  assert.match(r.err, /unreadable archive entry \(malformed\)/);
  assert.equal(readFileSync(bad, "utf8"), "{ torn");
});

test("--no-archive is read-only: nothing written, nothing created", async () => {
  const h = home();
  put(h, "p", A, raw("ordinary.jsonl"));
  const r = await cli(h, ["--no-archive"]);
  assert.equal(r.code, 0);
  assert.match(r.err, /not archived \(--no-archive\)/);
  assert.ok(!existsSync(h.receiptHome));
});

test("a session whose transcript is gone is still available from the archive", async () => {
  const h = home();
  const f = put(h, "p", A, raw("ordinary.jsonl"));
  await cli(h, ["list"]);
  rmSync(f);
  const l = await cli(h, ["list"]);
  assert.match(l.out, /aaaa1111 .* archived/);
  const r = await cli(h, ["aaaa"]);
  assert.match(r.out, /SESSION \.+ aaaa1111/);
  assert.match(r.err, /from the local archive \(the transcript is no longer on disk\)/);
});

// ---- sweep ----

test("sweep: first run archives; a repeat skips unchanged projects without parsing and rewrites nothing", async () => {
  const h = home();
  put(h, "p1", A, raw("ordinary.jsonl"));
  put(h, "p1", B, raw("write-update-replaceall.jsonl"));
  put(h, "p2", C, withCwd(raw("no-tools.jsonl"), "D:\\second"));
  const opts = { claudeHome: h.claude, archiveDir: h.archive, write: true, timeZone: "UTC", now: NOW };
  const one = await sweep(opts);
  assert.deepEqual([one.report.projectsParsed, one.report.projectsSkipped, one.report.results.created], [2, 0, 3]);
  const before = snapshot(h.archive);
  const two = await sweep({ ...opts, now: new Date("2026-10-05T00:00:00.000Z") });
  assert.deepEqual([two.report.projectsParsed, two.report.projectsSkipped, two.report.results.skipped], [0, 2, 3]);
  assert.equal(snapshot(h.archive), before, "byte-identical archive");
  assert.deepEqual([...two.candidates.values()].map((c) => c.origin), ["archive", "archive", "archive"]);
  assert.equal(two.candidates.size, 3);
});

test("sweep: a project with a changed or live session is re-parsed; unchanged siblings are not rewritten", async () => {
  const h = home();
  put(h, "p", A, raw("ordinary.jsonl"));
  put(h, "p", B, raw("no-tools.jsonl"));
  const opts = { claudeHome: h.claude, archiveDir: h.archive, write: true, timeZone: "UTC", now: NOW };
  await sweep(opts);
  put(h, "p", C, raw("killed.jsonl"));
  markLive(h, C);
  const r = await sweep(opts);
  assert.equal(r.report.projectsParsed, 1);
  assert.deepEqual([r.report.results.skipped, r.report.results.rejected], [2, 1]);
  assert.deepEqual(r.report.rejected, [], "live rejections are expected, not reported as problems");
});

test("sweep: an archived session that is resumed (live, nothing new written yet) is re-parsed, not served stale", async () => {
  const h = home();
  put(h, "p", A, raw("ordinary.jsonl"));
  const opts = { claudeHome: h.claude, archiveDir: h.archive, write: true, timeZone: "UTC", now: NOW };
  await sweep(opts);
  markLive(h, A); // same bytes on disk, but Claude Code has it open again
  const r = await sweep(opts);
  assert.equal(r.report.projectsParsed, 1, "a live session is never skipped by fingerprint");
  const c = r.candidates.get(A)!;
  assert.deepEqual([c.origin, c.receipt.session.live, c.archive], ["transcript", true, "rejected"]);
  assert.match((await cli(h, [], FIXTURE_CWD)).out, /STATUS \.+ LIVE/);
});

test("sweep: forks are archived with their parent link; nothing invents a fork that isn't observable", async () => {
  const h = home();
  put(h, "p", A, raw("resumed.jsonl"));
  put(h, "p", B, raw("forked.jsonl"));
  const opts = { claudeHome: h.claude, archiveDir: h.archive, write: true, timeZone: "UTC", now: NOW };
  const r = await sweep(opts);
  assert.equal(r.candidates.get(B)!.receipt.session.forkOf, A);
  assert.equal(r.candidates.get(A)!.receipt.session.forkOf, null);
});

// ---- privacy ----

test("privacy: archive files and every CLI output hold no transcript text, telemetry ids or raw fields", async () => {
  const h = home();
  const names = readdirSync(FIX).filter((f) => f.endsWith(".jsonl"));
  names.forEach((n, i) => put(h, `p${i % 3}`, `${String(i).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`, raw(n)));
  const outputs = [await cli(h, []), await cli(h, ["last"]), await cli(h, ["list"]), await cli(h, ["--json"]), await cli(h, ["list", "--json"]), await cli(h, ["last", "--redact"])];
  const text = [...outputs.map((o) => o.out + o.err), ...files(h.archive).map((f) => readFileSync(join(h.archive, f), "utf8"))].join("\n");
  const ids = new Set(names.flatMap((n) => raw(n).match(/(?:msg|toolu|req)_fixture[0-9a-f]{12}|\ba[0-9a-f]{12}\b/g) ?? []));
  assert.ok(ids.size > 10);
  for (const id of ids) assert.ok(!text.includes(id), `telemetry id leaked: ${id}`);
  assert.ok(!/x{3,}/.test(text), "placeholder transcript text leaked");
  assert.ok(!/<(command|local-command|bash|task-notification)/.test(text));
  assert.ok(!/"(content|text|command|stdout|stderr|patch|message|prompt|description|uuid|requestId|agentId)"\s*:/.test(text));
  for (const f of files(h.archive)) assert.equal(JSON.parse(readFileSync(join(h.archive, f), "utf8")).receipt.session.title, null);
});

// ---- export (visual receipt files) ----

const outDir = () => { const d = mkdtempSync(join(tmpdir(), "claude-receipt-export-")); made.push(d); return d; };
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];
const pngChunks = (b: Buffer) => { const t: string[] = []; for (let o = 8; o < b.length; o += 12 + b.readUInt32BE(o)) t.push(b.toString("latin1", o + 4, o + 8)); return [...new Set(t)]; };
const noFonts = (svg: string) => svg.replace(/@font-face\{[^}]*\}/g, "");

test("export: PNG by default, redacted by default, named by the 4-character id, path on stdout", async () => {
  const h = home(), dir = outDir();
  put(h, "p", A, raw("ordinary.jsonl"));
  const r = await cli(h, ["export"], dir);
  assert.equal(r.code, 0, r.err);
  const file = join(dir, "claude-receipt-aaaa.png");
  assert.equal(r.out, `${file}\n`);
  assert.match(r.err, /aaaa exported; saved to the local archive/);
  assert.ok(!r.err.includes("aaaa1111"), "notes use the redacted id too");
  const png = readFileSync(file);
  const [w, ht] = pngSize(png);
  assert.equal(w, 1248);
  assert.ok(ht! > 2000 && ht! % 2 === 0, "2× of a whole-pixel layout height");
  assert.deepEqual(pngChunks(png).sort(), ["IDAT", "IEND", "IHDR"]);
  assert.deepEqual(files(dir), ["claude-receipt-aaaa.png"]);
});

test("export --svg: the canonical SVG, redacted unless --no-redact", async () => {
  const h = home(), dir = outDir();
  put(h, "p", A, withCwd(raw("ordinary.jsonl"), "C:\\work\\secret-project"));
  const red = await cli(h, ["export", "--svg"], dir);
  assert.equal(red.code, 0, red.err);
  const svg = noFonts(readFileSync(join(dir, "claude-receipt-aaaa.svg"), "utf8"));
  assert.ok(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"624\""));
  for (const s of ["secret-project", "work", "PROJECT", A, "aaaa1111", "file1"]) assert.ok(!svg.includes(s), `redacted export leaks ${s}`);
  assert.ok(svg.includes(">aaaa</text>") && svg.includes(">*.txt</text>"));
  const raw2 = await cli(h, ["export", "--svg", "--no-redact"], dir);
  assert.equal(raw2.code, 0, raw2.err);
  assert.match(raw2.err, /aaaa1111 exported without redaction/);
  const full = noFonts(readFileSync(join(dir, "claude-receipt-aaaa1111.svg"), "utf8"));
  assert.ok(full.includes(">secret-project</text>") && full.includes(">aaaa1111</text>") && full.includes(">file1.txt</text>"));
  assert.ok(!full.includes(A), "never the full session id");
});

test("export selects sessions exactly like the receipt command: default, last, prefix, ambiguous, unknown", async () => {
  const h = home(), dir = outDir();
  put(h, "p", A, raw("ordinary.jsonl"));
  put(h, "p", B, raw("killed.jsonl")); // newest, live
  put(h, "q", "aaaa9999-0000-4000-8000-000000000009", raw("no-tools.jsonl"));
  markLive(h, B);
  const d = await cli(h, ["export", "--svg", "-o", "default.svg"], dir);
  assert.equal(d.code, 0, d.err);
  const recv = await cli(h, [], dir);
  assert.ok(readFileSync(join(dir, "default.svg"), "utf8").includes(`>${recv.out.match(/SESSION \.+ (\w{4})/)![1]}</text>`), "same pick as the receipt command");
  const last = await cli(h, ["export", "last", "--svg", "-o", "last.svg"], dir);
  assert.equal(last.code, 0, last.err);
  assert.ok(!readFileSync(join(dir, "last.svg"), "utf8").includes("LIVE"), "last never picks a live session");
  const pre = await cli(h, ["export", "aaaa1", "--svg", "-o", "pre.svg"], dir);
  assert.equal(pre.code, 0, pre.err);
  assert.ok(readFileSync(join(dir, "pre.svg"), "utf8").includes(">aaaa</text>"));
  const amb = await cli(h, ["export", "aaaa", "-o", "amb.png"], dir);
  assert.deepEqual([amb.code, amb.out], [1, ""]);
  assert.match(amb.err, /"aaaa" matches 2 sessions/);
  const unknown = await cli(h, ["export", "ffff", "-o", "unknown.png"], dir);
  assert.deepEqual([unknown.code, unknown.out], [1, ""]);
  assert.match(unknown.err, /no session matches "ffff"/);
  assert.deepEqual(files(dir), ["default.svg", "last.svg", "pre.svg"]);
});

test("export never overwrites: an explicit existing path fails untouched; repeated default exports get -2, -3", async () => {
  const h = home(), dir = outDir();
  put(h, "p", A, raw("ordinary.jsonl"));
  writeFileSync(join(dir, "keep.png"), "precious");
  const r = await cli(h, ["export", "-o", "keep.png"], dir);
  assert.deepEqual([r.code, r.out], [1, ""]);
  assert.match(r.err, /keep\.png already exists; not overwritten/);
  assert.equal(readFileSync(join(dir, "keep.png"), "utf8"), "precious");
  for (let i = 0; i < 3; i++) assert.equal((await cli(h, ["export", "--svg"], dir)).code, 0);
  assert.deepEqual(files(dir), ["claude-receipt-aaaa-2.svg", "claude-receipt-aaaa-3.svg", "claude-receipt-aaaa.svg", "keep.png"]);
  const [a, b] = ["claude-receipt-aaaa.svg", "claude-receipt-aaaa-2.svg"].map((f) => readFileSync(join(dir, f), "utf8"));
  assert.equal(a, b, "the same receipt exports to the same bytes");
  const p1 = await cli(h, ["export", "-o", "one.png"], dir), p2 = await cli(h, ["export", "-o", "two.png"], dir);
  assert.equal(p1.code + p2.code, 0);
  assert.ok(readFileSync(join(dir, "one.png")).equals(readFileSync(join(dir, "two.png"))), "repeated PNG exports are byte-identical");
  const abs = join(outDir(), "elsewhere.png");
  assert.equal((await cli(h, ["export", "--output", abs], dir)).out, `${abs}\n`, "absolute --output");
});

test("export write failures are reported, exit 1, and leave nothing behind", async () => {
  const h = home(), dir = outDir();
  put(h, "p", A, raw("ordinary.jsonl"));
  const missing = await cli(h, ["export", "-o", join("no", "such", "dir.png")], dir);
  assert.deepEqual([missing.code, missing.out], [1, ""]);
  assert.match(missing.err, /could not write .*dir\.png: ENOENT/);
  mkdirSync(join(dir, "a-directory.png"));
  const isDir = await cli(h, ["export", "-o", "a-directory.png"], dir);
  assert.deepEqual([isDir.code, isDir.out], [1, ""]);
  assert.match(isDir.err, /already exists; not overwritten|could not write/);
  assert.deepEqual(files(dir), ["a-directory.png"]);
  assert.deepEqual(files(join(dir, "a-directory.png")), []);
});

test("export of a live session: a snapshot with the LIVE band; the live session is not archived", async () => {
  const h = home(), dir = outDir();
  put(h, "p", A, raw("killed.jsonl"));
  markLive(h, A);
  const r = await cli(h, ["export", "--svg"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /aaaa exported \(a snapshot: the session is still running\); not archived: the session is still running/);
  const svg = readFileSync(join(dir, "claude-receipt-aaaa.svg"), "utf8");
  assert.ok(svg.includes(">LIVE · STILL RUNNING</text>") && svg.includes(">LIVE</text>"));
  assert.ok(!existsSync(h.receiptHome), "exporting archives nothing new");
  assert.equal((await cli(h, ["export", "last"], dir)).code, 1, "last still needs a completed session");
  assert.deepEqual(files(dir), ["claude-receipt-aaaa.svg"]);
});

test("export with no sessions, and export usage errors", async () => {
  const h = home(), dir = outDir();
  const none = await cli(h, ["export"], dir);
  assert.deepEqual([none.code, none.out], [1, ""]);
  assert.match(none.err, /no Claude Code sessions found/);
  assert.deepEqual(files(dir), []);
  for (const argv of [["--png"], ["last", "--no-redact"], ["-o", "x.png"], ["export", "list"], ["export", "--json"], ["export", "--png", "--svg"], ["export", "--redact", "--no-redact"], ["export", "-o"], ["export", "a", "b"]]) {
    const r = await cli(h, argv, dir);
    assert.deepEqual([r.code, r.out], [2, ""], argv.join(" "));
    assert.match(r.err, /usage: claude-receipt/);
  }
  assert.match((await cli(h, ["--help"])).out, /claude-receipt export \[<session-id-prefix> \| last\] \[--png \| --svg\]/);
  assert.deepEqual(files(dir), []);
});

test("privacy: exported SVG and PNG files, redacted or not, hold no transcript text, telemetry ids or metadata", async () => {
  const h = home(), dir = outDir();
  const names = readdirSync(FIX).filter((f) => f.endsWith(".jsonl"));
  const ids = names.map((_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`);
  names.forEach((n, i) => put(h, `p${i % 3}`, ids[i]!, raw(n)));
  const telemetry = new Set(names.flatMap((n) => raw(n).match(/(?:msg|toolu|req)_fixture[0-9a-f]{12}|\ba[0-9a-f]{12}\b/g) ?? []));
  assert.ok(telemetry.size > 10);
  let exported = 0;
  for (const [i, id] of ids.entries()) {
    for (const flags of [["--svg"], ["--svg", "--no-redact"], ["--png"], ["--png", "--no-redact"]]) {
      const r = await cli(h, ["export", id, ...flags, "-o", `${i}${flags.join("")}.${flags[0]!.slice(2)}`], dir);
      if (r.code === 0) exported++;
      else assert.match(r.err, /no session matches/, r.err); // an empty transcript has no session
    }
  }
  assert.ok(exported >= 40, `${exported} exports`);
  for (const f of files(dir)) {
    const buf = readFileSync(join(dir, f));
    if (f.endsWith(".png")) { assert.deepEqual(pngChunks(buf).sort(), ["IDAT", "IEND", "IHDR"], f); continue; }
    const svg = noFonts(buf.toString("utf8"));
    for (const t of telemetry) assert.ok(!svg.includes(t), `${f}: telemetry id ${t}`);
    assert.ok(!/x{3,}/.test(svg), `${f}: placeholder transcript text`);
    assert.ok(!/<(command|local-command|bash|task-notification|system-reminder)|<!--|<title|<desc|<metadata|data-/.test(svg), `${f}: tag or metadata`);
    assert.ok(!/\b(content|thinking|stdout|stderr|structuredPatch|requestId|agentId|toolUseResult|parentUuid)\b/.test(svg), `${f}: raw field`);
    for (const id of ids) assert.ok(!svg.includes(id), `${f}: full session id`);
    if (!f.includes("no-redact")) assert.ok(!/project|PROJECT|fixture/.test(svg), `${f}: redacted export shows the project`);
  }
});
