// v0.2.1 stage 4: CLI targeting. `<prefix> export [last]` and `project <name-or-path> [all|week|month]
// [export]`, on throwaway Claude homes built from anonymized fixtures; exports go to temp directories.
// Never touches ~/.claude or ~/.claude-receipt.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { HistoryReceipt } from "../../src/aggregate/types.ts";
import { loadFonts } from "../../src/assets.ts";
import { run } from "../../src/cli/run.ts";
import type { Receipt } from "../../src/receipt/types.ts";
import { toSvg } from "../../src/render/svg.ts";
import { historyView, sessionView } from "../../src/render/view.ts";
import { layoutView } from "../../src/render/visual/layout.ts";

const FIX = join("fixtures", "claude-code", "2.1.283");
const NOW = new Date("2026-10-01T12:00:00.000Z");
const WIN = process.platform === "win32";
const raw = (name: string) => readFileSync(join(FIX, name), "utf8");
// fixtures were recorded in two directories (project, project1): replace the whole directory name
const withCwd = (text: string, cwd: string) => text.replace(/C:\\\\fixture\\\\project\d*(?=")/g, () => JSON.stringify(cwd).slice(1, -1));

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
interface Home { claude: string; env: NodeJS.ProcessEnv }
function home(): Home {
  const root = tmp("claude-receipt-target-"), claude = join(root, "claude");
  mkdirSync(join(claude, "projects"), { recursive: true });
  return { claude, env: { CLAUDE_CONFIG_DIR: claude, CLAUDE_RECEIPT_HOME: join(root, "receipt") } };
}
const put = (h: Home, dir: string, id: string, text: string) => { const p = join(h.claude, "projects", dir); mkdirSync(p, { recursive: true }); writeFileSync(join(p, `${id}.jsonl`), text); };
async function cli(h: Home, argv: string[], cwd = "C:\\somewhere\\else") {
  let out = "", err = "";
  const code = await run(argv, { stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, cwd, env: h.env, isTTY: false, timeZone: "UTC", now: NOW });
  return { code, out, err };
}
const ok = async (h: Home, argv: string[], cwd?: string) => { const r = await cli(h, argv, cwd); assert.equal(r.code, 0, `${argv.join(" ")}: ${r.err}`); return r; };
const json = async <T>(h: Home, argv: string[], cwd?: string) => JSON.parse((await ok(h, [...argv, "--json"], cwd)).out) as T;
const A = "aaaa1111-0000-4000-8000-000000000001", B = "bbbb2222-0000-4000-8000-000000000002", C = "cccc3333-0000-4000-8000-000000000003", D = "dddd4444-0000-4000-8000-000000000004";
// alpha: ordinary (A) + killed (B); beta: no-tools (C)
function twoProjects() {
  const h = home();
  put(h, "p-alpha", A, withCwd(raw("ordinary.jsonl"), "C:\\work\\alpha"));
  put(h, "p-alpha", B, withCwd(raw("killed.jsonl"), "C:\\work\\alpha"));
  put(h, "p-beta", C, withCwd(raw("no-tools.jsonl"), "C:\\work\\beta"));
  return h;
}
const files = (dir: string) => readdirSync(dir).sort();
const PATHY = /[A-Za-z]:[\\/]|\\work\\|\/work\//;

// ---- <prefix> export [last] ----

test("<prefix> export and <prefix> export last write that session, exactly as export <prefix> does", async () => {
  const h = twoProjects();
  const out = tmp("cr-export-");
  const newest = (await json<Receipt>(h, ["last"])).session.id;
  const target = [A, B].find((x) => x !== newest)!; // not the newest: "last" must not switch sessions
  const a = await ok(h, [target.slice(0, 4), "export", "--svg"], out);
  const b = await ok(h, [target.slice(0, 4), "export", "last", "--svg"], out);
  const c = await ok(h, ["export", target.slice(0, 4), "--svg"], out);
  const names = [a, b, c].map((r) => r.out.trim().split(/[\\/]/).pop());
  const short = target.slice(0, 4);
  assert.deepEqual(names, [`claude-receipt-${short}.svg`, `claude-receipt-${short}-2.svg`, `claude-receipt-${short}-3.svg`], "redacted id names, never overwritten");
  const [x, y, z] = names.map((n) => readFileSync(join(out, n!), "utf8"));
  assert.equal(x, y); assert.equal(y, z);
  const r = await json<Receipt>(h, [target.slice(0, 4), "--redact"]);
  assert.equal(x, toSvg(layoutView(sessionView(r)), loadFonts()), "the image is the same receipt --json describes");
  // unredacted keeps the 8-character id name
  const u = await ok(h, [target.slice(0, 6), "export", "--svg", "--no-redact"], out);
  assert.ok(u.out.trim().endsWith(`claude-receipt-${target.slice(0, 8)}.svg`));
  // PNG by default
  assert.ok((await ok(h, [target.slice(0, 4), "export"], out)).out.trim().endsWith(".png"));
});

test("<prefix> export: unknown, ambiguous and malformed forms", async () => {
  const h = twoProjects();
  put(h, "p-alpha", "aaaa9999-0000-4000-8000-000000000009", withCwd(raw("no-tools.jsonl"), "C:\\work\\alpha"));
  const out = tmp("cr-export-");
  assert.equal((await cli(h, ["ffff", "export"], out)).code, 1);
  const amb = await cli(h, ["aaaa", "export"], out);
  assert.equal(amb.code, 1);
  assert.match(amb.err, /matches 2 sessions/);
  for (const argv of [[A.slice(0, 4), "export", "list"], [A.slice(0, 4), "export", "last", "x"], ["last", "export"], ["all", "export"], ["list", "export"], [A.slice(0, 4), "export", "--json"]]) {
    const r = await cli(h, argv, out);
    assert.equal(r.code, 2, `${argv.join(" ")}: ${r.err}`);
  }
  assert.deepEqual(files(out), [], "nothing written on an error");
});

// ---- project <name-or-path> ----

test("project <name>: the same history as --project inside it; names match case-insensitively for Windows projects", async () => {
  const h = twoProjects();
  const inside = await json<HistoryReceipt>(h, ["all", "--project"], "C:\\work\\alpha");
  const byName = await json<HistoryReceipt>(h, ["project", "alpha"]);
  assert.deepEqual(byName, inside);
  assert.equal(byName.coverage.sessions, 2);
  assert.equal(byName.scope.projectFilter, true);
  assert.deepEqual(await json(h, ["project", "ALPHA"]), inside);
  assert.deepEqual(await json(h, ["project", "alpha", "all"]), inside, "all is the default");
  assert.equal((await json<HistoryReceipt>(h, ["project", "beta"])).coverage.sessions, 1);
  // a project is only ever named through "project": a bare name is a (non-matching) session prefix
  assert.equal((await cli(h, ["alpha"])).code, 1);
});

test("project <name> week / month: the same periods as week / month --project", async () => {
  const h = twoProjects();
  for (const period of ["week", "month"] as const) {
    const inside = await json<HistoryReceipt>(h, [period, "--project"], "C:\\work\\alpha");
    const byName = await json<HistoryReceipt>(h, ["project", "alpha", period]);
    assert.deepEqual(byName, inside);
    assert.equal(byName.scope.period, period);
  }
});

test("project <path>: absolute or relative, trailing separators, case-insensitive on Windows", { skip: !WIN && "Windows paths" }, async () => {
  const h = twoProjects();
  const inside = await json<HistoryReceipt>(h, ["all", "--project"], "C:\\work\\alpha");
  for (const [arg, cwd] of [["C:\\work\\alpha", undefined], ["c:\\WORK\\Alpha\\", undefined], ["C:/work/alpha", undefined], [".", "C:\\work\\alpha"], ["..\\alpha", "C:\\work\\beta"]] as const)
    assert.deepEqual(await json(h, ["project", arg], cwd), inside, arg);
});

test("project <path> on POSIX: exact, case-sensitive", { skip: WIN && "POSIX paths" }, async () => {
  const h = home();
  put(h, "p-alpha", A, withCwd(raw("ordinary.jsonl"), "/work/alpha"));
  put(h, "p-alpha2", B, withCwd(raw("killed.jsonl"), "/work/Alpha"));
  assert.equal((await json<HistoryReceipt>(h, ["project", "/work/alpha/"])).coverage.sessions, 1);
  assert.equal((await json<HistoryReceipt>(h, ["project", "../alpha"], "/work/beta")).coverage.sessions, 1);
  assert.equal((await json<HistoryReceipt>(h, ["project", "Alpha"])).coverage.sessions, 1, "POSIX names are case-sensitive");
});

test("project: ambiguous and unknown names or paths exit 1 and never print a path", async () => {
  const h = twoProjects();
  put(h, "p-alpha-other", D, withCwd(raw("no-tools.jsonl"), "C:\\other\\alpha")); // a second project named alpha
  const amb = await cli(h, ["project", "alpha"]);
  assert.equal(amb.code, 1);
  assert.match(amb.err, /"alpha" matches 2 projects; give its path, or use --project inside it/);
  if (WIN) assert.equal((await json<HistoryReceipt>(h, ["project", "C:\\other\\alpha"])).coverage.sessions, 1, "a path disambiguates");
  const unknown = await cli(h, ["project", "gamma"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no project named "gamma"/);
  const nopath = await cli(h, ["project", "C:\\secret\\place"]);
  assert.equal(nopath.code, 1);
  assert.match(nopath.err, /no sessions found for that project path/);
  for (const r of [amb, unknown, nopath]) { assert.equal(r.out, ""); assert.ok(!PATHY.test(r.err) && !r.err.includes("secret"), r.err); }
  // a known project with nothing in the period: the usual empty-period exit
  const empty = await cli(h, ["project", "beta", "week"]);
  assert.equal(empty.code, 0, "beta's session is within the week");
});

test("project: usage errors exit 2", async () => {
  const h = twoProjects();
  for (const argv of [["project"], ["project", "alpha", "--project"], ["project", "alpha", "bogus"], ["project", "alpha", "export", "--json"], ["project", "alpha", "--limit", "3"], ["project", "alpha", "export", "week"], ["project", "alpha", "--svg"]]) {
    const r = await cli(h, argv);
    assert.equal(r.code, 2, `${argv.join(" ")}: ${r.err}`);
  }
});

// ---- project export ----

test("project export: redacted by default, generic file names, never a project name or path", async () => {
  const h = twoProjects();
  const out = tmp("cr-export-");
  const a = await ok(h, ["project", "alpha", "export", "--svg"], out);
  const w = await ok(h, ["project", "alpha", "week", "export", "--svg"], out);
  const n = await ok(h, ["project", "alpha", "export", "--svg", "--no-redact"], out);
  const p = await ok(h, ["project", "alpha", "month", "export"], out);
  assert.deepEqual(files(out), ["claude-receipt-all-project-2.svg", "claude-receipt-all-project.svg", "claude-receipt-month-project.png", "claude-receipt-week-project.svg"]);
  for (const r of [a, w, n, p]) assert.ok(!/alpha/i.test(r.out.split(/[\\/]/).pop()!), "file name holds no project name");
  const redacted = readFileSync(join(out, "claude-receipt-all-project.svg"), "utf8").replace(/@font-face\{[^}]*\}/g, "");
  assert.ok(redacted.includes(">ONE PROJECT (HIDDEN)</text>"));
  assert.ok(!/alpha|\\work|C:\\/i.test(redacted), "no project name or path in a redacted image");
  for (const r of [a, w, p]) assert.ok(!/alpha/i.test(r.err) && !PATHY.test(r.err.replace(out, "")), r.err);
  const plain = readFileSync(join(out, "claude-receipt-all-project-2.svg"), "utf8");
  assert.ok(plain.includes(">alpha</text>"), "--no-redact shows the name");
  // terminal --redact: the same label, no name
  const t = await ok(h, ["project", "alpha", "--redact"]);
  assert.match(t.out, /PROJECT \.+ ONE PROJECT \(HIDDEN\)\n/);
  assert.ok(!/alpha/i.test(t.out + t.err));
});

test("project export: an explicit --output is never overwritten", async () => {
  const h = twoProjects();
  const out = tmp("cr-export-");
  writeFileSync(join(out, "mine.svg"), "keep me");
  const r = await cli(h, ["project", "alpha", "export", "--svg", "-o", "mine.svg"], out);
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists; not overwritten/);
  assert.equal(readFileSync(join(out, "mine.svg"), "utf8"), "keep me");
  assert.equal((await cli(h, ["project", "alpha", "export", "--svg", "-o", "new.svg"], out)).code, 0);
  assert.deepEqual(files(out), ["mine.svg", "new.svg"]);
});

test("one target, three outputs: JSON, terminal and image describe the same project history", async () => {
  const h = twoProjects();
  const out = tmp("cr-export-");
  for (const period of ["all", "week", "month"] as const) {
    const hr = await json<HistoryReceipt>(h, ["project", "alpha", period, "--redact"]);
    const term = (await ok(h, ["project", "alpha", period, "--redact"])).out;
    assert.match(term, new RegExp(`SESSIONS \\.+ ${hr.coverage.sessions}\\n`));
    const file = (await ok(h, ["project", "alpha", period, "export", "--svg"], out)).out.trim();
    assert.equal(readFileSync(file, "utf8"), toSvg(layoutView(historyView(hr)), loadFonts()), `${period}: the image is the JSON's history`);
  }
  // and the targeted history matches the current-directory form byte for byte
  const fromInside = (await ok(h, ["all", "--project", "--redact"], "C:\\work\\alpha")).out;
  assert.equal((await ok(h, ["project", "alpha", "--redact"])).out, fromInside);
});
