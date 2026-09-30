// Development entry point, not the product CLI: parse local sessions, build Receipts (with
// read-only git), and archive every non-live one. Prints status counts only.
//
//   node src/dev/archive.ts --all              archive every local session
//   node src/dev/archive.ts <main.jsonl>...    archive these transcripts
//   --dir <path>  archive directory (default: $CLAUDE_RECEIPT_HOME/archive or ~/.claude-receipt/archive)
//   --no-git      skip git enrichment
import { buildReceipt } from "../analytics/index.ts";
import { archiveDir, fingerprintOf, listArchive, writeReceipt } from "../archive/index.ts";
import { gitFacts } from "../git/index.ts";
import { loadProject, loadSessions, projectDirs, refForFile, type Session } from "../source/claude-code/index.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const noGit = flag("--no-git");
const dirAt = args.indexOf("--dir");
const dir = dirAt >= 0 ? args.splice(dirAt, 2)[1]! : archiveDir();

let sessions: Session[];
if (args[0] === "--all") {
  sessions = [];
  for (const d of projectDirs()) sessions.push(...(await loadProject(d)));
} else if (args.length) {
  sessions = await loadSessions(args.map(refForFile));
} else {
  console.error("usage: node src/dev/archive.ts (--all | <main.jsonl>...) [--dir <path>] [--no-git]");
  process.exit(2);
}

const counts: Record<string, number> = {};
const reasons: Record<string, number> = {};
for (const s of sessions) {
  const receipt = buildReceipt(s, noGit ? {} : { git: gitFacts(s.project.cwd, s.startedAt, s.endedAt) });
  const r = writeReceipt(receipt, fingerprintOf(s), { dir });
  counts[r.status] = (counts[r.status] ?? 0) + 1;
  if ("reason" in r) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
}
const { entries, problems } = listArchive(dir);
console.log(JSON.stringify({ sessions: sessions.length, results: counts, reasons, archived: entries.length, problems: problems.map((p) => `${p.status}: ${p.reason}`) }, null, 1));
