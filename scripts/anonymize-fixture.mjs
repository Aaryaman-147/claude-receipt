// Allowlist anonymizer for Claude Code transcripts. Fails closed: any string not
// explicitly recognised as safe is replaced by "x" characters of the same length
// (newlines kept, so line counts and prompt lengths survive).
//
// Usage: node scripts/anonymize-fixture.mjs <out-dir> <in.jsonl>...
// All inputs of one run share an id/path map, so cross-file links (forks, subagents) survive.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";

// Enum fields: only these exact values survive (observed in 2.1.283 or documented API enums).
// A new value is blanked, which fails closed; add it here after checking it's harmless.
const ENUMS = Object.fromEntries(Object.entries({
  role: "user assistant",
  stop_reason: "end_turn tool_use max_tokens stop_sequence pause_turn refusal",
  entrypoint: "cli sdk-cli sdk-ts sdk-py",
  userType: "external",
  permissionMode: "default auto plan acceptEdits bypassPermissions dontAsk",
  promptSource: "typed sdk system",
  turnOrigin: "human sdk task_notification",
  kind: "human task-notification",
  service_tier: "standard priority batch",
  speed: "standard fast",
  level: "info warning error",
  operation: "enqueue dequeue",
  mode: "normal content",
  status: "async_launched completed failed",
  agentType: "general-purpose Explore Plan",
  subagent_type: "general-purpose Explore Plan",
  requestShape: "background foreground",
  inference_geo: "not_available",
  provider: "firstParty",
  costBasis: "list",
  subtype: "turn_duration local_command away_summary compact_boundary api_error informational",
}).map(([k, v]) => [k, new Set(v.split(" "))]));
// `type` is the record/block discriminator; unknown values must survive (unknown-record tests),
// so it keeps an identifier shape instead of a fixed list.
const TYPE_VALUE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const VERSION_VALUE = /^\d+\.\d+\.\d+$/;
const MODEL_VALUE = /^(claude-[a-z0-9.-]+|<synthetic>|haiku|sonnet|opus|fable|inherit)$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ID_KEYS = new Set([
  "uuid", "parentUuid", "logicalParentUuid", "sessionId", "session_id", "leafUuid", "messageId", "promptId", "requestId",
  "id", "tool_use_id", "toolUseId", "sourceToolUseID", "sourceToolAssistantUUID", "agentId",
]);
const PATH_KEYS = new Set(["file_path", "filePath", "path", "notebook_path", "outputFile", "project"]);
const KNOWN_TOOLS = new Set([
  "Bash", "PowerShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "Agent", "Task",
  "Skill", "WebFetch", "WebSearch", "TodoWrite", "ToolSearch", "AskUserQuestion", "ExitPlanMode",
]);
// Programs whose name (and a safe subcommand) may be kept when a Bash command is replaced.
const SAFE_PROGRAMS = new Set(["echo", "ls", "cat", "git", "npm", "pnpm", "yarn", "npx", "node", "python", "pytest", "go", "cargo", "make", "grep", "find", "cd", "mkdir", "rm"]);
const SAFE_SUBCOMMANDS = new Set(["commit", "status", "diff", "log", "push", "add", "test", "run", "install", "build"]);
const SYSTEM_TAG = /^\s*(<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|system-reminder)>|\[Request interrupted)/;
const MODEL_KEY = /^(claude-[a-z0-9.-]+|<synthetic>)$/;
// ID-shaped strings (API message/tool-use/request ids, UUIDs, long hex such as agent ids) are
// mapped to stable fake ids wherever they appear: as values under any key, and as object keys
// (e.g. `wireToolInputs` is keyed by tool-use id). Structural keys are never ID-shaped.
const ID_SHAPE = /^((msg|toolu|req|srvtoolu)_[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;
const IDENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DROP_ATTACHMENTS = /credential|org|oauth|auth/i;

export const blank = (s) => s.replace(/[^\n]/g, "x");

export function createAnonymizer() {
  const ids = new Map(), paths = new Map(), cwds = new Map(), branches = new Map();
  const fakeBranch = (v) => {
    if (!branches.has(v)) branches.set(v, `branch-${branches.size + 1}`);
    return branches.get(v);
  };
  let n = 0;
  const fakeId = (v) => {
    if (!ids.has(v)) {
      n++;
      const hex = n.toString(16).padStart(12, "0");
      ids.set(v,
        /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) ? `00000000-0000-4000-8000-${hex}`
        : /^(msg|toolu|req|srvtoolu)_/.test(v) ? `${v.split("_")[0]}_fixture${hex}`
        : `a${hex}`);
    }
    return ids.get(v);
  };
  const fakeCwd = (v) => {
    if (!cwds.has(v)) cwds.set(v, `C:\\fixture\\project${cwds.size || ""}`);
    return cwds.get(v);
  };
  const fakePath = (v) => {
    if (!paths.has(v)) {
      const ext = extname(v).replace(/[^A-Za-z0-9.]/g, "").slice(0, 10);
      paths.set(v, `C:\\fixture\\project\\file${paths.size + 1}${ext}`);
    }
    return paths.get(v);
  };
  const command = (cmd) => {
    const words = String(cmd).replace(/^(\s*(\w+=\S*|cd\s+\S+\s*&&)\s*)+/, "").trim().split(/\s+/);
    const prog = basename(words[0] ?? "").replace(/\.exe$/i, "");
    if (!SAFE_PROGRAMS.has(prog)) return "cmd x";
    return SAFE_SUBCOMMANDS.has(words[1]) ? `${prog} ${words[1]} x` : `${prog} x`;
  };
  const text = (s) => {
    const tag = s.match(SYSTEM_TAG)?.[0] ?? "";
    return tag + blank(s.slice(tag.length));
  };

  function value(v, key, parent) {
    if (v === null || typeof v !== "object") {
      if (typeof v !== "string") return v;
      if (key === "timestamp" || key === "startedAt" || TIMESTAMP.test(v)) return TIMESTAMP.test(v) ? v : blank(v);
      if (ID_KEYS.has(key) || ID_SHAPE.test(v)) return fakeId(v);
      if (key === "cwd") return fakeCwd(v);
      if (key === "gitBranch") return v ? fakeBranch(v) : v;
      if (PATH_KEYS.has(key)) return fakePath(v);
      if (key === "command") return command(v);
      if (key === "name" && parent?.type === "tool_use") return KNOWN_TOOLS.has(v) ? v : v.startsWith("mcp__") ? "mcp__server__tool" : "UnknownTool";
      if (/model$/i.test(key)) return MODEL_VALUE.test(v) ? v : blank(v);
      if (key === "type" && TYPE_VALUE.test(v)) return v;
      if (key === "version" && VERSION_VALUE.test(v)) return v;
      if (ENUMS[key]?.has(v)) return v;
      return text(v);
    }
    if (Array.isArray(v)) {
      // structuredPatch lines: keep the +/-/space prefix, blank the body
      if (key === "lines") return v.map((l) => (typeof l === "string" ? l.slice(0, 1).replace(/[^+\- ]/, "x") + blank(l.slice(1)) : value(l, key, v)));
      return v.map((x) => value(x, key, v));
    }
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      let outKey = k;
      if (ID_SHAPE.test(k)) outKey = fakeId(k);
      else if (!IDENT_KEY.test(k) && !MODEL_KEY.test(k)) outKey = PATH_KEYS.has(key) || /[\\/]/.test(k) ? fakePath(k) : `key${Object.keys(out).length}`;
      out[outKey] = value(x, k, v);
    }
    return out;
  }

  function record(r) {
    if (r.type === "attachment") {
      // Payloads (and the `rendered` copy) are injected context we never use: keep the envelope only.
      if (DROP_ATTACHMENTS.test(r.attachment?.type ?? "")) return null;
      const keep = ["type", "uuid", "parentUuid", "sessionId", "agentId", "timestamp", "isSidechain", "cwd", "version", "entrypoint", "userType"];
      return value({ ...Object.fromEntries(keep.filter((k) => k in r).map((k) => [k, r[k]])), attachment: { type: r.attachment?.type } });
    }
    return value(r);
  }

  // Tolerant line handling: an unparseable line is replaced by blanked text of the same
  // length (so truncated-tail fixtures can be produced from anonymized content only).
  function jsonl(src) {
    return src.split("\n").map((line) => {
      if (!line.trim()) return line;
      try { const r = record(JSON.parse(line)); return r === null ? null : JSON.stringify(r); }
      catch { return blank(line); }
    }).filter((l) => l !== null).join("\n");
  }

  return { jsonl, record, value, fakeId, fakePath };
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const [outDir, ...inputs] = process.argv.slice(2);
  if (!outDir || !inputs.length) { console.error("usage: anonymize-fixture.mjs <out-dir> <in.jsonl>..."); process.exit(2); }
  const a = createAnonymizer();
  mkdirSync(outDir, { recursive: true });
  for (const f of inputs) writeFileSync(join(outDir, basename(f)), a.jsonl(readFileSync(f, "utf8")));
}
