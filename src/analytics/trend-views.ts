/**
 * Display-ready (compact) forms of the Trends view models for client components.
 *
 * `riserSets` and `mapSets` (./views) carry full-precision numbers and fields the page never shows;
 * serialized for every role × window × category they made /trends about 2 MB of HTML per MiLB
 * level. These transforms keep exactly what is rendered, with values pre-formatted by the same
 * formatters the components used, so what is displayed is unchanged. No Momentum calculation
 * happens here.
 */
import { MOMENTUM_WINDOW_IDS, type MomentumWindow, type Role } from "./config";
import type { PlayerTimeline, RankedEntry, RiserCategory, TimelinePoint } from "./engine";
import { formatMetric, metricDefinition } from "./metrics";
import type { ConfidenceLevel } from "./momentum";
import { persistenceLabel, type PersistenceLevel } from "./persistence";
import type { MapPointView, MapSets, RiserSets } from "./views";

export interface EntityLinkRef {
  id: string;
  name: string;
  abbreviation: string;
}

/** "OPS .722 → .807" */
export const keyChangeText = (metric: string, before: number | null, now: number | null) =>
  `${metricDefinition(metric).label} ${formatMetric(metric, before)} → ${formatMetric(metric, now)}`;

export interface RiserEntryView {
  playerId: string;
  name: string;
  team: EntityLinkRef | null;
  organization: EntityLinkRef | null;
  /** Ranking value (Momentum for "overall", else the component change). */
  value: number;
  /** Momentum. */
  score: number;
  confidence: ConfidenceLevel;
  persistenceLevel: PersistenceLevel;
  /** e.g. "Sustained rise · 21 days". */
  persistence: string;
  keyChange: string;
  sample: { recent: number; baseline: number; unit: string };
}

/** Risers and fallers of every category for one role × window. */
export type RiserCategoryLists = Partial<
  Record<RiserCategory, { risers: RiserEntryView[]; fallers: RiserEntryView[] }>
>;

export interface RiserListsView {
  lists: Record<
    Role,
    Record<
      MomentumWindow,
      Partial<Record<RiserCategory, { risers: RiserEntryView[]; fallers: RiserEntryView[] }>>
    >
  >;
  comparable: Record<Role, Record<MomentumWindow, number>>;
}

function riserEntry(e: RankedEntry): RiserEntryView {
  const label = persistenceLabel({ state: e.persistenceState, direction: e.persistenceDirection });
  return {
    playerId: e.playerId,
    name: e.name,
    team: e.team,
    organization: e.organization,
    value: e.value,
    score: e.score,
    confidence: e.confidence,
    persistenceLevel: e.persistenceLevel,
    persistence:
      e.persistenceState === "insufficient" || e.persistenceState === "neutral"
        ? label
        : `${label} · ${e.trendLengthDays} days`,
    keyChange: keyChangeText(e.keyMetric, e.keyBefore, e.keyNow),
    sample: e.sample,
  };
}

export function riserListsView(sets: RiserSets): RiserListsView {
  const lists = { hitter: {}, pitcher: {} } as RiserListsView["lists"];
  for (const role of ["hitter", "pitcher"] as const)
    for (const w of MOMENTUM_WINDOW_IDS) {
      const out: RiserListsView["lists"][Role][MomentumWindow] = {};
      for (const [cat, l] of Object.entries(sets.lists[role][w]))
        if (l)
          out[cat as RiserCategory] = {
            risers: l.risers.map(riserEntry),
            fallers: l.fallers.map(riserEntry),
          };
      lists[role][w] = out;
    }
  return { lists, comparable: sets.comparable };
}

export interface MapPointCompact {
  /** Player id. */
  id: string;
  name: string;
  /** "TUL · LAD · SS" */
  context: string;
  /** Momentum. */
  y: number;
  confidence: ConfidenceLevel;
  persistenceLevel: PersistenceLevel;
  persistenceLabel: string;
  keyChange: string;
  sample: string;
  /** x-metric id → [percentile at this level, formatted season value]. */
  xs: Record<string, [number, string]>;
}

function mapPoint(p: MapPointView): MapPointCompact {
  const xs: MapPointCompact["xs"] = {};
  for (const [metric, [pctl, value]] of Object.entries(p.xs))
    xs[metric] = [pctl, formatMetric(metric, value)];
  return {
    id: p.playerId,
    name: p.name,
    context: [p.team?.abbreviation, p.organization?.abbreviation, p.position]
      .filter(Boolean)
      .join(" · "),
    y: p.y,
    confidence: p.confidence,
    persistenceLevel: p.persistenceLevel,
    persistenceLabel: p.persistenceLabel,
    keyChange: keyChangeText(p.keyMetric, p.keyBefore, p.keyNow),
    sample: `${p.sample.recent} recent / ${p.sample.baseline} earlier ${p.sample.unit}`,
    xs,
  };
}

/** One role × window of the Performance × Momentum map. */
export const mapPointsView = (sets: MapSets, role: Role, window: MomentumWindow) =>
  sets[role][window].map(mapPoint);

/** A profile timeline point as the chart uses it (internal model fields dropped). */
export type TimelinePointView = Omit<TimelinePoint, "rawScore" | "reliability" | "persistenceState">;

/**
 * A profile timeline in columnar form: one array per field instead of one object per date. A
 * full-season player has ~140 dates × 3 windows × role(s); per-point keys were most of the
 * profile's serialized size. `timelinePoints` restores the points on the client.
 */
export interface TimelineView extends Omit<PlayerTimeline, "points" | "modelId"> {
  dates: string[];
  score: (number | null)[];
  confidence: ConfidenceLevel[];
  persistenceLabel: string[];
  keyRecent: (number | null)[];
  keyBaseline: (number | null)[];
  recentOpportunities: number[];
  baselineOpportunities: number[];
  topComponents: { label: string; points: number }[][];
  /** 1 = the player appeared on that date. */
  played: (0 | 1)[];
}

export function timelineView(t: PlayerTimeline): TimelineView {
  const col = <K extends keyof TimelinePoint>(k: K) => t.points.map((p) => p[k]);
  return {
    role: t.role,
    window: t.window,
    keyMetric: t.keyMetric,
    events: t.events,
    dates: col("date"),
    score: col("score"),
    confidence: col("confidence"),
    persistenceLabel: col("persistenceLabel"),
    keyRecent: col("keyRecent"),
    keyBaseline: col("keyBaseline"),
    recentOpportunities: col("recentOpportunities"),
    baselineOpportunities: col("baselineOpportunities"),
    topComponents: col("topComponents"),
    played: t.points.map((p) => (p.playedOnDate ? 1 : 0)),
  };
}

export function timelinePoints(t: TimelineView): TimelinePointView[] {
  return t.dates.map((date, i) => ({
    date,
    score: t.score[i],
    confidence: t.confidence[i],
    persistenceLabel: t.persistenceLabel[i],
    keyRecent: t.keyRecent[i],
    keyBaseline: t.keyBaseline[i],
    recentOpportunities: t.recentOpportunities[i],
    baselineOpportunities: t.baselineOpportunities[i],
    topComponents: t.topComponents[i],
    playedOnDate: t.played[i] === 1,
  }));
}

export const timelineViews = (timelines: Record<MomentumWindow, PlayerTimeline>) =>
  Object.fromEntries(
    MOMENTUM_WINDOW_IDS.map((w) => [w, timelineView(timelines[w])]),
  ) as Record<MomentumWindow, TimelineView>;
