// Development entry point, not the product CLI: parse sessions, run read-only git
// enrichment and analytics, print Receipt JSON.
//
//   node src/dev/receipt.ts <main.jsonl>...        receipts for these transcripts (forks detected among them)
//   node src/dev/receipt.ts --session <id|prefix>  one local session
//   node src/dev/receipt.ts --all                  every local session
//   --summary   per metric: provenance and whether it's null (no values: safe for real sessions)
//   --no-git    skip git enrichment
//   --tz <zone> time zone for local-time metrics (default: system)
import { buildReceipt } from "../analytics/index.ts";
import { gitFacts } from "../git/index.ts";
import { validateReceipt } from "../receipt/validate.ts";
import { renderJson } from "../render/json.ts";
import { findSession, loadProject, loadSessions, projectDirs, refForFile, type Session } from "../source/claude-code/index.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const summaryMode = flag("--summary");
const noGit = flag("--no-git");
const tzAt = args.indexOf("--tz");
const timeZone = tzAt >= 0 ? args.splice(tzAt, 2)[1] : undefined;

let sessions: Session[];
if (args[0] === "--session" && args[1]) {
  const s = await findSession(args[1]);
  if (!s) { console.error(`no session matches ${args[1]}`); process.exit(1); }
  sessions = [s];
} else if (args[0] === "--all") {
  sessions = [];
  for (const dir of projectDirs()) sessions.push(...(await loadProject(dir)));
} else if (args.length) {
  sessions = await loadSessions(args.map(refForFile));
} else {
  console.error("usage: node src/dev/receipt.ts (<main.jsonl>... | --session <id> | --all) [--summary] [--no-git] [--tz <zone>]");
  process.exit(2);
}

const receipts = sessions.map((s) => buildReceipt(s, {
  ...(noGit ? {} : { git: gitFacts(s.project.cwd, s.startedAt, s.endedAt) }),
  ...(timeZone ? { timeZone } : {}),
}));
const invalid = receipts.flatMap((r) => validateReceipt(r).map((e) => `${r.session.id.slice(0, 8)}: ${e}`));
if (invalid.length) console.error(`schema problems:\n${invalid.join("\n")}`);

if (summaryMode) {
  console.log(JSON.stringify(receipts.map((r) => ({
    id: r.session.id.slice(0, 8),
    entrypoint: r.session.entrypoint,
    complete: r.session.complete,
    fork: r.session.forkOf !== null,
    metrics: Object.fromEntries(Object.values(r.sections).flat().map((m) => [m.id, `${m.provenance}${m.value === null ? ` null: ${m.unavailableReason}` : ""}`])),
    warnings: r.warnings.map((w) => w.code),
  })), null, 1));
} else {
  process.stdout.write(renderJson(receipts.length === 1 ? receipts[0]! : receipts));
}
