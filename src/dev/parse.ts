// Development entry point, not the product CLI: parse sessions and print the normalized
// Session JSON. `--summary` prints counts only and is the safe mode for real sessions.
//
//   node src/dev/parse.ts <main.jsonl>...        parse files together (forks detected among them)
//   node src/dev/parse.ts --session <id|prefix>  one local session (its project parsed for forks)
//   node src/dev/parse.ts --all                  every local session
//   add --summary to print counts instead of full Session JSON
import { findSession, loadProject, loadSessions, projectDirs, refForFile, type Session } from "../source/claude-code/index.ts";

const args = process.argv.slice(2);
const summaryMode = args.includes("--summary");
const rest = args.filter((a) => a !== "--summary");

let sessions: Session[];
if (rest[0] === "--session" && rest[1]) {
  const s = await findSession(rest[1]);
  if (!s) { console.error(`no session matches ${rest[1]}`); process.exit(1); }
  sessions = [s];
} else if (rest[0] === "--all") {
  sessions = [];
  for (const dir of projectDirs()) sessions.push(...(await loadProject(dir)));
} else if (rest.length) {
  sessions = await loadSessions(rest.map(refForFile));
} else {
  console.error("usage: node src/dev/parse.ts (<main.jsonl>... | --session <id> | --all) [--summary]");
  process.exit(2);
}

const summary = (s: Session) => ({
  id: s.id.slice(0, 8),
  entrypoint: s.entrypoint,
  versions: s.source.clientVersions,
  status: s.status,
  fork: s.fork && { parent: s.fork.parentSessionId.slice(0, 8), inheritedApiCalls: s.fork.inheritedApiCalls },
  runs: s.runs.map((r) => (r.closed ? "closed" : "open")),
  prompts: s.prompts.length,
  apiCalls: s.apiCalls.length,
  models: [...new Set(s.apiCalls.map((c) => c.model))],
  toolCalls: s.toolCalls.length,
  fileOps: s.toolCalls.filter((t) => t.file).length,
  commands: s.toolCalls.filter((t) => t.command).length,
  subagents: s.subagents.length,
  reconciliation: s.reconciliation && Object.fromEntries(["info", "warning"].map((l) => [l, s.reconciliation!.filter((f) => f.level === l).length])),
  warnings: s.warnings.map((w) => `${w.code} x${w.count}`),
});

console.log(JSON.stringify(summaryMode ? sessions.map(summary) : sessions.length === 1 ? sessions[0] : sessions, null, 1));
