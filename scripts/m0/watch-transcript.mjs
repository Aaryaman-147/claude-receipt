// M0 probe: sample a transcript while Claude Code writes it and report whether
// a reader can ever observe a partial final line. Prints counts only, never content.
// Usage: node scripts/m0/watch-transcript.mjs <sessionId> [seconds]
import { readdirSync, existsSync, openSync, readSync, fstatSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const [sessionId, seconds = "90"] = process.argv.slice(2);
const root = join(homedir(), ".claude", "projects");
const find = () => {
  for (const d of readdirSync(root)) {
    const p = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
};

const stats = { samples: 0, grew: 0, endsWithoutNewline: 0, partialLastLineUnparseable: 0, maxSize: 0 };
let lastSize = -1, file;
const deadline = Date.now() + Number(seconds) * 1000;
while (Date.now() < deadline) {
  file ??= find();
  if (file) {
    const fd = openSync(file, "r");
    const { size } = fstatSync(fd);
    if (size > 0) {
      const buf = Buffer.alloc(Math.min(size, 65536));
      readSync(fd, buf, 0, buf.length, size - buf.length);
      stats.samples++;
      if (size !== lastSize) stats.grew++;
      if (buf[buf.length - 1] !== 0x0a) {
        stats.endsWithoutNewline++;
        const tail = buf.toString("utf8").split("\n").pop();
        try { JSON.parse(tail); } catch { stats.partialLastLineUnparseable++; }
      }
      lastSize = size; stats.maxSize = size;
    }
    closeSync(fd);
  }
  await new Promise((r) => setTimeout(r, 5));
}
const finalEndsWithNewline = file ? readFileSync(file).at(-1) === 0x0a : null;
console.log(JSON.stringify({ found: !!file, ...stats, finalEndsWithNewline }));
