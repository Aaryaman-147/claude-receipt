// The story layer (v0.2.1): which facts a receipt leads with, in what order, and the receipt-native
// words around them. Pure and deterministic: reads only a (validated, possibly redacted) Receipt or
// HistoryReceipt; no files, clock, randomness or transcript text. Facts are formatted by ./format.ts
// from metric values and keep their provenance; every flavour string comes from COPY below, so the
// wording can frame a fact but never change it. Nothing here is semantic data: the models are unchanged.
import type { HistoryMetric, HistoryMetricId, HistoryReceipt, HistoryValueMap } from "../aggregate/types.ts";
import type { Metric, MetricId, MetricValueMap, Provenance, Receipt } from "../receipt/types.ts";
import { duration, FOOTERS, int, usd } from "./format.ts";

// ---- presentation types ----

// ref names a non-metric fact (coverage counts) so a renderer can avoid printing it twice
export interface StoryFact { label: string; value: string; provenance: Provenance; metricId?: string; ref?: "coverage.sessions" | "coverage.projects" }
export type BeatId = "biggest-day" | "shipped" | "rabbit-hole" | "long-one" | "toolbox" | "nice-run" | "where-you-worked" | "longest-turn";
export interface StoryBeat { id: BeatId; heading: string; facts: StoryFact[] }
export type ObservationId = "night-owl" | "early-bird" | "after-hours";
export interface Observation { id: ObservationId; heading: string; text: string; provenance: "heuristic" }
export interface Story {
  opening: string;
  hero: StoryFact[]; // 0-3 big numbers
  beats: StoryBeat[]; // 0-5, in priority order
  observation: Observation | null; // at most one, always heuristic
  closing: string;
  consumed: string[]; // metric ids shown in hero or beats (so supporting rows can skip them)
}
// A beat never repeats a fact the hero already shows: it is dropped before the beat limit applies.
const withoutHero = (beats: StoryBeat[], hero: StoryFact[]) => {
  const shown = new Set(hero.map((f) => f.metricId).filter(Boolean));
  return beats.filter((b) => !b.facts.some((f) => f.metricId && shown.has(f.metricId)));
};
const consumedBy = (hero: StoryFact[], beats: StoryBeat[]) => [...new Set([...hero, ...beats.flatMap((b) => b.facts)].flatMap((f) => (f.metricId ? [f.metricId] : [])))].sort();

// ---- the controlled vocabulary (flavour only) ----

export const COPY = {
  openings: {
    live: "STILL GOING.",
    busy: "YOU'VE BEEN BUSY.",
    shipped: "LET'S SEE WHAT YOU SHIPPED.",
    rabbitHole: "DOWN THE RABBIT HOLE WE GO.",
    run: "LOOKS LIKE YOU HAD A RUN.",
    neutral: "HERE'S YOUR RECEIPT.", // the fallback: assumes nothing about the reader
  },
  beats: {
    "biggest-day": "YOUR BIGGEST DAY",
    "shipped": "YOU SHIPPED",
    "rabbit-hole": "DOWN THE RABBIT HOLE",
    "long-one": "THE LONG ONE",
    "toolbox": "YOUR TOOLBOX",
    "nice-run": "NICE RUN",
    "where-you-worked": "WHERE YOU WORKED",
    "longest-turn": "THE LONGEST TURN",
  } satisfies Record<BeatId, string>,
  observations: {
    "night-owl": { heading: "NIGHT OWL", history: "Most of your recorded activity happened between 8 PM and 5 AM.", session: "Most of this session's activity happened between 8 PM and 5 AM." },
    "early-bird": { heading: "EARLY BIRD", history: "Most of your recorded activity happened before noon.", session: "Most of this session's activity happened before noon." },
    "after-hours": { heading: "AFTER HOURS", history: "Your busiest hours were in the evening.", session: "This session's busiest hours were in the evening." },
  } satisfies Record<ObservationId, { heading: string; history: string; session: string }>,
  closings: FOOTERS,
} as const;

// ---- thresholds (documented in docs/METRICS.md → Receipt story) ----

export const STORY = {
  maxBeats: 5,
  biggestDay: { minDays: 2, minSessions: 2 },
  rabbitHole: { minToolCalls: 10 },
  longOne: { historyMinMs: 30 * 60_000, historyMinSessions: 2, sessionMinMs: 60 * 60_000 },
  toolbox: { minTools: 2, show: 3 },
  niceRun: { minDays: 3 },
  whereYouWorked: { minProjects: 2, show: 3 },
  longestTurn: { minMs: 5 * 60_000 },
  openings: { busySessions: 20, busySessionMs: 3 * 3_600_000, shippedLines: 500, rabbitHoleCalls: 40, runDays: 3 },
  observation: {
    minEvents: 40, minHistorySessions: 3,
    nightOwl: { hours: [20, 21, 22, 23, 0, 1, 2, 3, 4], share: 0.5 },
    earlyBird: { hours: [5, 6, 7, 8, 9, 10, 11], share: 0.5 },
    afterHours: { hours: [18, 19, 20, 21, 22, 23], share: 0.35, peakFrom: 18, peakTo: 23 },
  },
} as const;

// ---- helpers ----

// Stable string hash (the v0.2 footer hash), for picks that must not change between
// runs and must not depend on redaction: callers pass keys built from redaction-independent fields.
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const pick = <T>(list: readonly T[], key: string): T => list[hash(key) % list.length]!;

const sessionMetric = <K extends MetricId>(r: Receipt, id: K) =>
  Object.values(r.sections).flat().find((m): m is Extract<Metric, { id: K }> => m.id === id) as { value: MetricValueMap[K] | null; provenance: Provenance; detail?: Record<string, unknown> } | undefined;
const historyMetric = <K extends HistoryMetricId>(h: HistoryReceipt, id: K) =>
  Object.values(h.sections).flat().find((m): m is Extract<HistoryMetric, { id: K }> => m.id === id) as { value: HistoryValueMap[K] | null; provenance: Provenance; detail?: Record<string, unknown>; covered: { sessions: number; of: number } } | undefined;
const fact = (label: string, value: string, provenance: Provenance, metricId?: string): StoryFact => ({ label, value, provenance, ...(metricId ? { metricId } : {}) });
const topEntries = (m: Record<string, number>, n: number) => Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
const plural = (n: number, word: string) => `${int(n)} ${word}${n === 1 ? "" : "s"}`;

// A beat facts row for lines changed; null when neither count is available or both are zero.
function shippedFacts(added: { value: number | null; provenance: Provenance } | undefined, removed: { value: number | null; provenance: Provenance } | undefined, ids: [string, string]): StoryFact[] | null {
  const a = added?.value ?? null, r = removed?.value ?? null;
  if (a === null && r === null) return null;
  if ((a ?? 0) + (r ?? 0) <= 0) return null;
  return [
    ...(a !== null ? [fact("LINES ADDED", `+${int(a)}`, added!.provenance, ids[0])] : []),
    ...(r !== null ? [fact("LINES REMOVED", `-${int(r)}`, removed!.provenance, ids[1])] : []),
  ];
}

// The time-of-day observation from an hour histogram (prompts + tool calls per local hour, in the
// zone the sessions were recorded in). At most one; null when there is too little data.
export function observe(byHour: unknown, scope: "history" | "session"): Observation | null {
  if (!Array.isArray(byHour) || byHour.length !== 24 || !byHour.every((c) => Number.isInteger(c) && c >= 0)) return null;
  const hours = byHour as number[];
  const total = hours.reduce((a, b) => a + b, 0);
  const o = STORY.observation;
  if (total < o.minEvents) return null;
  const share = (hs: readonly number[]) => hs.reduce((s, h) => s + hours[h]!, 0) / total;
  const peak = hours.indexOf(Math.max(...hours)); // earliest hour on a tie
  const id: ObservationId | null =
    share(o.nightOwl.hours) >= o.nightOwl.share ? "night-owl"
    : share(o.earlyBird.hours) >= o.earlyBird.share ? "early-bird"
    : share(o.afterHours.hours) >= o.afterHours.share && peak >= o.afterHours.peakFrom && peak <= o.afterHours.peakTo ? "after-hours"
    : null;
  if (!id) return null;
  const c = COPY.observations[id];
  return { id, heading: c.heading, text: c[scope], provenance: "heuristic" };
}

// ---- history ----

export function historyStory(h: HistoryReceipt): Story {
  const c = h.coverage;
  const beats: StoryBeat[] = [];
  const add = (id: BeatId, facts: StoryFact[]) => { beats.push({ id, heading: COPY.beats[id], facts }); };

  const busiest = historyMetric(h, "agg.busiestDay");
  if (busiest?.value && c.daysWithData >= STORY.biggestDay.minDays && busiest.value.sessions >= STORY.biggestDay.minSessions)
    add("biggest-day", [fact("SESSIONS", int(busiest.value.sessions), busiest.provenance, "agg.busiestDay"), fact("DATE", busiest.value.date, busiest.provenance, "agg.busiestDay")]);
  const shipped = shippedFacts(historyMetric(h, "agg.lines.added"), historyMetric(h, "agg.lines.removed"), ["agg.lines.added", "agg.lines.removed"]);
  if (shipped) add("shipped", shipped);
  const rabbit = historyMetric(h, "agg.rabbitHole");
  if (rabbit?.value && rabbit.value.toolCalls >= STORY.rabbitHole.minToolCalls)
    add("rabbit-hole", [
      fact("TOOL CALLS", int(rabbit.value.toolCalls), rabbit.provenance, "agg.rabbitHole"),
      ...(rabbit.value.durationMs !== null ? [fact("TIME", duration(rabbit.value.durationMs), rabbit.provenance, "agg.rabbitHole")] : []),
      ...(rabbit.value.date ? [fact("DATE", rabbit.value.date, rabbit.provenance, "agg.rabbitHole")] : []),
    ]);
  const longest = historyMetric(h, "agg.longestSession");
  if (longest?.value && c.sessions >= STORY.longOne.historyMinSessions && longest.value.durationMs >= STORY.longOne.historyMinMs)
    add("long-one", [fact("LONGEST SESSION", duration(longest.value.durationMs), longest.provenance, "agg.longestSession"), ...(longest.value.date ? [fact("DATE", longest.value.date, longest.provenance, "agg.longestSession")] : [])]);
  const tools = historyMetric(h, "agg.toolCalls.byName");
  if (tools?.value && Object.keys(tools.value).length >= STORY.toolbox.minTools)
    add("toolbox", topEntries(tools.value, STORY.toolbox.show).map(([name, n]) => fact(name, int(n), tools.provenance, "agg.toolCalls.byName")));
  const streak = historyMetric(h, "agg.streak");
  if (streak?.value && streak.value.days >= STORY.niceRun.minDays)
    add("nice-run", [fact("DAYS IN A ROW", int(streak.value.days), streak.provenance, "agg.streak"), fact("FROM", streak.value.from, streak.provenance, "agg.streak"), fact("TO", streak.value.to, streak.provenance, "agg.streak")]);
  const projects = historyMetric(h, "agg.topProjects");
  if (projects?.value && !h.scope.projectFilter && c.projects >= STORY.whereYouWorked.minProjects)
    add("where-you-worked", projects.value.slice(0, STORY.whereYouWorked.show).map((p) => fact(p.project, plural(p.sessions, "session"), projects.provenance, "agg.topProjects")));

  // hero: sessions, projects (unless one project), time in sessions
  const wall = historyMetric(h, "agg.duration.wall");
  const hero = [
    { ...fact(c.sessions === 1 ? "SESSION" : "SESSIONS", int(c.sessions), "exact"), ref: "coverage.sessions" as const },
    ...(h.scope.projectFilter ? [] : [{ ...fact(c.projects === 1 ? "PROJECT" : "PROJECTS", int(c.projects), "exact"), ref: "coverage.projects" as const }]),
    ...(wall?.value != null ? [fact("IN SESSIONS", duration(wall.value), wall.provenance, "agg.duration.wall")] : []),
  ];
  const told = withoutHero(beats, hero).slice(0, STORY.maxBeats);

  // opening: the first rule that matches, else the neutral line
  const key = `history|${h.scope.period}|${c.firstDate ?? ""}|${c.lastDate ?? ""}|${c.sessions}`;
  const o = STORY.openings, added = historyMetric(h, "agg.lines.added")?.value ?? null;
  const opening = c.sessions >= o.busySessions ? COPY.openings.busy
    : added !== null && added >= o.shippedLines ? COPY.openings.shipped
    : rabbit?.value && rabbit.value.toolCalls >= o.rabbitHoleCalls ? COPY.openings.rabbitHole
    : streak?.value && streak.value.days >= o.runDays ? COPY.openings.run
    : COPY.openings.neutral;

  // observation: enough sessions, one recorded time zone
  const peak = historyMetric(h, "agg.peakHour");
  const observation = peak && peak.covered.sessions >= STORY.observation.minHistorySessions && c.timeZones.length === 1 && !h.warnings.some((w) => w.code === "mixed-time-zones")
    ? observe(peak.detail?.byHour, "history") : null;

  return { opening, hero, beats: told, observation, closing: pick(COPY.closings, `closing|${key}`), consumed: consumedBy(hero, told) };
}

// ---- session ----

export function sessionStory(r: Receipt): Story {
  const s = r.session;
  const beats: StoryBeat[] = [];
  const add = (id: BeatId, facts: StoryFact[]) => { beats.push({ id, heading: COPY.beats[id], facts }); };

  const wall = sessionMetric(r, "session.duration.wall");
  if (wall?.value != null && wall.value >= STORY.longOne.sessionMinMs) add("long-one", [fact("DURATION", duration(wall.value), wall.provenance, "session.duration.wall")]);
  const shipped = shippedFacts(sessionMetric(r, "lines.added"), sessionMetric(r, "lines.removed"), ["lines.added", "lines.removed"]);
  if (shipped) add("shipped", shipped);
  const rabbit = sessionMetric(r, "lore.rabbitHole");
  if (rabbit?.value && rabbit.value.toolCalls >= STORY.rabbitHole.minToolCalls)
    add("rabbit-hole", [fact("TOOL CALLS", int(rabbit.value.toolCalls), rabbit.provenance, "lore.rabbitHole"), ...(rabbit.value.durationMs !== null ? [fact("TIME", duration(rabbit.value.durationMs), rabbit.provenance, "lore.rabbitHole")] : [])]);
  const tools = sessionMetric(r, "toolCalls.byName");
  if (tools?.value && Object.keys(tools.value).length >= STORY.toolbox.minTools)
    add("toolbox", topEntries(tools.value, STORY.toolbox.show).map(([name, n]) => fact(name, int(n), tools.provenance, "toolCalls.byName")));
  const turn = sessionMetric(r, "lore.longestTurn");
  if (turn?.value != null && turn.value >= STORY.longestTurn.minMs) add("longest-turn", [fact("LONGEST TURN", duration(turn.value), turn.provenance, "lore.longestTurn")]);

  // hero: duration, tokens out, API equivalent
  const out = sessionMetric(r, "tokens.output"), cost = sessionMetric(r, "cost.apiEquivalent");
  const hero = [
    ...(wall?.value != null ? [fact("DURATION", duration(wall.value), wall.provenance, "session.duration.wall")] : []),
    ...(out?.value != null ? [fact("TOKENS OUT", int(out.value), out.provenance, "tokens.output")] : []),
    ...(cost?.value != null ? [fact("API EQUIVALENT", usd(cost.value), cost.provenance, "cost.apiEquivalent")] : []),
  ];
  const told = withoutHero(beats, hero).slice(0, STORY.maxBeats); // duration is the hero, so THE LONG ONE never repeats it

  // opening: keyed on start/end times (not the session id, which redaction shortens)
  const key = `session|${s.startedAt ?? ""}|${s.endedAt ?? ""}`;
  const o = STORY.openings, added = sessionMetric(r, "lines.added")?.value ?? null;
  const opening = s.live ? COPY.openings.live
    : wall?.value != null && wall.value >= o.busySessionMs ? COPY.openings.busy
    : added !== null && added >= o.shippedLines ? COPY.openings.shipped
    : rabbit?.value && rabbit.value.toolCalls >= o.rabbitHoleCalls ? COPY.openings.rabbitHole
    : COPY.openings.neutral;

  const observation = observe(sessionMetric(r, "lore.peakHour")?.detail?.byHour, "session");
  return { opening, hero, beats: told, observation, closing: pick(COPY.closings, `closing|${key}`), consumed: consumedBy(hero, told) };
}
