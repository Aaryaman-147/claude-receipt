// Public surface of the Claude Code source adapter. Nothing outside this directory
// knows Claude Code's file format (docs/ARCHITECTURE.md §2).
import { claudeHome, liveSessionIds, projectDirs, refsInProject, subagentMeta, type SessionRef } from "./discover.ts";
import { scanFile } from "./scan.ts";
import { buildSessions, type SessionInput } from "./session.ts";
import type { Session } from "./types.ts";

export * from "./types.ts";
export { claudeHome, liveSessionIds, projectDirs, refForFile, refsInProject, type SessionRef } from "./discover.ts";
export { projectKey, reconcile, tokensByModel, type ModelTokens } from "./session.ts";

// Parses the given transcripts together. Forks are detected among these refs only, so pass
// every session of a project (loadProject) when fork handling matters.
export async function loadSessions(refs: SessionRef[], opts: { live?: Set<string> } = {}): Promise<Session[]> {
  const inputs: SessionInput[] = [];
  for (const ref of refs) {
    const subagents = [];
    for (const f of ref.subagentFiles) subagents.push({ scan: await scanFile(f), meta: subagentMeta(f) });
    inputs.push({ id: ref.sessionId, main: await scanFile(ref.mainFile), subagents, live: opts.live?.has(ref.sessionId) ?? false });
  }
  return buildSessions(inputs);
}

export const loadProject = (projectDir: string, home = claudeHome()): Promise<Session[]> =>
  loadSessions(refsInProject(projectDir), { live: liveSessionIds(home) });

// Finds one session by id or unique id prefix, parsing its project's other sessions for fork detection.
export async function findSession(idOrPrefix: string, home = claudeHome()): Promise<Session | null> {
  const matches = projectDirs(home).flatMap((dir) => refsInProject(dir).filter((r) => r.sessionId.startsWith(idOrPrefix)));
  if (matches.length > 1) throw new Error(`session id prefix "${idOrPrefix}" is ambiguous (${matches.length} matches)`);
  const ref = matches[0];
  if (!ref) return null;
  return (await loadProject(ref.projectDir, home)).find((s) => s.id === ref.sessionId) ?? null;
}
