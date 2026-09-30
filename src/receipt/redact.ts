// Export redaction (docs/PRIVACY.md §6) as a pure Receipt → Receipt transform, so the terminal
// (--redact) and JSON (--json --redact) apply the same rules. The result is still a valid Receipt.
import type { Metric, Receipt } from "./types.ts";

const ext = (path: string) => {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `*${name.slice(dot).toLowerCase()}` : "*";
};

function redactMetric(m: Metric): Metric {
  if (m.id === "files.mostEdited" && m.value !== null) return { ...m, value: ext(m.value) };
  if (m.id === "toolCalls.byName" && m.value !== null) {
    const grouped: Record<string, number> = {};
    for (const [name, n] of Object.entries(m.value)) {
      const key = name.startsWith("mcp__") ? "MCP" : name;
      grouped[key] = (grouped[key] ?? 0) + n;
    }
    return { ...m, value: grouped };
  }
  return m;
}

export function redactReceipt(r: Receipt): Receipt {
  const s = r.session;
  return {
    ...r,
    session: { ...s, id: s.id.slice(0, 4), project: null, projectKey: null, cwd: null, title: null, forkOf: s.forkOf ? s.forkOf.slice(0, 4) : null },
    sections: { hard: r.sections.hard.map(redactMetric), coding: r.sections.coding.map(redactMetric), lore: r.sections.lore.map(redactMetric) },
  };
}
