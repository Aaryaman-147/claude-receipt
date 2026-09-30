// M0 reference rules, verified against Claude Code 2.1.283 (see docs/research/M0_FINDINGS.md).
// Deliberately minimal: M1 ports these into source/claude-code with the same tests.
import { readFileSync } from "node:fs";

// Tolerant JSONL read. Claude Code appends whole lines, but a reader may still see a
// torn final line (crash, disk full, copy mid-write). Rules:
// - a final line that doesn't parse is dropped and reported as `truncatedTail`
// - an unparseable line in the middle is skipped and counted in `badLines`
// - a missing final newline on a *parseable* last line is fine
export function parseJsonl(text) {
  const lines = text.split("\n");
  const records = [];
  let badLines = 0, truncatedTail = false;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try { records.push(JSON.parse(line)); }
    catch { if (i === lines.length - 1) truncatedTail = true; else badLines++; }
  });
  return { records, badLines, truncatedTail };
}
export const readJsonl = (path) => parseJsonl(readFileSync(path, "utf8"));

// One API response is written as several `assistant` lines (one per content block) that
// repeat the same message.id, requestId and usage. Forks copy those lines into another
// file verbatim. The key is therefore message.id; fallbacks cover records without one.
export const apiCallKey = (r) => r.message?.id ?? r.requestId ?? r.uuid;

export function dedupeApiCalls(records) {
  const calls = new Map();
  for (const r of records) {
    if (r.type !== "assistant" || !r.message?.usage) continue;
    calls.set(apiCallKey(r), { model: r.message.model, usage: r.message.usage, ts: r.timestamp });
  }
  return calls; // last line wins; M0 found usage identical across a message's lines
}

export function tokensByModel(calls) {
  const out = {};
  for (const { model, usage: u } of calls.values()) {
    if (model === "<synthetic>") continue; // client-generated placeholder, not an API call
    const t = (out[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 });
    t.input += u.input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    t.cacheRead += u.cache_read_input_tokens ?? 0;
    t.cacheWrite += u.cache_creation_input_tokens ?? 0;
    t.thinking += u.output_tokens_details?.thinking_tokens ?? 0;
  }
  return out;
}

const SYSTEM_TAGS = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|system-reminder)>/;

// A human prompt: something a person (or an SDK caller) asked Claude, not machinery.
// Returns "typed" | "sdk" | "slash" | null.
export function promptKind(r) {
  if (r.type !== "user" || r.isSidechain || r.isMeta) return null;
  const c = r.message?.content;
  const blocks = Array.isArray(c) ? c : [{ type: "text", text: c ?? "" }];
  if (blocks.some((b) => b.type === "tool_result")) return null;
  const text = blocks.find((b) => b.type === "text")?.text ?? "";
  if (r.promptSource === "typed" || r.promptSource === "sdk") return r.promptSource;
  if (r.promptSource) return null; // e.g. "system" (task notifications)
  if (/^\s*<command-message>/.test(text) && r.origin?.kind === "human") return "slash";
  // Slash-command, local-command and `!` shell records have no promptSource even in 2.1.283,
  // so they are recognised by their leading tag.
  if (SYSTEM_TAGS.test(text) || text.startsWith("[Request interrupted")) return null;
  // Remaining records without promptSource (older versions): plain text from the user.
  return text.trim() ? "typed" : null;
}

// cost-state is cumulative per session file: every process exit (including after --resume)
// appends a new record with running totals. The last one is the session total.
export const lastCostState = (records) => records.findLast((r) => r.type === "cost-state");

// Compare deduplicated transcript tokens (session file + its subagent files) with the last
// cost-state. Never throws and never blocks a receipt: returns findings.
//   info    = expected gap: cost-state also counts auxiliary calls that aren't written to the
//             transcript (observed in interactive sessions: extra Haiku model, extra main-model tokens)
//   warning = transcript exceeds cost-state, or a model appears only in the transcript:
//             double counting or a format change
const FIELDS = [["input", "inputTokens"], ["output", "outputTokens"], ["cacheRead", "cacheReadInputTokens"], ["cacheWrite", "cacheCreationInputTokens"], ["thinking", "thinkingTokens"]];
export function reconcile(ours, costState) {
  const findings = [];
  const theirs = costState.modelUsage ?? {};
  for (const model of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const a = ours[model], b = theirs[model];
    if (!a) { findings.push({ level: "info", model, reason: "only-in-cost-state" }); continue; }
    if (!b) { findings.push({ level: "warning", model, reason: "only-in-transcript" }); continue; }
    for (const [ours_, theirs_] of FIELDS) {
      const diff = a[ours_] - (b[theirs_] ?? 0);
      if (diff > 0) findings.push({ level: "warning", model, field: ours_, diff, reason: "transcript-exceeds-cost-state" });
      if (diff < 0) findings.push({ level: "info", model, field: ours_, diff, reason: "cost-state-exceeds-transcript" });
    }
  }
  return findings;
}
