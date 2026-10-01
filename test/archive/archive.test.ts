// M2: the local metrics-only archive. Temporary directories only; anonymized fixtures only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildReceipt } from "../../src/analytics/index.ts";
import {
  ARCHIVE_SCHEMA_VERSION, archiveDir, archiveKey, contentHash, fingerprintOf, listArchive, migrateEntry, readArchived, validateEntry, writeReceipt,
  type ArchiveEntry,
} from "../../src/archive/index.ts";
import type { Receipt } from "../../src/receipt/types.ts";
import { loadSessions, refForFile, type Session } from "../../src/source/claude-code/index.ts";

const DIR = join("fixtures", "claude-code", "2.1.283");
const SUB = join("subagent", readdirSync(join(DIR, "subagent")).find((f) => f.endsWith(".jsonl"))!);
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).concat(SUB);
const T0 = new Date("2026-10-01T00:00:00.000Z"), T1 = new Date("2026-10-02T00:00:00.000Z");
// every temp dir this file makes is removed when the file finishes, pass or fail
const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "claude-receipt-archive-")); made.push(d); return d; };
const sessionOf = async (name: string) => (await loadSessions([refForFile(join(DIR, name))]))[0]!;
const receiptOf = (s: Session, now = T0) => buildReceipt(s, { now, timeZone: "UTC" });
const entryFile = (dir: string, sessionId: string) => join(dir, `${archiveKey(sessionId)}.json`);
const files = (dir: string) => readdirSync(dir).sort();
const all = (r: Receipt) => Object.values(r.sections).flat();

// ---- round trip, provenance, nulls ----

test("round trip: every fixture Receipt archives and reads back unchanged except the title", async () => {
  const dir = tmp();
  for (const name of FIXTURES) {
    const s = await sessionOf(name);
    const r = receiptOf(s);
    assert.deepEqual(writeReceipt(r, fingerprintOf(s), { dir, now: T0 }), { status: "created", key: archiveKey(s.id) }, name);
    const back = readArchived(s.id, dir);
    assert.equal(back.status, "ok", name);
    if (back.status !== "ok") continue;
    assert.deepEqual(back.entry.receipt, { ...r, session: { ...r.session, title: null } }, name);
    assert.deepEqual(validateEntry(back.entry), []);
    assert.equal(back.entry.archiveSchemaVersion, ARCHIVE_SCHEMA_VERSION);
    assert.deepEqual(back.entry.source, fingerprintOf(s));
  }
  assert.equal(listArchive(dir).entries.length, FIXTURES.length);
});

test("provenance and null metrics are preserved exactly (no upgrade, no downgrade, no zero-filling)", async () => {
  const dir = tmp();
  for (const name of ["killed.jsonl", "ordinary.jsonl", "forked.jsonl"]) {
    const s = await sessionOf(name);
    const r = receiptOf(s);
    writeReceipt(r, fingerprintOf(s), { dir });
    const back = readArchived(s.id, dir);
    assert.equal(back.status, "ok");
    if (back.status !== "ok") continue;
    const before = all(r).map((m) => [m.id, m.provenance, m.value === null, m.unavailableReason ?? null]);
    const after = all(back.entry.receipt).map((m) => [m.id, m.provenance, m.value === null, m.unavailableReason ?? null]);
    assert.deepEqual(after, before, name);
  }
  const killed = readArchived((await sessionOf("killed.jsonl")).id, dir);
  assert.ok(killed.status === "ok" && all(killed.entry.receipt).filter((m) => m.value === null).length > 10, "nulls stay null");
});

test("titles are never archived", async () => {
  const dir = tmp();
  const s = await sessionOf("ordinary.jsonl");
  const r = receiptOf({ ...s, title: "A title summarizing the conversation" });
  assert.equal(r.session.title, "A title summarizing the conversation");
  writeReceipt(r, fingerprintOf(s), { dir });
  assert.ok(!readFileSync(entryFile(dir, s.id), "utf8").includes("summarizing the conversation"));
});

// ---- identity ----

test("archive key: deterministic, 32 lowercase hex, filesystem-safe for any id, adapter-namespaced", () => {
  const ids = ["00000000-0000-4000-8000-000000000001", "../../etc/passwd", "CON", "a:b\\c/d", "", "UPPER-lower", "ünïcødé"];
  const keys = ids.map((id) => archiveKey(id));
  for (const k of keys) assert.match(k, /^[0-9a-f]{32}$/);
  assert.equal(new Set(keys).size, ids.length, "distinct sessions, distinct keys");
  assert.equal(archiveKey(ids[0]!), archiveKey(ids[0]!), "stable");
  assert.notEqual(archiveKey(ids[0]!), archiveKey(ids[0]!, "other-source"), "namespaced by adapter");
  assert.notEqual(archiveKey("abc"), archiveKey("ABC"), "session ids are case-sensitive");
  assert.ok(!keys.some((k) => k.includes(ids[0]!.slice(0, 8))), "the key doesn't reveal the session id");
});

test("multiple projects and Windows-style paths: one entry per session, independent of project", async () => {
  const dir = tmp();
  const s = await sessionOf("ordinary.jsonl");
  const variants: Session[] = [
    { ...s, id: "00000000-0000-4000-8000-00000000a001", project: { ...s.project, cwd: "C:\\Work\\Alpha", key: "c:\\work\\alpha", name: "Alpha" } },
    { ...s, id: "00000000-0000-4000-8000-00000000a002", project: { ...s.project, cwd: "D:\\Other Proj\\beta.v2", key: "d:\\other proj\\beta.v2", name: "beta.v2" } },
    { ...s, id: "00000000-0000-4000-8000-00000000a003", project: { ...s.project, cwd: "/home/dev/gamma", key: "/home/dev/gamma", name: "gamma" } },
  ];
  for (const v of variants) assert.equal(writeReceipt(receiptOf(v), fingerprintOf(v), { dir }).status, "created");
  const { entries, problems } = listArchive(dir);
  assert.deepEqual(problems, []);
  assert.deepEqual(entries.map((e) => e.receipt.session.projectKey).sort(), ["/home/dev/gamma", "c:\\work\\alpha", "d:\\other proj\\beta.v2"]);
  for (const f of files(dir)) assert.match(f, /^[0-9a-f]{32}\.json$/, "only safe file names are written");
});

// ---- idempotency and conflicts ----

test("archiving the same Receipt twice is a no-op (generatedAt ignored), and never duplicates", async () => {
  const dir = tmp();
  const s = await sessionOf("ordinary.jsonl");
  assert.equal(writeReceipt(receiptOf(s, T0), fingerprintOf(s), { dir, now: T0 }).status, "created");
  const bytes = readFileSync(entryFile(dir, s.id), "utf8");
  assert.equal(writeReceipt(receiptOf(s, T1), fingerprintOf(s), { dir, now: T1 }).status, "unchanged");
  assert.equal(readFileSync(entryFile(dir, s.id), "utf8"), bytes, "file not rewritten");
  assert.deepEqual(files(dir), [`${archiveKey(s.id)}.json`]);
});

test("a resumed session that grew replaces its entry (continuation), keeping archivedAt", async () => {
  const dir = tmp(), work = tmp();
  const id = "00000000-0000-4000-8000-00000000b001";
  const path = join(work, `${id}.jsonl`);
  writeFileSync(path, readFileSync(join(DIR, "ordinary.jsonl"))); // the first run of the resumed session
  const s1 = (await loadSessions([refForFile(path)]))[0]!;
  assert.equal(writeReceipt(receiptOf(s1), fingerprintOf(s1), { dir, now: T0 }).status, "created");
  writeFileSync(path, readFileSync(join(DIR, "resumed.jsonl"))); // two more runs appended
  const s3 = (await loadSessions([refForFile(path)]))[0]!;
  assert.equal(writeReceipt(receiptOf(s3), fingerprintOf(s3), { dir, now: T1 }).status, "updated");
  const back = readArchived(id, dir);
  assert.ok(back.status === "ok");
  if (back.status !== "ok") return;
  assert.equal(back.entry.archivedAt, T0.toISOString());
  assert.equal(back.entry.updatedAt, T1.toISOString());
  assert.equal(all(back.entry.receipt).find((m) => m.id === "session.runs")!.value, 3);
  assert.deepEqual(files(dir), [`${archiveKey(id)}.json`]);
});

test("conflicting content for the same session is refused and the archived history is untouched", async () => {
  const s = await sessionOf("ordinary.jsonl");
  const base = receiptOf(s);
  const cases: [string, Receipt, ReturnType<typeof fingerprintOf>, RegExp][] = [
    ["same transcript, different content", { ...base, sections: { ...base.sections, hard: base.sections.hard.map((m) => (m.id === "prompts.count" ? { ...m, value: 99 } : m)) } } as Receipt, fingerprintOf(s), /not grown/],
    ["newer generator", { ...base, generator: { ...base.generator, version: "9.9.9" } }, { ...fingerprintOf(s), bytes: fingerprintOf(s).bytes + 10 }, /generator version/],
    ["different time zone", buildReceipt(s, { now: T0, timeZone: "Asia/Kolkata" }), { ...fingerprintOf(s), bytes: fingerprintOf(s).bytes + 10 }, /time zone/],
  ];
  for (const [what, r, src, why] of cases) {
    const dir = tmp();
    writeReceipt(base, fingerprintOf(s), { dir });
    const before = readFileSync(entryFile(dir, s.id), "utf8");
    const res = writeReceipt(r, src, { dir });
    assert.equal(res.status, "conflict", what);
    assert.match("reason" in res ? res.reason : "", why, what);
    assert.equal(readFileSync(entryFile(dir, s.id), "utf8"), before, `${what}: untouched`);
  }
});

test("a fork whose parent later disappears cannot overwrite its fork-aware entry", async () => {
  const dir = tmp();
  const [, fork] = await loadSessions([refForFile(join(DIR, "resumed.jsonl")), refForFile(join(DIR, "forked.jsonl"))]);
  assert.equal(writeReceipt(receiptOf(fork!), fingerprintOf(fork!), { dir }).status, "created");
  const [alone] = await loadSessions([refForFile(join(DIR, "forked.jsonl"))]); // parent transcript gone: fork not detected
  const grown = { ...fingerprintOf(alone!), bytes: fingerprintOf(alone!).bytes + 100 };
  const res = writeReceipt(receiptOf(alone!), grown, { dir });
  assert.equal(res.status, "conflict");
  assert.match("reason" in res ? res.reason : "", /fork parentage/);
  const back = readArchived(fork!.id, dir);
  assert.ok(back.status === "ok" && back.entry.receipt.session.forkOf === "resumed");
});

test("an entry survives after its transcript is deleted", async () => {
  const dir = tmp(), work = tmp();
  const path = join(work, "00000000-0000-4000-8000-00000000c001.jsonl");
  writeFileSync(path, readFileSync(join(DIR, "ordinary.jsonl")));
  const s = (await loadSessions([refForFile(path)]))[0]!;
  writeReceipt(receiptOf(s), fingerprintOf(s), { dir });
  rmSync(work, { recursive: true, force: true });
  assert.equal(readArchived(s.id, dir).status, "ok");
});

// ---- rejected inputs ----

test("live sessions, invalid receipts and unsupported receipt versions are rejected and nothing is written", async () => {
  const dir = tmp();
  const s = await sessionOf("ordinary.jsonl");
  const r = receiptOf(s);
  const live = writeReceipt({ ...r, session: { ...r.session, live: true } }, fingerprintOf(s), { dir });
  assert.deepEqual([live.status, "reason" in live && /live/.test(live.reason)], ["rejected", true]);
  const invalid = writeReceipt({ ...r, sections: { ...r.sections, lore: [] } }, fingerprintOf(s), { dir });
  assert.deepEqual([invalid.status, "reason" in invalid && /invalid receipt/.test(invalid.reason)], ["rejected", true]);
  const future = writeReceipt({ ...r, schemaVersion: 2 as 1 }, fingerprintOf(s), { dir });
  assert.deepEqual([future.status, "reason" in future && /schemaVersion/.test(future.reason)], ["rejected", true]);
  assert.deepEqual(readdirSync(dir), []);
});

// ---- malformed, unsupported, tampered ----

test("malformed and unsupported entries are reported, never overwritten, never deleted", async () => {
  const s = await sessionOf("ordinary.jsonl");
  const r = receiptOf(s);
  const valid = () => { const d = tmp(); writeReceipt(r, fingerprintOf(s), { dir: d }); return JSON.parse(readFileSync(entryFile(d, s.id), "utf8")) as ArchiveEntry; };
  const cases: [string, string, string][] = [
    ["truncated JSON", JSON.stringify(valid()).slice(0, 200), "malformed"],
    ["not an object", "[1,2,3]", "malformed"],
    ["future archive schema", JSON.stringify({ ...valid(), archiveSchemaVersion: 2 }), "unsupported"],
    ["future receipt schema", JSON.stringify({ ...valid(), receipt: { ...valid().receipt, schemaVersion: 2 } }), "unsupported"],
    ["unknown top-level field (e.g. a smuggled transcript record)", JSON.stringify({ ...valid(), record: { type: "user", message: "hello" } }), "invalid"],
    ["edited value (hash mismatch)", JSON.stringify({ ...valid(), source: { bytes: 1, mtimeMs: 1 }, contentHash: "0".repeat(64) }), "invalid"],
    ["title present", (() => { const e = valid(); e.receipt.session.title = "x"; return JSON.stringify(e); })(), "invalid"],
  ];
  for (const [what, text, status] of cases) {
    const dir = tmp();
    writeFileSync(entryFile(dir, s.id), text);
    const read = readArchived(s.id, dir);
    assert.equal(read.status, status, what);
    const listed = listArchive(dir);
    assert.deepEqual([listed.entries.length, listed.problems.map((p) => p.status)], [0, [status]], what);
    assert.equal(writeReceipt(r, fingerprintOf(s), { dir }).status, "conflict", `${what}: refused`);
    assert.equal(readFileSync(entryFile(dir, s.id), "utf8"), text, `${what}: untouched`);
  }
});

test("an entry filed under another session's key is invalid (misplaced or colliding)", async () => {
  const dir = tmp();
  const a = await sessionOf("ordinary.jsonl"), b = await sessionOf("no-tools.jsonl");
  writeReceipt(receiptOf(b), fingerprintOf(b), { dir });
  writeFileSync(entryFile(dir, a.id), readFileSync(entryFile(dir, b.id)));
  const read = readArchived(a.id, dir);
  assert.equal(read.status, "invalid");
  assert.equal(writeReceipt(receiptOf(a), fingerprintOf(a), { dir }).status, "conflict");
});

test("migration boundary: versions are checked, migrations chain, newer versions are never guessed", () => {
  const e = { archiveSchemaVersion: 1, x: 1 };
  assert.deepEqual(migrateEntry(e), { ok: true, entry: e }, "current version passes through");
  const toV2 = { 1: (x: Record<string, unknown>) => ({ ...x, archiveSchemaVersion: 2, added: true }) };
  assert.deepEqual(migrateEntry(e, toV2, 2), { ok: true, entry: { archiveSchemaVersion: 2, x: 1, added: true } });
  assert.equal(migrateEntry({ archiveSchemaVersion: 3 }, toV2, 2).ok, false, "newer than supported");
  assert.equal(migrateEntry({ archiveSchemaVersion: 1 }, {}, 2).ok, false, "missing step");
  assert.equal(migrateEntry({ archiveSchemaVersion: "1" }).ok, false, "not an integer");
  assert.equal(migrateEntry({}).ok, false, "absent");
});

// ---- atomic writes ----

test("atomic writes: no temp residue; interrupted temp files are ignored; partial JSON is never a valid entry", async () => {
  const dir = tmp();
  const s = await sessionOf("ordinary.jsonl");
  const r = receiptOf(s);
  writeReceipt(r, fingerprintOf(s), { dir });
  assert.deepEqual(files(dir), [`${archiveKey(s.id)}.json`], "only the entry: the temp file was renamed");
  // a crash between writing the temp file and renaming it leaves a temp file behind
  const other = "00000000-0000-4000-8000-00000000d001";
  writeFileSync(`${entryFile(dir, other)}.tmp-4242-deadbeef`, readFileSync(entryFile(dir, s.id), "utf8").slice(0, 300));
  assert.equal(readArchived(other, dir).status, "missing", "a temp file is not an entry");
  const listed = listArchive(dir);
  assert.deepEqual([listed.entries.length, listed.problems.length], [1, 0]);
  assert.ok(files(dir).some((f) => f.includes(".tmp-")), "temp files are left for the user, never deleted");
  // a partial file under the entry's own name (not produced by this code) is reported, never accepted
  writeFileSync(entryFile(dir, other), readFileSync(entryFile(dir, s.id), "utf8").slice(0, 300));
  assert.equal(readArchived(other, dir).status, "malformed");
});

test("the archive directory honours CLAUDE_RECEIPT_HOME", () => {
  const before = process.env.CLAUDE_RECEIPT_HOME;
  try {
    process.env.CLAUDE_RECEIPT_HOME = join(tmpdir(), "receipt-home");
    assert.equal(archiveDir(), join(tmpdir(), "receipt-home", "archive"));
  } finally {
    if (before === undefined) delete process.env.CLAUDE_RECEIPT_HOME; else process.env.CLAUDE_RECEIPT_HOME = before;
  }
});

// ---- privacy ----

const ID_TOKEN = /(?<![A-Za-z0-9.])(?:(?:msg|toolu|req|srvtoolu)_[A-Za-z0-9]+|a[0-9a-f]{12})(?![A-Za-z0-9])/g;
// raw text/record fields, and the Session's per-item arrays (the Receipt only has counts)
const FORBIDDEN_KEYS = /"(content|text|thinking|command|stdout|stderr|patch|structuredPatch|message|prompt|description|label|uuid|requestId|agentId|sourceFingerprint)"\s*:|"(apiCalls|toolCalls|prompts|turns|slashCommands|subagents)"\s*:\s*\[/;

test("privacy: archived fixtures hold no transcript text, tags, raw fields, or API/message/tool/agent ids", async () => {
  const dir = tmp();
  const sessions = await loadSessions(FIXTURES.map((n) => refForFile(join(DIR, n))));
  for (const s of sessions) writeReceipt(receiptOf(s), fingerprintOf(s), { dir });
  const fixtureIds = new Set<string>();
  for (const n of FIXTURES) for (const t of readFileSync(join(DIR, n), "utf8").match(ID_TOKEN) ?? []) fixtureIds.add(t);
  assert.ok(fixtureIds.size > 10, "fixtures do contain (fake) api/tool/agent ids to leak");
  for (const f of files(dir)) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.ok(!/x{3,}/.test(text), `${f}: placeholder text`);
    assert.ok(!/<(command|local-command|bash|task-notification|system-reminder)/.test(text), `${f}: tag`);
    assert.ok(!FORBIDDEN_KEYS.test(text), `${f}: raw or presentation field`);
    assert.deepEqual((text.match(ID_TOKEN) ?? []).filter((t) => fixtureIds.has(t)), [], `${f}: telemetry id`);
    assert.equal(JSON.parse(text).receipt.session.title, null);
  }
});

test("content hash is the identity of the content: stable, and it changes with any value", async () => {
  const s = await sessionOf("ordinary.jsonl");
  const r = receiptOf(s, T0);
  assert.equal(contentHash(r), contentHash(receiptOf(s, T1)), "generatedAt excluded");
  assert.equal(contentHash(r), contentHash(JSON.parse(JSON.stringify(r))), "survives a JSON round trip");
  const reordered = Object.fromEntries(Object.entries(r).reverse()) as unknown as Receipt;
  assert.equal(contentHash(r), contentHash(reordered), "independent of key order");
  assert.notEqual(contentHash(r), contentHash({ ...r, session: { ...r.session, endedAt: "2099-01-01T00:00:00.000Z" } }));
});

test("the archive directory is created on first write and never contains anything but entries", async () => {
  const dir = join(tmp(), "nested", "archive");
  const s = await sessionOf("no-tools.jsonl");
  assert.equal(writeReceipt(receiptOf(s), fingerprintOf(s), { dir }).status, "created");
  assert.deepEqual(files(dir), [`${archiveKey(s.id)}.json`]);
  mkdirSync(join(dir, "some-subdir"));
  writeFileSync(join(dir, "notes.txt"), "user file");
  assert.deepEqual([listArchive(dir).entries.length, listArchive(dir).problems.length], [1, 0], "foreign files are ignored");
});
