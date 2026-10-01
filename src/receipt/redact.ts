// Export redaction (docs/PRIVACY.md §6) as pure transforms, so the terminal (--redact) and JSON
// (--json --redact) apply the same rules: Receipt → Receipt and HistoryReceipt → HistoryReceipt.
// Each result is still a valid instance of its contract (fields are removed, never blanked as text).
import type { HistoryMetric, HistoryReceipt } from "../aggregate/types.ts";
import type { Metric, Receipt } from "./types.ts";

const ext = (path: string) => {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `*${name.slice(dot).toLowerCase()}` : "*";
};

// MCP server and tool names (mcp__<server>__<tool>) are grouped as "MCP".
function groupTools(byName: Record<string, number>): Record<string, number> {
  const grouped: Record<string, number> = {};
  for (const [name, n] of Object.entries(byName)) {
    const key = name.startsWith("mcp__") ? "MCP" : name;
    grouped[key] = (grouped[key] ?? 0) + n;
  }
  return grouped;
}

function redactMetric(m: Metric): Metric {
  if (m.id === "files.mostEdited" && m.value !== null) return { ...m, value: ext(m.value) };
  if (m.id === "toolCalls.byName" && m.value !== null) return { ...m, value: groupTools(m.value) };
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

function redactHistoryMetric(m: HistoryMetric): HistoryMetric {
  if (m.id === "agg.toolCalls.byName" && m.value !== null) {
    const grouped = groupTools(m.value);
    return { ...m, value: Object.fromEntries(Object.entries(grouped).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) };
  }
  // project names: hidden entirely (the project count stays in coverage)
  if (m.id === "agg.topProjects" && m.value !== null) {
    const { value: _hidden, ...rest } = m;
    return { ...rest, value: null, unavailableReason: "hidden by redaction" };
  }
  return m;
}

export function redactHistory(h: HistoryReceipt): HistoryReceipt {
  return {
    ...h,
    scope: { ...h.scope, projectKey: null }, // a path; projectFilter still says --project was used
    sections: { hard: h.sections.hard.map(redactHistoryMetric), coding: h.sections.coding.map(redactHistoryMetric), lore: h.sections.lore.map(redactHistoryMetric) },
  };
}
