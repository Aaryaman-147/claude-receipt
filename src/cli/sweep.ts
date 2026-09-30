// The archive sweep and candidate pool behind every CLI run (docs/ARCHITECTURE.md §6).
// Glue only: discovery and parsing (source), analytics, git and the archive do the work.
//
// Strategy: a project directory is skipped without parsing when every session in it matches its
// archived fingerprint and none is live. Otherwise the whole project is parsed (fork detection
// needs every sibling), but Receipts (and git calls) are built only for sessions that changed;
// unchanged ones reuse their archived Receipt. Sessions whose transcript is gone come from the
// archive alone.
import { statSync } from "node:fs";
import { buildReceipt } from "../analytics/index.ts";
import { contentHash, fingerprintOf, listArchive, writeReceipt, type ArchiveEntry, type WriteResult } from "../archive/index.ts";
import { gitFacts } from "../git/index.ts";
import type { Receipt } from "../receipt/types.ts";
import { liveSessionIds, loadSessions, projectDirs, refsInProject, type SessionRef } from "../source/claude-code/index.ts";

export interface Candidate {
  receipt: Receipt;
  origin: "transcript" | "archive"; // built now from the transcript, or read from the archive
  transcript: boolean; // does the transcript still exist?
  projectDir: string | null; // where to re-parse it (for a fresh receipt with its title)
  // what happened to it in this sweep; "differs" = the archive keeps an earlier version of this
  // receipt (same transcript, recomputed differently, e.g. by a newer generator)
  archive: WriteResult["status"] | "skipped" | "not-written" | "differs";
}

export interface SweepReport {
  projectsParsed: number;
  projectsSkipped: number;
  results: Partial<Record<WriteResult["status"] | "skipped" | "not-written", number>>;
  conflicts: { id: string; reason: string }[];
  rejected: { id: string; reason: string }[]; // other than live sessions (those are expected)
  errors: string[];
  archiveProblems: { status: string; reason: string }[];
}

export interface SweepOptions {
  claudeHome: string;
  archiveDir: string;
  write: boolean; // false = read-only run (--no-archive)
  timeZone?: string;
  now?: Date;
}

const fingerprint = (ref: SessionRef): ArchiveEntry["source"] => {
  const stats = [ref.mainFile, ...ref.subagentFiles].map((f) => statSync(f));
  return { bytes: stats.reduce((n, s) => n + s.size, 0), mtimeMs: Math.max(...stats.map((s) => s.mtimeMs)) };
};

const message = (e: unknown) => {
  const err = e as NodeJS.ErrnoException;
  return err.code ? `${err.code}${err.path ? ` (${err.path})` : ""}` : String(err.message ?? e);
};

export async function sweep(opts: SweepOptions): Promise<{ candidates: Map<string, Candidate>; report: SweepReport }> {
  const report: SweepReport = { projectsParsed: 0, projectsSkipped: 0, results: {}, conflicts: [], rejected: [], errors: [], archiveProblems: [] };
  const count = (k: keyof SweepReport["results"]) => { report.results[k] = (report.results[k] ?? 0) + 1; };
  const candidates = new Map<string, Candidate>();
  const live = liveSessionIds(opts.claudeHome);
  let archive: ReturnType<typeof listArchive> = { entries: [], problems: [] };
  try { archive = listArchive(opts.archiveDir); }
  catch (e) { report.errors.push(`archive not readable: ${message(e)}`); } // e.g. a file where the directory should be
  report.archiveProblems = archive.problems.map((p) => ({ status: p.status, reason: p.reason }));
  const archived = new Map(archive.entries.map((e) => [e.receipt.session.id, e]));
  let writeBroken: string | null = null;

  for (const dir of projectDirs(opts.claudeHome)) {
    let refs: SessionRef[];
    const prints = new Map<string, ArchiveEntry["source"]>();
    try {
      refs = refsInProject(dir);
      for (const r of refs) prints.set(r.sessionId, fingerprint(r));
    } catch (e) { report.errors.push(`cannot read project directory: ${message(e)}`); continue; }
    const unchanged = (id: string) => {
      const e = archived.get(id), p = prints.get(id);
      return !live.has(id) && !!e && !!p && e.source.bytes === p.bytes && e.source.mtimeMs === p.mtimeMs;
    };
    const fromArchive = (id: string) =>
      candidates.set(id, { receipt: archived.get(id)!.receipt, origin: "archive", transcript: true, projectDir: dir, archive: "skipped" });

    if (refs.every((r) => unchanged(r.sessionId))) {
      report.projectsSkipped++;
      for (const r of refs) { fromArchive(r.sessionId); count("skipped"); }
      continue;
    }
    let sessions;
    try { sessions = await loadSessions(refs, { live }); }
    catch (e) { report.errors.push(`cannot parse project: ${message(e)}`); continue; }
    report.projectsParsed++;

    for (const s of sessions) {
      if (unchanged(s.id)) { fromArchive(s.id); count("skipped"); continue; }
      const receipt = buildReceipt(s, {
        git: gitFacts(s.project.cwd, s.startedAt, s.endedAt),
        ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
      let status: Candidate["archive"] = "not-written";
      if (opts.write && !writeBroken) {
        try {
          const r = writeReceipt(receipt, fingerprintOf(s), { dir: opts.archiveDir });
          status = r.status;
          if (r.status === "conflict") report.conflicts.push({ id: s.id, reason: r.reason });
          if (r.status === "rejected" && !receipt.session.live) report.rejected.push({ id: s.id, reason: r.reason });
        } catch (e) {
          writeBroken = message(e); // e.g. EACCES: stop writing, keep going read-only
          report.errors.push(`archive not writable: ${writeBroken}`);
        }
      }
      count(status);
      candidates.set(s.id, { receipt, origin: "transcript", transcript: true, projectDir: dir, archive: status });
    }
  }

  // History whose transcripts Claude Code has already cleaned up.
  for (const [id, e] of archived) {
    if (!candidates.has(id)) candidates.set(id, { receipt: e.receipt, origin: "archive", transcript: false, projectDir: null, archive: "skipped" });
  }
  return { candidates, report };
}

// A fresh receipt (with its title) for a candidate whose transcript still exists.
export async function refresh(c: Candidate, opts: Pick<SweepOptions, "claudeHome" | "timeZone" | "now">): Promise<Candidate> {
  if (c.origin === "transcript" || !c.projectDir) return c;
  const sessions = await loadSessions(refsInProject(c.projectDir), { live: liveSessionIds(opts.claudeHome) });
  const s = sessions.find((x) => x.id === c.receipt.session.id);
  if (!s) return c;
  const receipt = buildReceipt(s, {
    git: gitFacts(s.project.cwd, s.startedAt, s.endedAt),
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const archivedHash = contentHash({ ...c.receipt, session: { ...c.receipt.session, title: null } });
  const differs = contentHash({ ...receipt, session: { ...receipt.session, title: null } }) !== archivedHash;
  return { ...c, receipt, origin: "transcript", archive: differs ? "differs" : c.archive };
}
