// M0 probe over the real ~/.claude/projects tree. Prints metadata and numbers only:
// never prompt text, responses, commands or file contents.
// Usage: node scripts/m0/inspect.mjs
import { readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { readJsonl, dedupeApiCalls, tokensByModel, promptKind, lastCostState } from "./rules.mjs";

const root = join(homedir(), ".claude", "projects");
const report = { transcripts: [], pathEncoding: [], crossFileMessageIds: 0, sameIdDifferentUsage: 0, sameIdDifferentRequest: 0 };
const idOwners = new Map();

// Hypothesis under test: dir name = cwd with every char outside [A-Za-z0-9] replaced by "-".
const encode = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

for (const dir of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const dirPath = join(root, dir.name);
  for (const f of readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"))) {
    const sessionId = basename(f, ".jsonl");
    const main = readJsonl(join(dirPath, f));
    const subDir = join(dirPath, sessionId, "subagents");
    const subFiles = existsSync(subDir) ? readdirSync(subDir).filter((x) => x.endsWith(".jsonl")) : [];
    const subs = subFiles.map((x) => readJsonl(join(subDir, x)));
    const all = [main, ...subs].flatMap((p) => p.records);

    // duplicate-line consistency within a message id
    const seen = new Map();
    for (const r of all.filter((r) => r.type === "assistant" && r.message?.id)) {
      const prev = seen.get(r.message.id);
      if (prev && prev.u !== JSON.stringify(r.message.usage)) report.sameIdDifferentUsage++;
      if (prev && prev.req !== r.requestId) report.sameIdDifferentRequest++;
      seen.set(r.message.id, { u: JSON.stringify(r.message.usage), req: r.requestId });
      const owners = idOwners.get(r.message.id) ?? new Set();
      owners.add(sessionId); idOwners.set(r.message.id, owners);
    }

    const cwd = all.find((r) => r.cwd)?.cwd;
    if (cwd) report.pathEncoding.push({ dirLen: dir.name.length, cwdLen: cwd.length, matchesRule: encode(cwd) === dir.name });

    const assistantLines = all.filter((r) => r.type === "assistant").length;
    const calls = dedupeApiCalls(all);
    const ours = tokensByModel(calls);
    const cs = lastCostState(main.records);
    const prompts = {};
    for (const r of main.records) { const k = promptKind(r); if (k) prompts[k] = (prompts[k] ?? 0) + 1; }

    // lines from Edit/Write patches vs cost-state
    let added = 0, removed = 0;
    for (const r of main.records) {
      const t = r.toolUseResult;
      if (!t || typeof t !== "object" || !Array.isArray(t.structuredPatch)) continue;
      if (t.type === "create") { added += (t.content ?? "").split("\n").length - ((t.content ?? "").endsWith("\n") ? 1 : 0); continue; }
      for (const h of t.structuredPatch) for (const l of h.lines) { if (l[0] === "+") added++; else if (l[0] === "-") removed++; }
    }

    let reconciliation = null;
    if (cs) {
      reconciliation = {};
      for (const m of new Set([...Object.keys(ours), ...Object.keys(cs.modelUsage)])) {
        const a = ours[m], b = cs.modelUsage[m];
        reconciliation[m] = !a ? "only-in-cost-state" : !b ? "only-in-transcript"
          : { input: a.input - b.inputTokens, output: a.output - b.outputTokens, cacheRead: a.cacheRead - b.cacheReadInputTokens,
              cacheWrite: a.cacheWrite - b.cacheCreationInputTokens, thinking: a.thinking - (b.thinkingTokens ?? 0) };
      }
    }
    report.transcripts.push({
      session: sessionId.slice(0, 8), versions: [...new Set(all.map((r) => r.version).filter(Boolean))],
      lines: main.records.length, subagentFiles: subFiles.length, truncatedTail: main.truncatedTail, badLines: main.badLines,
      prompts, assistantLines, apiCalls: calls.size, models: Object.keys(ours),
      costStates: main.records.filter((r) => r.type === "cost-state").length,
      linesFromPatches: { added, removed }, linesCostState: cs ? { added: cs.totalLinesAdded, removed: cs.totalLinesRemoved } : null,
      reconciliation,
    });
  }
}
report.crossFileMessageIds = [...idOwners.values()].filter((s) => s.size > 1).length;
console.log(JSON.stringify(report, null, 1));
