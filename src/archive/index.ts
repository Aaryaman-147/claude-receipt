// Local, metrics-only archive of session Receipts (docs/ARCHITECTURE.md §6, docs/PRIVACY.md §5).
// One JSON file per session under ~/.claude-receipt/archive/ (or $CLAUDE_RECEIPT_HOME/archive/).
// It stores the computed Receipt (title removed) plus a size/mtime fingerprint: never transcript
// records, text, API/message/agent ids, or presentation copy.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RECEIPT_SCHEMA_VERSION, type Receipt } from "../receipt/types.ts";
import { validateReceipt } from "../receipt/validate.ts";
import type { Session } from "../source/claude-code/index.ts";

export const ARCHIVE_SCHEMA_VERSION = 1;

export interface ArchiveEntry {
  archiveSchemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  key: string; // archiveKey(receipt.session.id); also the file name
  archivedAt: string; // first written
  updatedAt: string; // last written (a continuation of the same session)
  contentHash: string; // sha256 of the canonical Receipt without generatedAt: the identity of the content
  source: { bytes: number; mtimeMs: number }; // transcript fingerprint (main + subagent files), no paths
  receipt: Receipt; // session.title is always null here
}

export type WriteResult =
  | { status: "created" | "unchanged" | "updated"; key: string }
  | { status: "conflict" | "rejected"; key: string | null; reason: string };

export type ReadResult =
  | { status: "ok"; entry: ArchiveEntry }
  | { status: "missing" | "malformed" | "unsupported" | "invalid"; key: string; reason: string };

export const archiveDir = (): string => join(process.env.CLAUDE_RECEIPT_HOME || join(homedir(), ".claude-receipt"), "archive");

// Deterministic, filesystem-safe (32 lowercase hex on every platform), collision-resistant (128 bits),
// and independent of project paths. Namespaced by adapter so another source can never collide.
export const archiveKey = (sessionId: string, adapter = "claude-code"): string =>
  createHash("sha256").update(`claude-receipt/archive-key/v1\0${adapter}\0${sessionId}`).digest("hex").slice(0, 32);
const KEY_FILE = /^([0-9a-f]{32})\.json$/;

// Canonical JSON (sorted keys) so the hash doesn't depend on property order.
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v);
export const contentHash = (r: Receipt): string =>
  createHash("sha256").update(canonical({ ...r, generatedAt: null })).digest("hex");

export const fingerprintOf = (s: Pick<Session, "source">): ArchiveEntry["source"] => ({
  bytes: s.source.main.sizeBytes + s.source.subagents.reduce((n, f) => n + f.sizeBytes, 0),
  mtimeMs: Math.max(s.source.main.mtimeMs, ...s.source.subagents.map((f) => f.mtimeMs)),
});

const ENTRY_FIELDS = ["archiveSchemaVersion", "key", "archivedAt", "updatedAt", "contentHash", "source", "receipt"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Everything a read-back entry must satisfy. Unknown fields are rejected so nothing else
// (transcript records, text, ids) can ride along.
export function validateEntry(e: unknown): string[] {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return ["entry is not an object"];
  const x = e as Record<string, unknown>;
  const errs: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };
  need(Object.keys(x).every((k) => ENTRY_FIELDS.includes(k)) && ENTRY_FIELDS.every((k) => k in x), "entry fields");
  need(x.archiveSchemaVersion === ARCHIVE_SCHEMA_VERSION, "archiveSchemaVersion");
  need(typeof x.archivedAt === "string" && ISO.test(x.archivedAt) && typeof x.updatedAt === "string" && ISO.test(x.updatedAt), "timestamps");
  const src = x.source as Record<string, unknown> | null;
  need(!!src && typeof src === "object" && Number.isInteger(src.bytes) && typeof src.mtimeMs === "number" && Object.keys(src).length === 2, "source");
  const receiptErrs = validateReceipt(x.receipt);
  errs.push(...receiptErrs.map((m) => `receipt: ${m}`));
  if (!receiptErrs.length) {
    const r = x.receipt as Receipt;
    need(r.session.title === null, "receipt: title must not be archived");
    need(!r.session.live, "receipt: live sessions are not archived");
    need(x.key === archiveKey(r.session.id), "key does not match the session");
    need(x.contentHash === contentHash(r), "contentHash does not match the receipt");
  }
  return errs;
}

// Versioned migration boundary: MIGRATIONS[n] turns a version-n entry into version n+1. Empty
// while only v1 exists; newer versions than we know are never guessed at ("unsupported").
export type Migration = (entry: Record<string, unknown>) => Record<string, unknown>;
export const MIGRATIONS: Record<number, Migration> = {};
export function migrateEntry(raw: Record<string, unknown>, migrations = MIGRATIONS, target = ARCHIVE_SCHEMA_VERSION):
  { ok: true; entry: Record<string, unknown> } | { ok: false; reason: string } {
  let v = raw.archiveSchemaVersion;
  if (!Number.isInteger(v) || (v as number) < 1) return { ok: false, reason: `invalid archiveSchemaVersion ${String(v)}` };
  if ((v as number) > target) return { ok: false, reason: `archiveSchemaVersion ${v} is newer than supported (${target})` };
  let entry = raw;
  while ((v as number) < target) {
    const step = migrations[v as number];
    if (!step) return { ok: false, reason: `no migration from archiveSchemaVersion ${v}` };
    entry = step(entry);
    v = entry.archiveSchemaVersion;
  }
  return { ok: true, entry };
}

function readPath(path: string, key: string): ReadResult {
  if (!existsSync(path)) return { status: "missing", key, reason: "no archive entry" };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch { return { status: "malformed", key, reason: "not valid JSON" }; }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { status: "malformed", key, reason: "not a JSON object" };
  const migrated = migrateEntry(raw as Record<string, unknown>);
  if (!migrated.ok) return { status: "unsupported", key, reason: migrated.reason };
  const receiptVersion = (migrated.entry.receipt as { schemaVersion?: unknown } | undefined)?.schemaVersion;
  if (receiptVersion !== RECEIPT_SCHEMA_VERSION) return { status: "unsupported", key, reason: `receipt schemaVersion ${String(receiptVersion)} is not supported` };
  const errs = validateEntry(migrated.entry);
  if (errs.length) return { status: "invalid", key, reason: errs.slice(0, 5).join("; ") };
  if ((migrated.entry as unknown as ArchiveEntry).key !== key) return { status: "invalid", key, reason: "file name does not match entry key" };
  return { status: "ok", entry: migrated.entry as unknown as ArchiveEntry };
}

export const readArchived = (sessionId: string, dir = archiveDir()): ReadResult => {
  const key = archiveKey(sessionId);
  return readPath(join(dir, `${key}.json`), key);
};

// All readable entries, sorted by session start. Problem files are reported, never deleted or
// repaired. Temp files from interrupted writes don't match the entry name and are ignored.
export function listArchive(dir = archiveDir()): { entries: ArchiveEntry[]; problems: Exclude<ReadResult, { status: "ok" }>[] } {
  const entries: ArchiveEntry[] = [], problems: Exclude<ReadResult, { status: "ok" }>[] = [];
  if (!existsSync(dir)) return { entries, problems };
  for (const name of readdirSync(dir).sort()) {
    const key = name.match(KEY_FILE)?.[1];
    if (!key) continue;
    const r = readPath(join(dir, name), key);
    if (r.status === "ok") entries.push(r.entry); else problems.push(r);
  }
  entries.sort((a, b) => (a.receipt.session.startedAt ?? "").localeCompare(b.receipt.session.startedAt ?? "") || a.key.localeCompare(b.key));
  return { entries, problems };
}

// Temp file in the same directory, flushed to disk, then renamed over the target: a reader sees
// the old entry or the new one, never a partial file under the entry's name.
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(tmp, "wx");
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

// Archives one session Receipt. Idempotent: identical content is "unchanged" and not rewritten.
// A differing entry is only replaced by a continuation of the same session (its transcript grew);
// anything else is a "conflict" and the existing history is left untouched.
export function writeReceipt(receipt: Receipt, source: ArchiveEntry["source"], opts: { dir?: string; now?: Date } = {}): WriteResult {
  const dir = opts.dir ?? archiveDir();
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) return { status: "rejected", key: null, reason: `unsupported receipt schemaVersion ${String(receipt.schemaVersion)}` };
  const receiptErrs = validateReceipt(receipt);
  if (receiptErrs.length) return { status: "rejected", key: null, reason: `invalid receipt: ${receiptErrs.slice(0, 3).join("; ")}` };
  if (receipt.session.live) return { status: "rejected", key: null, reason: "live session: archive it once it has ended" };
  if (!Number.isInteger(source.bytes) || source.bytes < 0 || !Number.isFinite(source.mtimeMs)) return { status: "rejected", key: null, reason: "invalid source fingerprint" };

  const archived: Receipt = { ...receipt, session: { ...receipt.session, title: null } }; // titles are never archived
  const key = archiveKey(receipt.session.id);
  const hash = contentHash(archived);
  const path = join(dir, `${key}.json`);
  const now = (opts.now ?? new Date()).toISOString();
  const existing = readPath(path, key);

  let archivedAt = now;
  if (existing.status === "ok") {
    const old = existing.entry, s = old.receipt.session, n = archived.session;
    if (old.contentHash === hash) return { status: "unchanged", key };
    const why = s.id !== n.id ? "archive key collision with a different session"
      : s.forkOf && !n.forkOf ? "fork parentage would be lost (parent transcript no longer available)"
      : old.receipt.generator.version !== archived.generator.version ? "generator version differs: recomputation must be explicit"
      : old.receipt.context.timeZone !== archived.context.timeZone ? "time zone differs from the archived receipt"
      : !(source.bytes > old.source.bytes) ? "different content for a transcript that has not grown"
      : (n.endedAt ?? "") < (s.endedAt ?? "") ? "new receipt ends before the archived one"
      : null;
    if (why) return { status: "conflict", key, reason: why };
    archivedAt = old.archivedAt;
  } else if (existing.status !== "missing") {
    return { status: "conflict", key, reason: `existing entry is ${existing.status} (${existing.reason}); left untouched` };
  }

  const entry: ArchiveEntry = { archiveSchemaVersion: ARCHIVE_SCHEMA_VERSION, key, archivedAt, updatedAt: now, contentHash: hash, source: { bytes: source.bytes, mtimeMs: source.mtimeMs }, receipt: archived };
  mkdirSync(dir, { recursive: true });
  atomicWrite(path, `${JSON.stringify(entry, null, 2)}\n`);
  return { status: existing.status === "ok" ? "updated" : "created", key };
}
