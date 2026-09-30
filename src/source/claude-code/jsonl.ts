import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface JsonlStats {
  badLines: number;
  truncatedTail: boolean;
}

const BAD = Symbol("bad");
const parseLine = (line: string): unknown => {
  try { return JSON.parse(line); } catch { return BAD; }
};

// Streams one JSON value per line from the first `size` bytes of a file: the snapshot
// present when parsing started, so lines appended meanwhile are ignored (M0 §3).
// A final line that doesn't parse is dropped and flagged; other bad lines are counted.
export async function* readJsonl(path: string, size: number, stats: JsonlStats): AsyncGenerator<unknown> {
  if (size === 0) return;
  const lines = createInterface({ input: createReadStream(path, { start: 0, end: size - 1, encoding: "utf8" }), crlfDelay: Infinity });
  let pending: string | null = null;
  for await (const line of lines) {
    if (pending?.trim()) {
      const value = parseLine(pending);
      if (value === BAD) stats.badLines++;
      else yield value;
    }
    pending = line;
  }
  if (pending?.trim()) {
    const value = parseLine(pending);
    if (value === BAD) stats.truncatedTail = true;
    else yield value;
  }
}
