// API list prices in USD per million tokens, used only when Claude Code's own cost-state
// can't be (live, killed or forked sessions). Data, not logic: update the date with the table.
import type { ApiCall } from "../source/claude-code/index.ts";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}
export interface PricingTable { date: string; source: string; models: Record<string, ModelPrice> }

// Standard multipliers: 5-minute cache writes 1.25× input, 1-hour writes 2×, reads 0.1×,
// except where Anthropic lists a different read price (Fable 5.1 / Mythos 5.1, Opus 5.5).
const std = (input: number, output: number, cacheRead = input * 0.1): ModelPrice =>
  ({ input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 });

export const PRICING: PricingTable = {
  date: "2026-06-24",
  source: "Anthropic first-party API list prices (standard tier). Haiku 4.5 and Opus 5.5 rates verified against Claude Code cost-state totals.",
  models: {
    "claude-fable-5-1": std(10, 50, 0.25),
    "claude-mythos-5-1": std(10, 50, 0.25),
    "claude-fable-5": std(10, 50),
    "claude-mythos-5": std(10, 50),
    "claude-opus-5-5": std(4, 20, 0.2),
    "claude-opus-5": std(5, 25),
    "claude-opus-4-8": std(5, 25),
    "claude-opus-4-7": std(5, 25),
    "claude-opus-4-6": std(5, 25),
    "claude-sonnet-5": std(2, 10),
    "claude-sonnet-4-6": std(3, 15),
    "claude-haiku-4-5": std(1, 5),
  },
};

// "claude-haiku-4-5-20251001" → "claude-haiku-4-5"; "claude-opus-4-6[1m]" → "claude-opus-4-6"
export const priceKey = (model: string) => model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");

export interface Priced {
  usd: number;
  byModel: Record<string, number>;
  pricedCalls: number;
  unpriced: string[]; // "model" or "model:fast" / "model:tier" that the table can't price
  assumedCacheTtl: boolean; // some cache writes had no 5m/1h breakdown and were priced at the 5m rate
}

export function priceCalls(calls: Pick<ApiCall, "model" | "usage" | "speed" | "serviceTier">[], table = PRICING): Priced {
  const out: Priced = { usd: 0, byModel: {}, pricedCalls: 0, unpriced: [], assumedCacheTtl: false };
  for (const { model, usage: u, speed, serviceTier } of calls) {
    const p = table.models[priceKey(model)];
    const why = !p ? model : speed === "fast" ? `${model}:fast` : serviceTier && serviceTier !== "standard" ? `${model}:${serviceTier}` : null;
    if (why || !p) { if (why && !out.unpriced.includes(why)) out.unpriced.push(why); continue; }
    let write: number;
    if (u.cacheWrite5m === null || u.cacheWrite1h === null) {
      write = u.cacheWrite * p.cacheWrite5m;
      if (u.cacheWrite > 0) out.assumedCacheTtl = true;
    } else {
      write = u.cacheWrite5m * p.cacheWrite5m + u.cacheWrite1h * p.cacheWrite1h;
    }
    const usd = (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + write) / 1e6;
    out.usd += usd;
    out.byModel[model] = (out.byModel[model] ?? 0) + usd;
    out.pricedCalls++;
  }
  return out;
}
