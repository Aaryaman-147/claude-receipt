// Finds transcripts on disk. Read-only; never touches anything but the paths listed in
// docs/PRIVACY.md §2. Project identity comes from record `cwd`, never from directory names.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Subagent } from "./types.ts";

export const claudeHome = (env: NodeJS.ProcessEnv = process.env): string => env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

export interface SessionRef {
  sessionId: string; // the main file's name
  projectDir: string;
  mainFile: string;
  subagentFiles: string[]; // <projectDir>/<sessionId>/subagents/agent-*.jsonl (M0 §2)
}

export function refForFile(mainFile: string): SessionRef {
  const projectDir = dirname(mainFile);
  const sessionId = basename(mainFile, ".jsonl");
  const subDir = join(projectDir, sessionId, "subagents");
  const subagentFiles = existsSync(subDir)
    ? readdirSync(subDir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(subDir, f))
    : [];
  return { sessionId, projectDir, mainFile, subagentFiles };
}

export const refsInProject = (projectDir: string): SessionRef[] =>
  readdirSync(projectDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => refForFile(join(projectDir, e.name)));

export function projectDirs(home = claudeHome()): string[] {
  const root = join(home, "projects");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(root, e.name));
}

// Only agentType, model and toolUseId are used; `description` is free text and is dropped.
export function subagentMeta(file: string): Subagent {
  const agentId = basename(file, ".jsonl").replace(/^agent-/, "");
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch { /* optional */ }
  const s = (v: unknown) => (typeof v === "string" && /^[\w.:@/-]{1,100}$/.test(v) ? v : null);
  return { agentId, agentType: s(meta.agentType), model: s(meta.model), parentToolUseId: s(meta.toolUseId) };
}

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } // signal 0 only tests existence
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// A session is live only if its sessions/<pid>.json entry names a running process:
// entries stay behind after a crash (M0 §3). The *.key files beside them are never read.
export function liveSessionIds(home = claudeHome()): Set<string> {
  const dir = join(home, "sessions");
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const { pid, sessionId } = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (typeof pid === "number" && typeof sessionId === "string" && isRunning(pid)) ids.add(sessionId);
    } catch { /* unreadable or partial: not live */ }
  }
  return ids;
}
