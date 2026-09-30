// Fixture safety: (1) planted secrets never survive the anonymizer, (2) every committed
// fixture contains only strings of a known-safe shape and nothing from this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo, hostname } from "node:os";
import { createAnonymizer } from "../scripts/anonymize-fixture.mjs";

const CANARIES = [
  "sk-ant-api03-CANARYKEY0000000000", "canary.person@example.com", "canaryuser", "CanarySecretProject",
  "function canarySecretFn", "hunter2-canary-password", "feature/canary-branch", "canarycorp", "Canary Title",
  "AKIACANARY00000000", "Bearer canarytoken",
];
const cwd = "C:\\Users\\canaryuser\\CanarySecretProject";
const synthetic = [
  { type: "queue-operation", operation: "enqueue", content: "please use sk-ant-api03-CANARYKEY0000000000", sessionId: "11111111-2222-4333-8444-555555555555", timestamp: "2026-01-01T00:00:00.000Z" },
  { type: "user", uuid: "aaaaaaaa-2222-4333-8444-555555555555", cwd, gitBranch: "feature/canary-branch", promptSource: "typed", message: { role: "user", content: "email canary.person@example.com password hunter2-canary-password" } },
  { type: "assistant", uuid: "bbbbbbbb-2222-4333-8444-555555555555", requestId: "req_canary", message: { id: "msg_canary", model: "claude-opus-5-5", role: "assistant", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 2 },
    content: [
      { type: "thinking", thinking: "the user canaryuser wants", signature: "Bearer canarytoken" },
      { type: "text", text: "Here is function canarySecretFn" },
      { type: "tool_use", id: "toolu_canary", name: "Bash", input: { command: "export ANTHROPIC_API_KEY=sk-ant-api03-CANARYKEY0000000000 && curl -H 'Bearer canarytoken' https://canarycorp.example", description: "call canarycorp" } },
      { type: "tool_use", id: "toolu_canary2", name: "mcp__canarycorp__deploy", input: { token: "AKIACANARY00000000" } },
      { type: "tool_use", id: "toolu_canary3", name: "Write", input: { file_path: `${cwd}\\src\\secret.ts`, content: "function canarySecretFn() { return 'hunter2-canary-password' }\n" } },
    ] } },
  { type: "user", uuid: "cccccccc-2222-4333-8444-555555555555", toolUseResult: { type: "create", filePath: `${cwd}\\src\\secret.ts`, content: "function canarySecretFn() {}\n", structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+function canarySecretFn() {}"] }] },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_canary3", content: "wrote C:\\Users\\canaryuser\\CanarySecretProject\\src\\secret.ts" }] } },
  { type: "user", uuid: "dddddddd-2222-4333-8444-555555555555", toolUseResult: "Error: AKIACANARY00000000 rejected for canaryuser", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_canary", is_error: true, content: "Exit code 1 canarycorp" }] } },
  { type: "attachment", uuid: "eeeeeeee-2222-4333-8444-555555555555", cwd, attachment: { type: "credential_org", org: "canarycorp", email: "canary.person@example.com" } },
  { type: "attachment", uuid: "ffffffff-2222-4333-8444-555555555555", cwd, rendered: [{ content: "Canary Title canaryuser" }], attachment: { type: "hook_success", content: "hunter2-canary-password" } },
  { type: "ai-title", aiTitle: "Canary Title", sessionId: "11111111-2222-4333-8444-555555555555" },
  { type: "last-prompt", lastPrompt: "canary.person@example.com", sessionId: "11111111-2222-4333-8444-555555555555" },
  { type: "file-history-snapshot", snapshot: { trackedFileBackups: { [`${cwd}\\src\\secret.ts`]: { backupFileName: "canaryuser@v1" } } } },
  { type: "cost-state", modelUsage: { "claude-opus-5-5": { inputTokens: 1 } }, weird: { model: "sk-ant-api03-CANARYKEY0000000000", status: "canarycorp" } },
  { type: "some-future-type", secretish: "hunter2-canary-password", nested: [{ deep: "canaryuser" }] },
  // real-shaped ids in places no ID key protects: a wire-format map keyed by tool-use id, unknown
  // fields holding a message id / UUID / long-hex agent id, and a UUID used as a key
  { type: "assistant", uuid: "12345678-90ab-4cde-8f01-234567890abc", message: { id: "msg_01CanaryRealLookingId9", model: "claude-opus-5-5",
    content: [{ type: "tool_use", id: "toolu_01CanaryWireKeyXyz", name: "Read", input: { file_path: `${cwd}\\a.ts` } }] },
    wireToolInputs: { toolu_01CanaryWireKeyXyz: { file_path: `${cwd}\\a.ts` } },
    futureField: { "3f2a9c1e-1111-4222-8333-444455556666": 1, agentRef: "c0ffee0123456789ab", parentMessage: "msg_01CanaryRealLookingId9" } },
].map((r) => JSON.stringify(r)).join("\n") + "\n" + '{"type":"user","message":{"content":"torn canaryuser';
const REAL_ID_CANARIES = ["toolu_01CanaryWireKeyXyz", "msg_01CanaryRealLookingId9", "12345678-90ab-4cde-8f01-234567890abc", "3f2a9c1e-1111-4222-8333-444455556666", "c0ffee0123456789ab"];

// Every ID-shaped token (API message/tool-use/request ids, UUIDs, 16+ hex) and the only fakes allowed.
const ID_TOKEN = /(?<![A-Za-z0-9.])(?:(?:msg|toolu|req|srvtoolu)_[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9]*[a-f])[0-9a-f]{16,})(?![A-Za-z0-9])/gi;
const FAKE_ID = /^(00000000-0000-4000-8000-[0-9a-f]{12}|(msg|toolu|req|srvtoolu)_fixture[0-9a-f]{12})$/;
const realIds = (text) => [...new Set(text.match(ID_TOKEN) ?? [])].filter((t) => !FAKE_ID.test(t));

test("ID scanner: flags real-shaped ids, accepts only generated fakes", () => {
  assert.deepEqual(realIds('{"k":"toolu_01ScannerCanary000000","m":"msg_01ScannerCanary","u":"3f2a9c1e-1111-4222-8333-444455556666","a":"c0ffee0123456789ab"}').length, 4);
  assert.deepEqual(realIds('{"toolu_fixture000000000017":1,"id":"msg_fixture000000000014","uuid":"00000000-0000-4000-8000-0000000000ad","agent":"a0000000000c6"}'), []);
  assert.deepEqual(realIds('{"service_tier":"standard","web_fetch_requests":0,"tool_use_id":"x"}'), [], "structural names are not ids");
  assert.deepEqual(realIds('{"totalCostUSD":0.060603800000000006,"startTime":1790589139428}'), [], "long digit runs in numbers are not ids");
});

test("anonymizer: planted secrets and private strings cannot survive", () => {
  const out = createAnonymizer().jsonl(synthetic);
  for (const c of CANARIES) assert.ok(!out.toLowerCase().includes(c.toLowerCase()), `canary survived: ${c}`);
  assert.ok(!/credential_org/.test(out), "credential attachments are dropped entirely");
  assert.ok(!/Users/.test(out), "no real-looking home paths");
  for (const id of REAL_ID_CANARIES) assert.ok(!out.includes(id), `real-shaped id survived: ${id}`);
  assert.deepEqual(realIds(out), [], "every id-shaped token in the output is a generated fake");
});

test("anonymizer: an id used as an object key maps to the same fake as the id itself", () => {
  const recs = createAnonymizer().jsonl(synthetic).split("\n").filter((l) => l.startsWith("{")).map(JSON.parse);
  const r = recs.find((x) => x.wireToolInputs);
  const toolId = r.message.content[0].id;
  assert.match(toolId, FAKE_ID);
  assert.deepEqual(Object.keys(r.wireToolInputs), [toolId], "wire-format key stays linked to its tool call");
  assert.equal(r.futureField.parentMessage, r.message.id, "the same id maps to the same fake everywhere");
  assert.ok(Object.keys(r.futureField).every((k) => !realIds(JSON.stringify(k)).length), "UUID-shaped keys are mapped");
});

test("anonymizer: keeps the structure tests depend on", () => {
  const recs = createAnonymizer().jsonl(synthetic).split("\n").filter((l) => l.startsWith("{")).map(JSON.parse);
  const a = recs.find((r) => r.type === "assistant");
  assert.equal(a.message.model, "claude-opus-5-5");
  assert.deepEqual(a.message.usage, { input_tokens: 1, output_tokens: 2 });
  assert.equal(a.message.content[2].input.command, "cmd x", "unknown programs collapse to cmd");
  assert.equal(a.message.content[3].name, "mcp__server__tool");
  assert.match(a.message.content[4].input.file_path, /^C:\\fixture\\project\\file\d+\.ts$/);
  const res = recs.find((r) => r.toolUseResult?.type === "create");
  assert.equal(res.toolUseResult.structuredPatch[0].lines[0][0], "+");
  assert.equal(res.toolUseResult.content.split("\n").length, 2, "newlines preserved for line counting");
  assert.equal(recs.find((r) => r.promptSource).message.content.length, "email canary.person@example.com password hunter2-canary-password".length, "length preserved");
});

// ---- committed fixtures ----
const root = join("fixtures", "claude-code");
const files = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
const machine = [userInfo().username, homedir(), hostname(), process.cwd()].filter((s) => s && s.length > 2);
const forbidden = [
  /[A-Za-z]:\\\\Users\\\\/i, /\/(Users|home)\//, /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/, /sk-ant-/i, /AKIA[0-9A-Z]{8}/, /Bearer\s/i,
  /OneDrive|AppData/i, /claude-receipt/i,
];
const ENUM_KEYS = new Set(["type", "subtype", "role", "model", "stop_reason", "version", "entrypoint", "userType", "permissionMode", "promptSource", "turnOrigin", "kind", "service_tier", "speed", "level", "operation", "mode", "status", "agentType", "requestShape", "resolvedModel", "inference_geo", "canonicalModel", "provider", "costBasis", "name", "_expect"]);
const SAFE = [
  /^[x\n]*$/,                                                    // blanked text
  /^[+\- ]x*$/,                                                  // blanked patch line with its prefix
  /^\s*(<[a-z-]+>|\[Request interrupted)[x\n]*$/,                 // kept system tag + blanked rest
  /^\[Request interrupted by user\]$/,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,               // timestamps
  /^00000000-0000-4000-8000-[0-9a-f]{12}$/, /^(msg|toolu|req|srvtoolu)_fixture[0-9a-f]{12}$/, /^a[0-9a-f]{12}$/, // fake ids
  /^C:\\fixture\\project\d*(\\file\d+(\.[A-Za-z0-9]+)?)?$/,      // fake paths
  /^([a-z]+ ){1,2}x$/,                                             // replaced commands
];
const offenders = (v, key = "", path = "") => {
  if (typeof v === "string") {
    if (SAFE.some((re) => re.test(v)) || (ENUM_KEYS.has(key) && /^[A-Za-z0-9_.:<>-]{0,40}$/.test(v))) return [];
    return [`${path}=${JSON.stringify(v.slice(0, 40))}`];
  }
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [
    ...(Array.isArray(v) || ((/^[A-Za-z_][A-Za-z0-9_]*$|^claude-[a-z0-9.-]+$|^C:\\fixture\\/.test(k) || FAKE_ID.test(k)) && !realIds(k).length) ? [] : [`${path}.key(${k.slice(0, 40)})`]),
    ...offenders(x, Array.isArray(v) ? key : k, `${path}.${k}`),
  ]);
  return [];
};

test("fixtures: nothing from this machine, no secret-looking strings", () => {
  for (const f of files(root)) {
    const text = readFileSync(f, "utf8");
    for (const m of machine) assert.ok(!text.toLowerCase().includes(m.toLowerCase()), `${f} contains machine-specific string`);
    for (const re of forbidden) assert.ok(!re.test(text), `${f} matches ${re}`);
  }
});

test("fixtures: every ID-shaped token (keys, values, file names) is a generated fake id", () => {
  for (const f of files(root)) {
    assert.deepEqual(realIds(readFileSync(f, "utf8")), [], `${f} contains real-looking ids`);
    assert.deepEqual(realIds(f.split(/[\\/]/).join(" ")), [], `${f}: file path contains a real-looking id`);
  }
});

test("fixtures: every string value has a known-safe shape (allowlist check independent of the anonymizer)", () => {
  for (const f of files(root)) {
    const text = readFileSync(f, "utf8");
    const docs = f.endsWith(".json") ? [JSON.parse(text)] : text.split("\n").filter((l) => l.startsWith("{") && l.endsWith("}")).map(JSON.parse);
    const bad = docs.flatMap((d, i) => offenders(d, "", `#${i}`));
    assert.deepEqual(bad, [], `${f} has strings of unknown shape`);
  }
});
