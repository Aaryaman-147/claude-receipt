// Process entry point for the claude-receipt command.
import { run } from "./run.ts";

process.exitCode = await run(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  cwd: process.cwd(),
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
  ...(process.stdout.columns ? { columns: process.stdout.columns } : {}),
});
