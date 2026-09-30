// Rebuilds fixtures/claude-code/2.1.283 from the throwaway M0 lab sessions (headless
// `claude -p` runs in a scratch directory, see docs/research/M0_FINDINGS.md).
// Only runs on the machine that has those sessions; the committed fixtures are the output.
// Usage: node scripts/m0/build-fixtures.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createAnonymizer, blank } from "../anonymize-fixture.mjs";

const projects = join(homedir(), ".claude", "projects");
const lab = join(projects, readdirSync(projects).find((d) => d.endsWith("Proj-Dots-und--")));
const S1 = "11111111-0000-4000-8000-000000000001"; // write/edit/bash, then --resume, then --continue
const S2 = "22222222-0000-4000-8000-000000000002"; // one subagent
const S3 = "33333333-0000-4000-8000-000000000003"; // no tools, >200-char cwd
const S4 = "44444444-0000-4000-8000-000000000004"; // killed mid-response
const S5 = "55555555-0000-4000-8000-000000000005"; // Write update + Edit replace_all
const fork = readdirSync(lab).find((f) => f.endsWith(".jsonl") && ![S1, S2, S4, S5].some((s) => f.startsWith(s)));

const out = join("fixtures", "claude-code", "2.1.283");
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) rmSync(join(out, f), { recursive: true, force: true });
const a = createAnonymizer();
const read = (...p) => readFileSync(join(lab, ...p), "utf8");
const write = (name, text) => { mkdirSync(join(out, name, ".."), { recursive: true }); writeFileSync(join(out, name), text); };

// resumed: the whole S1 file (3 runs, 3 cumulative cost-states)
const resumed = a.jsonl(read(`${S1}.jsonl`));
write("resumed.jsonl", resumed);
// ordinary: S1 up to and including its first cost-state (the first run only)
const lines = resumed.split("\n");
const firstCost = lines.findIndex((l) => l.includes('"type":"cost-state"'));
const ordinary = lines.slice(0, firstCost + 1).join("\n") + "\n";
write("ordinary.jsonl", ordinary);
// forked: --fork-session copy of S1 (anonymized with the same maps, so shared uuids survive)
write("forked.jsonl", a.jsonl(read(fork)));
// killed: process killed during the first response
write("killed.jsonl", a.jsonl(read(`${S4}.jsonl`)));
// write-update-replaceall: Write create, Read, Write update, Edit with replace_all
write("write-update-replaceall.jsonl", a.jsonl(read(`${S5}.jsonl`)));
// no-tools: a one-prompt session with zero tool calls (ran in the >200-char path directory)
const longDir = readdirSync(projects).find((d) => readdirSync(join(projects, d)).includes(`${S3}.jsonl`));
write("no-tools.jsonl", a.jsonl(readFileSync(join(projects, longDir, `${S3}.jsonl`), "utf8")));

// subagent: parent + subagents/agent-<id>.jsonl + .meta.json, in Claude Code's layout
const subDir = join(S2, "subagents");
const sid = a.fakeId(S2);
write(`subagent/${sid}.jsonl`, a.jsonl(read(`${S2}.jsonl`)));
for (const f of readdirSync(join(lab, subDir))) {
  const agentId = f.match(/^agent-(.+?)\.(jsonl|meta\.json)$/)[1];
  const name = `subagent/${sid}/subagents/agent-${a.fakeId(agentId)}.${f.endsWith(".jsonl") ? "jsonl" : "meta.json"}`;
  write(name, f.endsWith(".jsonl") ? a.jsonl(read(subDir, f)) : JSON.stringify(a.value(JSON.parse(read(subDir, f))), null, 1));
}

// Derived edge cases (built from already-anonymized content only)
const body = ordinary.trimEnd().split("\n");
const last = body.at(-1);
write("truncated-tail.jsonl", [...body.slice(0, -1), last.slice(0, Math.floor(last.length / 2))].join("\n"));
write("no-final-newline.jsonl", body.join("\n"));
write("unknown-record.jsonl", [...body.slice(0, 5),
  JSON.stringify({ type: "from-the-future", sessionId: JSON.parse(body[5]).sessionId, timestamp: "2026-09-28T09:52:30.000Z", payload: { novel: 1 } }),
  ...body.slice(5)].join("\n") + "\n");
write("empty.jsonl", "");

// prompt-kinds: one record per user-record shape observed in real interactive and
// headless transcripts (field names and values copied from M0 observations; text is placeholder).
const base = { parentUuid: null, isSidechain: false, userType: "external", entrypoint: "cli", cwd: "C:\\fixture\\project", sessionId: "00000000-0000-4000-8000-00000000f000", version: "2.1.283", gitBranch: "", promptId: "00000000-0000-4000-8000-00000000f0ff" };
let i = 0;
const u = (expect, extra, content) => ({ ...base, type: "user", uuid: `00000000-0000-4000-8000-00000000f${String(++i).padStart(3, "0")}`, timestamp: `2026-09-28T10:00:${String(i).padStart(2, "0")}.000Z`, message: { role: "user", content }, ...extra, _expect: expect });
const kinds = [
  u("typed", { promptSource: "typed", origin: { kind: "human" }, turnOrigin: "human" }, blank("a typed prompt")),
  u("sdk", { promptSource: "sdk", turnOrigin: "sdk" }, blank("a headless prompt")),
  u(null, {}, `<command-name>${blank("/model")}</command-name>`),
  u(null, { isMeta: true }, `<local-command-caveat>${blank("caveat")}</local-command-caveat>`),
  u(null, {}, `<local-command-stdout>${blank("output")}</local-command-stdout>`),
  u("slash", { origin: { kind: "human" }, turnOrigin: "human" }, `<command-message>${blank("skill running")}</command-message>`),
  u(null, {}, `<bash-input>${blank("ls")}</bash-input>`),
  u(null, { turnOrigin: "human" }, `<bash-stdout>${blank("out")}</bash-stdout>`),
  u(null, { promptSource: "system", origin: { kind: "task-notification" }, turnOrigin: "task_notification" }, `<task-notification>${blank("done")}</task-notification>`),
  u(null, { isMeta: true }, [{ type: "text", text: blank("injected context") }]),
  u(null, {}, [{ type: "tool_result", tool_use_id: "toolu_fixture00000000f0aa", content: blank("result") }]),
  u(null, { isSidechain: true }, blank("subagent task prompt")),
  u(null, {}, [{ type: "text", text: `[Request interrupted by user]` }]),
];
// Same anonymizer as everything else (uniform shapes); the expectation is re-attached after.
write("prompt-kinds.jsonl", kinds.map(({ _expect, ...r }) => JSON.stringify({ ...a.record(r), _expect })).join("\n") + "\n");
console.log("fixtures written to", out);
