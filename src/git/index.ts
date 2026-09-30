// Read-only git facts for a session window (docs/ARCHITECTURE.md §5). Runs only
// `rev-parse` and `log`; never writes. Commit messages and author identities are never
// read into the result: co-author trailers are checked in memory for "Claude" and dropped.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface GitCommit {
  sha: string;
  ts: string; // committer date, ISO
  claudeCoAuthored: boolean;
  added: number; // numstat, text files only
  removed: number;
}

export type GitFacts =
  | { status: "ok"; hasCommits: boolean; window: { since: string; until: string }; commits: GitCommit[] }
  | { status: "no-cwd" | "no-window" | "not-a-repo" | "git-unavailable" | "error" };

export const GIT_GRACE_MS = 5 * 60_000; // commits can land shortly after the last transcript record

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function gitFacts(cwd: string | null, startedAt: string | null, endedAt: string | null): GitFacts {
  if (!cwd || !existsSync(cwd)) return { status: "no-cwd" };
  if (!startedAt || !endedAt) return { status: "no-window" };
  try {
    if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return { status: "not-a-repo" };
  } catch (e) {
    return { status: (e as NodeJS.ErrnoException).code === "ENOENT" ? "git-unavailable" : "not-a-repo" };
  }
  const window = { since: startedAt, until: new Date(Date.parse(endedAt) + GIT_GRACE_MS).toISOString() };
  try {
    try { git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]); }
    catch { return { status: "ok", hasCommits: false, window, commits: [] }; } // empty repository
    // Local branches plus HEAD (a detached HEAD's commits are on no branch). Fetched commits
    // from others stay out unless merged locally.
    const out = git(cwd, [
      "log", "--branches", "HEAD", `--since=${window.since}`, `--until=${window.until}`, "--numstat",
      "--format=%x1e%H%x1f%cI%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)",
    ]);
    const commits: GitCommit[] = [];
    for (const chunk of out.split("\x1e").slice(1)) {
      const [header = "", ...stats] = chunk.split("\n");
      const [sha = "", ts = "", coAuthors = ""] = header.split("\x1f");
      let added = 0, removed = 0;
      for (const line of stats) {
        const [a, r] = line.split("\t");
        if (a && r && /^\d+$/.test(a) && /^\d+$/.test(r)) { added += Number(a); removed += Number(r); }
      }
      commits.push({ sha, ts: new Date(ts).toISOString(), claudeCoAuthored: /claude|noreply@anthropic\.com/i.test(coAuthors), added, removed });
    }
    return { status: "ok", hasCommits: true, window, commits };
  } catch {
    return { status: "error" };
  }
}
