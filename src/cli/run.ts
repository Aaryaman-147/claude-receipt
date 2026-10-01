// The claude-receipt command (docs/PRD.md §5.4). Glue only: sweep → select → render.
// Testable: all I/O goes through `io`. stdout carries only the requested output (a receipt,
// a list, JSON, or the path of an exported file); notes, archive status and problems go to stderr.
import { aggregate } from "../aggregate/index.ts";
import type { Period } from "../aggregate/types.ts";
import { validateHistory } from "../aggregate/validate.ts";
import { archiveDir } from "../archive/index.ts";
import { redactHistory, redactReceipt } from "../receipt/redact.ts";
import { GENERATOR, type Receipt } from "../receipt/types.ts";
import { duration, fit, localTime, MARK, PERIOD_LABELS } from "../render/format.ts";
import { renderJson } from "../render/json.ts";
import { renderTerminal, renderViewTerminal } from "../render/tty.ts";
import { historyView } from "../render/view.ts";
import { claudeHome, projectKey } from "../source/claude-code/index.ts";
import { exportHistory, exportReceipt } from "./export.ts";
import { refresh, sweep, type Candidate, type SweepReport } from "./sweep.ts";

export interface Io {
  stdout(s: string): void;
  stderr(s: string): void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  columns?: number;
  timeZone?: string; // default: the system zone
  now?: Date;
}

export const USAGE = `usage: claude-receipt [<session-id-prefix> | last | list | all | week | month] [options]
       claude-receipt export [<session-id-prefix> | last] [--png | --svg] [-o <file>] [--no-redact]
       claude-receipt export all | week | month [--project] [--png | --svg] [-o <file>] [--no-redact]

  (no command)   receipt for the current or most recent session in this
                 directory, else the most recent session anywhere
  last           receipt for the most recent completed session anywhere
  list           recent sessions, newest first
  all            history: every finished session Claude Receipt knows about
  week | month   history: sessions started in the last 7 / 30 local calendar
                 days, today included
  <prefix>       receipt for the session whose id starts with <prefix>
  export         write that receipt (or with all/week/month, that history) as
                 an image file; PNG by default, redacted by default, never
                 overwrites a file

options:
  --json         machine-readable output (the Receipt JSON contract)
  --redact       hide project, paths, title; shorten ids (for sharing)
  --no-archive   read-only: don't write to the local archive
  --limit <n>    rows for list (default 20)
  --project      all/week/month (and their export): only this directory's project
  --png, --svg   export: image format (default --png)
  -o, --output <file>
                 export: file to create (default ./claude-receipt-<id>.png)
  --no-redact    export: keep project, title and file names in the image
  -h, --help     this help
  -v, --version  version

Every run archives finished sessions to ~/.claude-receipt/archive
(or $CLAUDE_RECEIPT_HOME/archive). Claude Code data is read from
~/.claude (or $CLAUDE_CONFIG_DIR). Nothing leaves this machine.
`;

interface Args {
  command: "receipt" | "last" | "list"; prefix: string | null; json: boolean; redact: boolean; write: boolean; limit: number;
  export: { format: "png" | "svg"; output: string | null; redact: boolean } | null;
  history: Period | null; project: boolean;
}

const PERIODS: readonly string[] = ["all", "week", "month"];

function parse(argv: string[]): Args | { exit: number; out?: string; err?: string } {
  const a: Args = { command: "receipt", prefix: null, json: false, redact: false, write: true, limit: 20, export: null, history: null, project: false };
  let format: "png" | "svg" | null = null, output: string | null = null, noRedact = false;
  const usage = (msg: string) => ({ exit: 2, err: `${msg}\n\n${USAGE}` });
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === "-h" || x === "--help") return { exit: 0, out: USAGE };
    if (x === "-v" || x === "--version") return { exit: 0, out: `${GENERATOR.name} ${GENERATOR.version}\n` };
    if (x === "--json") a.json = true;
    else if (x === "--redact") a.redact = true;
    else if (x === "--no-archive") a.write = false;
    else if (x === "--no-redact") noRedact = true;
    else if (x === "--project") a.project = true;
    else if (x === "--png" || x === "--svg") {
      if (format && format !== x.slice(2)) return usage("choose one of --png or --svg");
      format = x.slice(2) as "png" | "svg";
    } else if (x === "-o" || x === "--output") {
      const v = argv[++i];
      if (!v || output !== null) return usage(`${x} needs one file path`);
      output = v;
    } else if (x === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) return { exit: 2, err: `--limit needs a positive whole number\n\n${USAGE}` };
      a.limit = n;
    } else if (x.startsWith("-")) return { exit: 2, err: `unknown option ${x}\n\n${USAGE}` };
    else positional.push(x);
  }
  const isExport = positional[0] === "export";
  if (isExport) positional.shift();
  if (positional.length > 1) return { exit: 2, err: `expected at most one command or session id, got ${positional.length}\n\n${USAGE}` };
  const p = positional[0];
  if (isExport) {
    if (p === "list" || p === "export") return usage(`export takes "last" or a session id prefix, not "${p}"`);
    if (a.json) return usage("--json does not apply to export");
    if (a.redact && noRedact) return usage("choose one of --redact or --no-redact");
    a.export = { format: format ?? "png", output, redact: !noRedact };
  } else if (format || output !== null || noRedact) return usage("--png, --svg, --output and --no-redact only apply to export");
  if (p !== undefined && PERIODS.includes(p)) a.history = p as Period; // also after export: a history image
  else if (a.project) return usage("--project only applies to all, week and month");
  if (a.history) return argv.includes("--limit") ? { exit: 2, err: `--limit only applies to list\n\n${USAGE}` } : a;
  if (p === "last" || p === "list") a.command = p;
  else if (p !== undefined) a.prefix = p;
  if (a.command !== "list" && argv.includes("--limit")) return { exit: 2, err: `--limit only applies to list\n\n${USAGE}` };
  return a;
}

// Most recent first: latest activity (endedAt; a resumed session counts from its last run),
// then latest start, then id, so the order never depends on the filesystem.
const recency = (c: Candidate) => c.receipt.session.endedAt ?? c.receipt.session.startedAt ?? "";
const newestFirst = (a: Candidate, b: Candidate) =>
  recency(b).localeCompare(recency(a))
  || (b.receipt.session.startedAt ?? "").localeCompare(a.receipt.session.startedAt ?? "")
  || a.receipt.session.id.localeCompare(b.receipt.session.id);

// list rows are not Receipts: plain semantic JSON, no presentation
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

const ARCHIVE_NOTE: Record<Candidate["archive"], string> = {
  created: "saved to the local archive",
  updated: "updated in the local archive",
  unchanged: "already in the local archive",
  skipped: "already in the local archive",
  conflict: "not archived: the archive keeps an earlier version (conflict)",
  rejected: "not archived",
  "not-written": "not archived",
  differs: "the local archive keeps an earlier version of this receipt",
};

function reportProblems(report: SweepReport, io: Io) {
  const lines = [
    ...report.conflicts.map((c) => `archive conflict for ${c.id.slice(0, 8)}: ${c.reason} (existing entry kept)`),
    ...report.rejected.map((r) => `not archived ${r.id.slice(0, 8)}: ${r.reason}`),
    ...report.archiveProblems.map((p) => `unreadable archive entry (${p.status}): ${p.reason} (left untouched)`),
    ...report.errors,
  ];
  for (const l of lines.slice(0, 5)) io.stderr(`claude-receipt: ${l}\n`);
  if (lines.length > 5) io.stderr(`claude-receipt: ...and ${lines.length - 5} more\n`);
}

function listRows(cands: Candidate[], args: Args, io: Io) {
  const tz = io.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rows = cands.map((c) => {
    const r = args.redact ? redactReceipt(c.receipt) : c.receipt;
    const wall = r.sections.hard.find((m) => m.id === "session.duration.wall")!;
    return { c, r, wall };
  });
  if (args.json) {
    io.stdout(json(rows.map(({ c, r, wall }) => ({
      id: r.session.id, project: r.session.project, projectKey: r.session.projectKey, entrypoint: r.session.entrypoint,
      startedAt: r.session.startedAt, endedAt: r.session.endedAt,
      duration: { value: wall.value, provenance: wall.provenance, unit: "ms" },
      live: r.session.live, complete: r.session.complete, transcript: c.transcript,
      archived: c.origin === "archive" || ["created", "updated", "unchanged", "skipped"].includes(c.archive),
    }))));
    return;
  }
  const head = `${"WHEN".padEnd(17)}${"SESSION".padEnd(10)}${"PROJECT".padEnd(21)}${"DURATION".padEnd(11)}STATE`;
  const body = rows.map(({ c, r, wall }) => {
    const s = r.session;
    const when = s.startedAt ? localTime(s.startedAt, tz) : "-";
    const dur = wall.value === null ? "-" : `${duration(wall.value as number)}${MARK.derived}`;
    const state = s.live ? "live" : !c.transcript ? "archived" : s.complete ? "complete" : "incomplete";
    return `${when.padEnd(17)}${s.id.slice(0, 8).padEnd(10)}${fit(s.project ?? "-", 19).padEnd(21)}${dur.padEnd(11)}${state}`;
  });
  io.stdout(`${[head, ...body, "", `times: ${tz}.${rows.some((x) => x.wall.value !== null) ? " * computed from recorded data." : ""}`].join("\n")}\n`);
}

// all / week / month (v0.2): the sweep's candidate pool (archived and freshly built Receipts, one
// per session id) aggregated into a HistoryReceipt. --no-archive only stops archive writes.
// `export all|week|month` writes the same history as an image: redacted unless --no-redact.
async function history(period: Period, pool: Candidate[], args: Args, io: Io): Promise<number> {
  const timeZone = io.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const key = args.project ? projectKey(io.cwd) : null; // the same key v0.1 groups sessions by
  let h = aggregate(pool.map((c) => c.receipt), { period, now: io.now ?? new Date(), timeZone, projectKey: key });
  const redact = args.export ? args.export.redact : args.redact;
  if (redact) h = redactHistory(h);
  const problems = validateHistory(h);
  if (problems.length) { io.stderr(`claude-receipt: internal error: invalid history (${problems.slice(0, 3).join("; ")})\n`); return 1; }
  const where = `${period === "all" ? "" : ` in the ${PERIOD_LABELS[period].toLowerCase()}`}${args.project ? " for this directory's project" : ""}`;
  if (h.coverage.sessions === 0) {
    const excluded = [h.coverage.liveExcluded && `${h.coverage.liveExcluded} still running`, h.coverage.undated && period !== "all" && `${h.coverage.undated} undated`].filter(Boolean);
    io.stderr(`claude-receipt: no finished sessions${where}${excluded.length ? ` (${excluded.join(", ")})` : ""}\n`);
    return 1;
  }
  const summary = `${h.coverage.sessions} finished session${h.coverage.sessions === 1 ? "" : "s"}${where}${args.write ? "" : "; nothing archived (--no-archive)"}`;
  if (args.export) {
    const result = await exportHistory(h, { format: args.export.format, output: args.export.output, cwd: io.cwd });
    if ("error" in result) { io.stderr(`claude-receipt: ${result.error}\n`); return 1; }
    io.stdout(`${result.path}\n`);
    io.stderr(`claude-receipt: history exported${redact ? "" : " without redaction"}: ${summary}\n`);
    return 0;
  }
  if (args.json) io.stdout(renderJson(h));
  else io.stdout(renderViewTerminal(historyView(h), { width: io.isTTY && io.columns ? io.columns : 40, color: io.isTTY && !io.env.NO_COLOR }));
  io.stderr(`claude-receipt: ${summary}\n`);
  return 0;
}

export async function run(argv: string[], io: Io): Promise<number> {
  const args = parse(argv);
  if ("exit" in args) {
    if (args.out) io.stdout(args.out);
    if (args.err) io.stderr(`claude-receipt: ${args.err}`);
    return args.exit;
  }
  const home = claudeHome(io.env);
  const opts = { claudeHome: home, archiveDir: archiveDir(io.env), write: args.write, ...(io.timeZone ? { timeZone: io.timeZone } : {}), ...(io.now ? { now: io.now } : {}) };
  const { candidates, report } = await sweep(opts);
  reportProblems(report, io);
  const all = [...candidates.values()].sort(newestFirst);

  if (args.history) return await history(args.history, all, args, io);

  if (args.command === "list") {
    if (!all.length) { io.stderr("claude-receipt: no sessions found\n"); if (args.json) io.stdout(json([])); return 0; }
    listRows(all.slice(0, args.limit), args, io);
    return 0;
  }

  if (!all.length) { io.stderr(`claude-receipt: no Claude Code sessions found (looked in ${home})\n`); return 1; }
  let pick: Candidate | undefined;
  if (args.prefix !== null) {
    const hits = all.filter((c) => c.receipt.session.id.startsWith(args.prefix!));
    if (hits.length > 1) {
      io.stderr(`claude-receipt: "${args.prefix}" matches ${hits.length} sessions (${hits.slice(0, 5).map((c) => c.receipt.session.id.slice(0, 8)).join(", ")}${hits.length > 5 ? ", ..." : ""}); use a longer prefix\n`);
      return 1;
    }
    pick = hits[0];
    if (!pick) { io.stderr(`claude-receipt: no session matches "${args.prefix}"\n`); return 1; }
  } else if (args.command === "last") {
    pick = all.find((c) => c.receipt.session.complete && !c.receipt.session.live);
    if (!pick) { io.stderr("claude-receipt: no completed session found\n"); return 1; }
  } else {
    const here = projectKey(io.cwd);
    const withTime = all.filter((c) => recency(c) !== "");
    pick = withTime.find((c) => c.receipt.session.projectKey === here) ?? withTime[0] ?? all[0];
  }

  pick = await refresh(pick!, opts); // a fresh receipt (with its title) when the transcript still exists
  const s = pick.receipt.session;
  const note = s.live ? "not archived: the session is still running"
    : !pick.transcript ? "from the local archive (the transcript is no longer on disk)"
    : !args.write ? "not archived (--no-archive)"
    : ARCHIVE_NOTE[pick.archive];

  if (args.export) {
    // Redaction happens here, before layout: the visual renderer never knows whether it ran.
    const { redact, format, output } = args.export;
    const result = await exportReceipt(redact ? redactReceipt(pick.receipt) : pick.receipt, { format, output, cwd: io.cwd });
    if ("error" in result) { io.stderr(`claude-receipt: ${result.error}\n`); return 1; }
    io.stdout(`${result.path}\n`);
    io.stderr(`claude-receipt: ${s.id.slice(0, redact ? 4 : 8)} exported${redact ? "" : " without redaction"}${s.live ? " (a snapshot: the session is still running)" : ""}; ${note}\n`);
    return 0;
  }

  const receipt: Receipt = args.redact ? redactReceipt(pick.receipt) : pick.receipt;
  if (args.json) io.stdout(renderJson(receipt));
  else io.stdout(renderTerminal(receipt, { width: io.isTTY && io.columns ? io.columns : 40, color: io.isTTY && !io.env.NO_COLOR }));
  io.stderr(`claude-receipt: ${s.id.slice(0, args.redact ? 4 : 8)} ${note}\n`);
  return 0;
}
