/**
 * Analytics engine: composes the pure building blocks over one AFL snapshot.
 *
 * All outputs are plain serializable objects so server components can compute them and pass only
 * display rows to client components. Nothing here performs I/O or writes anywhere.
 */
import {
  buildPlayerRows,
  type AflPlayerRow,
} from "@/services/afl/read-model";
import type { AflSnapshot } from "@/services/afl/types";
import {
  COMPONENTS_BY_ROLE,
  KEY_METRIC,
  MAP_QUADRANT_SPLIT,
  MODEL_IDS,
  MOMENTUM_MODELS,
  MOMENTUM_SETTINGS,
  MOMENTUM_WINDOW_IDS,
  MOMENTUM_WINDOWS,
  PERCENTILE_CATEGORIES,
  WHAT_CHANGED_METRICS,
  type ComponentId,
  type ModelId,
  type MomentumSettings,
  type MomentumWindow,
  type Role,
} from "./config";
import {
  combineComponents,
  componentChanges,
  confidenceLevel,
  effectiveSample,
  momentumBand,
  reliability as reliabilityOf,
  zToScore,
  type ComponentChange,
  type ComponentContribution,
  type ConfidenceLevel,
  type MetricChange,
} from "./momentum";
import {
  metricDefinition,
  metricValue,
  opportunities,
  OPPORTUNITY_LABEL,
  type HitterSample,
  type PitcherSample,
} from "./metrics";
import {
  normalizationScales,
  rolePopulation,
  type RolePopulation,
  type ScaleTable,
} from "./population";
import {
  persistenceLabel,
  trendPersistence,
  type Checkpoint,
  type PersistenceResult,
} from "./persistence";
import { explainMomentum, COMPONENT_LABELS } from "./explain";
import { addDays, daysBetween, mean, percentileRank, round } from "./stats";
import {
  buildDataset,
  comparisonRanges,
  playerRoles,
  sampleInRange,
  type AnalyticsDataset,
  type ComparisonRanges,
} from "./windows";

export type ChangeStatus =
  | "ok"
  | "no-games" // no completed AFL games at all
  | "no-recent"
  | "insufficient-recent"
  | "no-baseline"
  | "insufficient-baseline"
  | "no-data"; // samples exist but no metric could be computed

export const CHANGE_STATUS_LABELS: Record<ChangeStatus, string> = {
  ok: "",
  "no-games": "No completed games at this level yet",
  "no-recent": "No games in this window",
  "insufficient-recent": "Too few recent opportunities",
  "no-baseline":
    "Unavailable — no earlier games at this level before this window to compare with",
  "insufficient-baseline":
    "Unavailable — too few earlier games at this level before this window to compare with",
  "no-data": "No comparable statistics",
};

export interface ChangeSnapshot {
  role: Role;
  window: MomentumWindow;
  end: string;
  ranges: ComparisonRanges;
  recent: HitterSample | PitcherSample | null;
  baseline: HitterSample | PitcherSample | null;
  recentOpportunities: number;
  baselineOpportunities: number;
  reliability: number;
  status: ChangeStatus;
  components: ComponentChange[];
}

export interface AnalyticsContext {
  ds: AnalyticsDataset;
  settings: MomentumSettings;
  rows: Map<string, AflPlayerRow>;
  populations: Record<Role, RolePopulation>;
  percentilePopulations: Record<Role, RolePopulation>;
  scaleCache: Map<string, ScaleTable>;
  changeCache: Map<string, ChangeSnapshot>;
  momentumCache: Map<string, MomentumResult>;
}

export function createAnalyticsContext(
  snapshot: AflSnapshot,
  settings: MomentumSettings = MOMENTUM_SETTINGS,
): AnalyticsContext {
  const ds = buildDataset(snapshot);
  const pop = (role: Role, min: number) => rolePopulation(ds, role, min);
  const n = settings.normalization.populationMinOpportunities;
  const p = settings.percentiles.populationMinOpportunities;
  return {
    ds,
    settings,
    rows: new Map(buildPlayerRows(snapshot, "season").map((r) => [r.id, r])),
    populations: { hitter: pop("hitter", n.hitter), pitcher: pop("pitcher", n.pitcher) },
    percentilePopulations: {
      hitter: pop("hitter", p.hitter),
      pitcher: pop("pitcher", p.pitcher),
    },
    scaleCache: new Map(),
    changeCache: new Map(),
    momentumCache: new Map(),
  };
}

export function scalesFor(
  ctx: AnalyticsContext,
  role: Role,
  window: MomentumWindow,
): ScaleTable {
  // level-sd scales do not depend on the window; change-sd scales do.
  const key =
    ctx.settings.normalization.method === "level-sd" ? role : `${role}|${window}`;
  let scales = ctx.scaleCache.get(key);
  if (!scales) {
    scales = normalizationScales(
      ctx.ds,
      role,
      ctx.settings,
      window,
      ctx.populations[role],
    );
    ctx.scaleCache.set(key, scales);
  }
  return scales;
}

/** Model-independent recent-vs-baseline change for one player, role, window and end date. */
export function changeSnapshot(
  ctx: AnalyticsContext,
  playerId: string,
  role: Role,
  window: MomentumWindow,
  end: string,
): ChangeSnapshot {
  const key = `${playerId}|${role}|${window}|${end}`;
  const cached = ctx.changeCache.get(key);
  if (cached) return cached;
  const { ds, settings } = ctx;
  const ranges = comparisonRanges(ds, end, window);
  const recent = sampleInRange(ds, role, playerId, ranges.recent);
  const baseline = sampleInRange(ds, role, playerId, ranges.baseline);
  const recentOpportunities = opportunities(role, recent);
  const baselineOpportunities = opportunities(role, baseline);
  const components = componentChanges(
    role,
    baseline,
    recent,
    scalesFor(ctx, role, window),
    settings,
  );
  let status: ChangeStatus = "ok";
  if (!recentOpportunities) status = "no-recent";
  else if (recentOpportunities < settings.sample.minRecent[role])
    status = "insufficient-recent";
  else if (!baselineOpportunities) status = "no-baseline";
  else if (baselineOpportunities < settings.sample.minBaseline[role])
    status = "insufficient-baseline";
  else if (components.every((c) => c.z === null)) status = "no-data";
  const snap: ChangeSnapshot = {
    role,
    window,
    end,
    ranges,
    recent,
    baseline,
    recentOpportunities,
    baselineOpportunities,
    reliability:
      status === "ok"
        ? reliabilityOf(role, recentOpportunities, baselineOpportunities, settings)
        : 0,
    status,
    components,
  };
  ctx.changeCache.set(key, snap);
  return snap;
}

export interface Contribution extends ComponentContribution {
  label: string;
  /** This component's share of the final Momentum score, in score points. */
  points: number;
}

export interface MomentumResult {
  playerId: string;
  role: Role;
  window: MomentumWindow;
  modelId: ModelId;
  end: string | null;
  status: ChangeStatus;
  /** Final displayed value: raw · reliability · persistence multiplier, rounded. */
  score: number | null;
  /** Unshrunk ±100 value from the combined standardized change. */
  rawScore: number | null;
  /** Raw score after sample-size shrinkage, before persistence. */
  reliabilityAdjusted: number | null;
  combinedZ: number | null;
  reliability: number;
  confidence: ConfidenceLevel;
  persistence: PersistenceResult;
  band: { id: string; label: string; direction: "up" | "down" | "flat" } | null;
  contributions: Contribution[];
  components: ComponentChange[];
  /** Before / now / change for the display metrics of the role. */
  metrics: MetricChange[];
  ranges: ComparisonRanges | null;
  sample: { recent: number; baseline: number; unit: string };
  explanation: string;
}

function checkpointZ(
  ctx: AnalyticsContext,
  playerId: string,
  role: Role,
  window: MomentumWindow,
  end: string,
  modelId: ModelId,
): Checkpoint {
  const snap = changeSnapshot(ctx, playerId, role, window, end);
  if (snap.status !== "ok") return { end, z: null, reliability: 0 };
  return {
    end,
    z: combineComponents(role, snap.components, MOMENTUM_MODELS[modelId]).z,
    reliability: snap.reliability,
  };
}

export function momentum(
  ctx: AnalyticsContext,
  playerId: string,
  role: Role,
  window: MomentumWindow,
  modelId: ModelId,
  endDate?: string,
): MomentumResult {
  const { ds, settings } = ctx;
  const end = endDate ?? ds.asOf;
  const cacheKey = `${playerId}|${role}|${window}|${modelId}|${end}`;
  const cached = ctx.momentumCache.get(cacheKey);
  if (cached) return cached;
  const unit = OPPORTUNITY_LABEL[role];
  const persistenceNone = trendPersistence([], 0, [], settings);
  if (!end) {
    const empty: MomentumResult = {
      playerId,
      role,
      window,
      modelId,
      end: null,
      status: "no-games",
      score: null,
      rawScore: null,
      reliabilityAdjusted: null,
      combinedZ: null,
      reliability: 0,
      confidence: "low",
      persistence: persistenceNone,
      band: null,
      contributions: [],
      components: [],
      metrics: [],
      ranges: null,
      sample: { recent: 0, baseline: 0, unit },
      explanation: CHANGE_STATUS_LABELS["no-games"] + ".",
    };
    return empty;
  }
  const model = MOMENTUM_MODELS[modelId];
  const snap = changeSnapshot(ctx, playerId, role, window, end);
  const combined =
    snap.status === "ok"
      ? combineComponents(role, snap.components, model)
      : { z: null, contributions: [] as ComponentContribution[] };
  const firstDate = ds.completedDates[0] ?? end;
  const checkpoints: Checkpoint[] = [];
  for (let i = 0; i < settings.persistence.checkpoints; i++) {
    const cpEnd = addDays(end, -i * settings.persistence.stepDays);
    if (cpEnd < firstDate) break;
    checkpoints.push(
      i === 0
        ? { end, z: combined.z, reliability: snap.reliability }
        : checkpointZ(ctx, playerId, role, window, cpEnd, modelId),
    );
  }
  const others = MOMENTUM_WINDOW_IDS.filter((w) => w !== window).map(
    (w) => checkpointZ(ctx, playerId, role, w, end, modelId).z,
  );
  const persistence = trendPersistence(
    checkpoints,
    MOMENTUM_WINDOWS[window].days,
    others,
    settings,
  );
  // A trend cannot be longer than the AFL games observed so far.
  persistence.trendLengthDays = Math.min(
    persistence.trendLengthDays,
    daysBetween(firstDate, end) + 1,
  );
  const rawScore = combined.z === null ? null : zToScore(combined.z, settings);
  const reliabilityAdjusted =
    rawScore === null ? null : rawScore * snap.reliability;
  const finalScore =
    reliabilityAdjusted === null
      ? null
      : reliabilityAdjusted * persistence.multiplier;
  const score = finalScore === null ? null : round(finalScore) + 0; // +0 avoids -0
  const contributions: Contribution[] = combined.contributions.map((c) => ({
    ...c,
    label: COMPONENT_LABELS[c.component].label,
    points:
      finalScore !== null && combined.z
        ? (finalScore * c.weighted) / combined.z
        : 0,
  }));
  const metricRows = WHAT_CHANGED_METRICS[role].map(
    (id) =>
      snap.components.flatMap((c) => c.metrics).find((m) => m.metric === id) ??
      metricRowFor(id, snap, ctx, window),
  );
  const confidence = confidenceLevel(
    role,
    snap.reliability,
    snap.recentOpportunities,
    snap.baselineOpportunities,
    settings,
  );
  const result: MomentumResult = {
    playerId,
    role,
    window,
    modelId,
    end,
    status: snap.status,
    score,
    rawScore: rawScore === null ? null : round(rawScore, 1),
    reliabilityAdjusted:
      reliabilityAdjusted === null ? null : round(reliabilityAdjusted, 1),
    combinedZ: combined.z,
    reliability: snap.reliability,
    confidence,
    persistence,
    band: score === null ? null : momentumBand(score),
    contributions,
    components: snap.components,
    metrics: metricRows,
    ranges: snap.ranges,
    sample: {
      recent: snap.recentOpportunities,
      baseline: snap.baselineOpportunities,
      unit,
    },
    explanation:
      snap.status === "ok"
        ? explainMomentum({
            combinedZ: combined.z,
            contributions: combined.contributions,
            confidence,
            persistence: persistence.state,
            settings,
          })
        : `${CHANGE_STATUS_LABELS[snap.status]}.`,
  };
  ctx.momentumCache.set(cacheKey, result);
  return result;
}

/** Display metric that is not part of a Momentum component (e.g. K/9 when only K% is weighted). */
function metricRowFor(
  id: string,
  snap: ChangeSnapshot,
  ctx: AnalyticsContext,
  window: MomentumWindow,
): MetricChange {
  const def = metricDefinition(id);
  const before = metricValue(id, snap.baseline);
  const now = metricValue(id, snap.recent);
  const scale = scalesFor(ctx, snap.role, window)[id]?.scale ?? def.fallbackScale;
  const delta = before !== null && now !== null ? now - before : null;
  return {
    metric: id,
    label: def.label,
    before,
    now,
    delta,
    z: delta === null ? null : (def.direction * delta) / scale,
    scale,
  };
}

// ---------------------------------------------------------------------------------------------
// Player-level views
// ---------------------------------------------------------------------------------------------

export interface TimelineEvent {
  date: string;
  type:
    | "promotion"
    | "award"
    | "injury"
    | "return"
    | "level-change"
    | "performance";
  label: string;
  /** Provenance of the event record. Events are only shown when ingested, never inferred. */
  source: string;
}

export interface TimelinePoint {
  date: string;
  score: number | null;
  rawScore: number | null;
  reliability: number;
  confidence: ConfidenceLevel;
  persistenceState: PersistenceResult["state"];
  /** Direction-aware persistence wording (e.g. "Sustained decline"). */
  persistenceLabel: string;
  keyRecent: number | null;
  keyBaseline: number | null;
  recentOpportunities: number;
  baselineOpportunities: number;
  /** Largest component changes at this date (by absolute contribution). */
  topComponents: { label: string; points: number }[];
  playedOnDate: boolean;
}

export interface PlayerTimeline {
  role: Role;
  window: MomentumWindow;
  modelId: ModelId;
  keyMetric: string;
  points: TimelinePoint[];
  /** Dated development events. Empty until such events are ingested. */
  events: TimelineEvent[];
}

/** Momentum at every completed AFL game date from the player's first game through as-of. */
export function playerTimeline(
  ctx: AnalyticsContext,
  playerId: string,
  role: Role,
  window: MomentumWindow,
  modelId: ModelId,
): PlayerTimeline {
  const lines =
    role === "hitter" ? ctx.ds.batting.get(playerId) : ctx.ds.pitching.get(playerId);
  const keyMetric = KEY_METRIC[role];
  const played = new Set((lines ?? []).map((l) => l.date));
  const first = lines?.[0]?.date;
  const points = first
    ? ctx.ds.completedDates
        .filter((d) => d >= first)
        .map((date) => {
          const m = momentum(ctx, playerId, role, window, modelId, date);
          const snap = changeSnapshot(ctx, playerId, role, window, date);
          return {
            date,
            score: m.score,
            rawScore: m.rawScore,
            reliability: m.reliability,
            confidence: m.confidence,
            persistenceState: m.persistence.state,
            persistenceLabel: persistenceLabel(m.persistence),
            keyRecent: metricValue(keyMetric, snap.recent),
            keyBaseline: metricValue(keyMetric, snap.baseline),
            recentOpportunities: snap.recentOpportunities,
            baselineOpportunities: snap.baselineOpportunities,
            topComponents: [...m.contributions]
              .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
              .slice(0, 2)
              .map((c) => ({ label: c.label, points: round(c.points, 1) })),
            playedOnDate: played.has(date),
          };
        })
    : [];
  return { role, window, modelId, keyMetric, points, events: [] };
}

export interface PercentileMetric {
  metric: string;
  label: string;
  value: number | null;
  percentile: number | null;
}
export interface PercentileCategory {
  id: string;
  label: string;
  percentile: number | null;
  metrics: PercentileMetric[];
}
export interface Fingerprint {
  role: Role;
  /** Players in the AFL comparison population for this role. */
  populationSize: number;
  minOpportunities: number;
  playerOpportunities: number;
  qualified: boolean;
  categories: PercentileCategory[];
  momentum: { percentile: number | null; score: number | null; population: number };
}

export function fingerprint(
  ctx: AnalyticsContext,
  playerId: string,
  role: Role,
  window: MomentumWindow,
  modelId: ModelId,
): Fingerprint {
  const pop = ctx.percentilePopulations[role];
  const sample = pop.season.get(playerId) ?? null;
  const categories = PERCENTILE_CATEGORIES[role].map((cat) => {
    const metrics = cat.metrics.map((id) => {
      const def = metricDefinition(id);
      const value = metricValue(id, sample);
      const population = pop.qualified
        .map((q) => metricValue(id, pop.season.get(q) ?? null))
        .filter((v): v is number => v !== null);
      return {
        metric: id,
        label: def.label,
        value,
        percentile:
          value === null ? null : percentileRank(value, population, def.direction),
      };
    });
    const pct = mean(
      metrics.flatMap((m) => (m.percentile === null ? [] : [m.percentile])),
    );
    return { id: cat.id, label: cat.label, percentile: pct, metrics };
  });
  const own = momentum(ctx, playerId, role, window, modelId);
  const scores = qualifiedMomentum(ctx, role, window, modelId).map(
    (m) => m.score!,
  );
  return {
    role,
    populationSize: pop.qualified.length,
    minOpportunities: ctx.settings.percentiles.populationMinOpportunities[role],
    playerOpportunities: opportunities(role, sample),
    qualified: pop.qualified.includes(playerId),
    categories,
    momentum: {
      score: own.score,
      percentile:
        own.score === null ? null : percentileRank(own.score, scores),
      population: scores.length,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Discovery views
// ---------------------------------------------------------------------------------------------

export function isLeaderboardQualified(
  ctx: AnalyticsContext,
  m: MomentumResult,
) {
  const s = ctx.settings.sample;
  return (
    m.status === "ok" &&
    m.score !== null &&
    m.sample.recent >= s.leaderboardMinRecent[m.role][m.window] &&
    m.sample.baseline >= s.leaderboardMinBaseline[m.role]
  );
}

export function qualifiedMomentum(
  ctx: AnalyticsContext,
  role: Role,
  window: MomentumWindow,
  modelId: ModelId,
): MomentumResult[] {
  const ids = role === "hitter" ? ctx.ds.batting.keys() : ctx.ds.pitching.keys();
  return [...ids]
    .sort()
    .map((id) => momentum(ctx, id, role, window, modelId))
    .filter((m) => isLeaderboardQualified(ctx, m));
}

export interface PlayerIdentity {
  playerId: string;
  name: string;
  position: string;
  team: { id: string; name: string; abbreviation: string } | null;
  organization: { id: string; name: string; abbreviation: string } | null;
}
export function identity(ctx: AnalyticsContext, playerId: string): PlayerIdentity {
  const row = ctx.rows.get(playerId);
  return {
    playerId,
    name: row?.name ?? "Unknown player",
    position: row?.position ?? "",
    team: row?.team ?? null,
    organization: row?.organization ?? null,
  };
}

export type RiserCategory = "overall" | ComponentId;

export interface RankedEntry extends PlayerIdentity {
  role: Role;
  /** Ranking value: Momentum for "overall", or the shrunk component change score. */
  value: number;
  score: number;
  confidence: ConfidenceLevel;
  persistenceLevel: PersistenceResult["level"];
  persistenceState: PersistenceResult["state"];
  persistenceDirection: PersistenceResult["direction"];
  /** Direction-aware persistence wording (e.g. "Deepening decline"). */
  persistenceLabel: string;
  trendLengthDays: number;
  sample: MomentumResult["sample"];
  keyMetric: string;
  keyBefore: number | null;
  keyNow: number | null;
  explanation: string;
}

/** Component change on the ±100 scale, shrunk by sample reliability (no persistence credit). */
export function componentScore(
  ctx: AnalyticsContext,
  m: MomentumResult,
  component: ComponentId,
): number | null {
  const z = m.components.find((c) => c.component === component)?.z ?? null;
  return z === null ? null : round(zToScore(z, ctx.settings) * m.reliability);
}

function ranked(
  ctx: AnalyticsContext,
  m: MomentumResult,
  value: number,
): RankedEntry {
  const key = KEY_METRIC[m.role];
  const metric = m.components.flatMap((c) => c.metrics).find((x) => x.metric === key);
  const snap = m.end ? changeSnapshot(ctx, m.playerId, m.role, m.window, m.end) : null;
  return {
    ...identity(ctx, m.playerId),
    role: m.role,
    value,
    score: m.score!,
    confidence: m.confidence,
    persistenceLevel: m.persistence.level,
    persistenceState: m.persistence.state,
    persistenceDirection: m.persistence.direction,
    persistenceLabel: persistenceLabel(m.persistence),
    trendLengthDays: m.persistence.trendLengthDays,
    sample: m.sample,
    keyMetric: key,
    keyBefore: metric?.before ?? metricValue(key, snap?.baseline ?? null),
    keyNow: metric?.now ?? metricValue(key, snap?.recent ?? null),
    explanation: m.explanation,
  };
}

/** Biggest Risers / Fallers ranked by change relative to each player's own baseline. */
export function risersAndFallers(
  ctx: AnalyticsContext,
  role: Role,
  window: MomentumWindow,
  modelId: ModelId,
  category: RiserCategory = "overall",
  limit = 10,
): { risers: RankedEntry[]; fallers: RankedEntry[] } {
  if (category !== "overall" && !COMPONENTS_BY_ROLE[role].includes(category))
    throw new Error(`Component ${category} does not apply to ${role}s`);
  const entries = qualifiedMomentum(ctx, role, window, modelId).flatMap((m) => {
    const value = category === "overall" ? m.score : componentScore(ctx, m, category);
    return value === null ? [] : [ranked(ctx, m, value)];
  });
  const byName = (a: RankedEntry, b: RankedEntry) =>
    a.name.localeCompare(b.name) || a.playerId.localeCompare(b.playerId);
  // A zero minimum still excludes exact zeros (no change is neither a riser nor a faller).
  const min = ctx.settings.sample.leaderboardMinMagnitude || Number.MIN_VALUE;
  return {
    risers: entries
      .filter((e) => e.value >= min)
      .sort((a, b) => b.value - a.value || b.sample.recent - a.sample.recent || byName(a, b))
      .slice(0, limit),
    fallers: entries
      .filter((e) => e.value <= -min)
      .sort((a, b) => a.value - b.value || b.sample.recent - a.sample.recent || byName(a, b))
      .slice(0, limit),
  };
}

export type Quadrant = "breakout" | "surging-star" | "established-cooling" | "struggling";
export const QUADRANT_LABELS: Record<Quadrant, string> = {
  breakout: "Breakout / emerging",
  "surging-star": "Surging star",
  "established-cooling": "Established / cooling",
  struggling: "Struggling",
};
export function quadrantOf(percentile: number, score: number): Quadrant {
  const high = percentile >= MAP_QUADRANT_SPLIT.percentile;
  const up = score > MAP_QUADRANT_SPLIT.momentum;
  return high ? (up ? "surging-star" : "established-cooling") : up ? "breakout" : "struggling";
}

export interface MapPoint extends PlayerIdentity {
  x: number;
  xValue: number;
  y: number;
  confidence: ConfidenceLevel;
  persistenceLevel: PersistenceResult["level"];
  persistenceLabel: string;
  quadrant: Quadrant;
  keyMetric: string;
  keyBefore: number | null;
  keyNow: number | null;
  sample: MomentumResult["sample"];
}

/**
 * Performance × Momentum. x = AFL season percentile of one transparent statistic (not a composite
 * performance model), y = Momentum. Only leaderboard-qualified players who are also in the
 * season percentile population are plotted.
 */
export function performanceMap(
  ctx: AnalyticsContext,
  role: Role,
  window: MomentumWindow,
  modelId: ModelId,
  xMetric: string,
): MapPoint[] {
  const def = metricDefinition(xMetric);
  if (def.role !== role) throw new Error(`${xMetric} is not a ${role} metric`);
  const pop = ctx.percentilePopulations[role];
  const population = pop.qualified
    .map((id) => metricValue(xMetric, pop.season.get(id) ?? null))
    .filter((v): v is number => v !== null);
  const qualified = new Set(pop.qualified);
  return qualifiedMomentum(ctx, role, window, modelId).flatMap((m) => {
    if (!qualified.has(m.playerId)) return [];
    const xValue = metricValue(xMetric, pop.season.get(m.playerId) ?? null);
    const x = xValue === null ? null : percentileRank(xValue, population, def.direction);
    if (x === null || xValue === null) return [];
    const r = ranked(ctx, m, m.score!);
    return [
      {
        ...identity(ctx, m.playerId),
        x: round(x, 1),
        xValue,
        y: m.score!,
        confidence: m.confidence,
        persistenceLevel: m.persistence.level,
        persistenceLabel: persistenceLabel(m.persistence),
        quadrant: quadrantOf(x, m.score!),
        keyMetric: r.keyMetric,
        keyBefore: r.keyBefore,
        keyNow: r.keyNow,
        sample: m.sample,
      },
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// Model comparison (development / review output)
// ---------------------------------------------------------------------------------------------

export interface ComparisonEntry extends PlayerIdentity {
  score: number;
  rawScore: number | null;
  reliability: number;
  confidence: ConfidenceLevel;
  sample: MomentumResult["sample"];
  persistence: Pick<
    PersistenceResult,
    "state" | "level" | "score" | "trendLengthDays" | "runLength" | "direction"
  > & { label: string };
  contributions: { component: ComponentId; label: string; points: number; z: number }[];
  metrics: { metric: string; label: string; before: number | null; now: number | null; delta: number | null }[];
}

export interface ModelComparison {
  window: MomentumWindow;
  asOf: string | null;
  qualified: Record<Role, number>;
  models: {
    model: (typeof MOMENTUM_MODELS)[ModelId];
    hitters: { top: ComparisonEntry[]; bottom: ComparisonEntry[] };
    pitchers: { top: ComparisonEntry[]; bottom: ComparisonEntry[] };
  }[];
  /** Sample-size distribution of every player with a valid comparison (V1 model). */
  samples: Record<Role, SampleDistribution>;
  /** Spearman rank correlation of scores between each model pair, per role. */
  agreement: { a: ModelId; b: ModelId; role: Role; spearman: number | null; topOverlap: number }[];
}

export interface SampleDistribution {
  players: number;
  /** [min, p25, median, p75, max] */
  recent: number[];
  baseline: number[];
  effective: number[];
  confidence: Record<ConfidenceLevel, number>;
}

function quantiles(xs: number[]) {
  if (!xs.length) return [];
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => {
    const i = (s.length - 1) * p,
      lo = Math.floor(i),
      hi = Math.ceil(i);
    return round(s[lo] + (s[hi] - s[lo]) * (i - lo), 1);
  };
  return [0, 0.25, 0.5, 0.75, 1].map(q);
}

/** Recent / earlier / effective sample quantiles and confidence counts for one window. */
export function sampleDistribution(
  ctx: AnalyticsContext,
  role: Role,
  window: MomentumWindow,
  modelId: ModelId = "balanced",
): SampleDistribution {
  const ids = role === "hitter" ? ctx.ds.batting.keys() : ctx.ds.pitching.keys();
  const ok = [...ids]
    .map((id) => momentum(ctx, id, role, window, modelId))
    .filter((m) => m.status === "ok");
  const confidence: Record<ConfidenceLevel, number> = { low: 0, medium: 0, high: 0 };
  for (const m of ok) confidence[m.confidence]++;
  return {
    players: ok.length,
    recent: quantiles(ok.map((m) => m.sample.recent)),
    baseline: quantiles(ok.map((m) => m.sample.baseline)),
    effective: quantiles(ok.map((m) => effectiveSample(m.sample.recent, m.sample.baseline))),
    confidence,
  };
}

function comparisonEntry(ctx: AnalyticsContext, m: MomentumResult): ComparisonEntry {
  return {
    ...identity(ctx, m.playerId),
    score: m.score!,
    rawScore: m.rawScore,
    reliability: round(m.reliability, 2),
    confidence: m.confidence,
    sample: m.sample,
    persistence: {
      state: m.persistence.state,
      direction: m.persistence.direction,
      label: persistenceLabel(m.persistence),
      level: m.persistence.level,
      score: round(m.persistence.score, 2),
      trendLengthDays: m.persistence.trendLengthDays,
      runLength: m.persistence.runLength,
    },
    contributions: m.contributions.map((c) => ({
      component: c.component,
      label: c.label,
      points: round(c.points, 1),
      z: round(c.z, 2),
    })),
    metrics: m.metrics.map((x) => ({
      metric: x.metric,
      label: x.label,
      before: x.before,
      now: x.now,
      delta: x.delta,
    })),
  };
}

function ranks(values: number[]) {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
export function spearman(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ra = ranks(a),
    rb = ranks(b);
  const ma = mean(ra)!,
    mb = mean(rb)!;
  let num = 0,
    da = 0,
    db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

export function compareModels(
  ctx: AnalyticsContext,
  window: MomentumWindow,
  limit = 20,
): ModelComparison {
  const lists = Object.fromEntries(
    MODEL_IDS.map((id) => [
      id,
      {
        hitter: qualifiedMomentum(ctx, "hitter", window, id),
        pitcher: qualifiedMomentum(ctx, "pitcher", window, id),
      },
    ]),
  ) as Record<ModelId, Record<Role, MomentumResult[]>>;
  const sortDesc = (xs: MomentumResult[]) =>
    [...xs].sort(
      (a, b) =>
        b.score! - a.score! ||
        identity(ctx, a.playerId).name.localeCompare(identity(ctx, b.playerId).name),
    );
  const topBottom = (xs: MomentumResult[]) => {
    const sorted = sortDesc(xs);
    return {
      top: sorted.slice(0, limit).map((m) => comparisonEntry(ctx, m)),
      bottom: sorted
        .slice(-limit)
        .reverse()
        .map((m) => comparisonEntry(ctx, m)),
    };
  };
  const agreement: ModelComparison["agreement"] = [];
  for (let i = 0; i < MODEL_IDS.length; i++)
    for (let j = i + 1; j < MODEL_IDS.length; j++)
      for (const role of ["hitter", "pitcher"] as const) {
        const a = lists[MODEL_IDS[i]][role],
          b = lists[MODEL_IDS[j]][role];
        const bScores = new Map(b.map((m) => [m.playerId, m.score!]));
        const paired = a.filter((m) => bScores.has(m.playerId));
        const topA = new Set(sortDesc(a).slice(0, limit).map((m) => m.playerId));
        const topB = sortDesc(b).slice(0, limit).map((m) => m.playerId);
        agreement.push({
          a: MODEL_IDS[i],
          b: MODEL_IDS[j],
          role,
          spearman: spearman(
            paired.map((m) => m.score!),
            paired.map((m) => bScores.get(m.playerId)!),
          ),
          topOverlap: topB.filter((id) => topA.has(id)).length,
        });
      }
  const anyModel = lists[MODEL_IDS[0]];
  return {
    window,
    asOf: ctx.ds.asOf,
    qualified: { hitter: anyModel.hitter.length, pitcher: anyModel.pitcher.length },
    samples: {
      hitter: sampleDistribution(ctx, "hitter", window),
      pitcher: sampleDistribution(ctx, "pitcher", window),
    },
    models: MODEL_IDS.map((id) => ({
      model: MOMENTUM_MODELS[id],
      hitters: topBottom(lists[id].hitter),
      pitchers: topBottom(lists[id].pitcher),
    })),
    agreement,
  };
}

/** All Momentum windows for one player/role, for client-side window toggles. */
export function playerMomentumByWindow(
  ctx: AnalyticsContext,
  playerId: string,
  role: Role,
  modelId: ModelId,
) {
  return Object.fromEntries(
    MOMENTUM_WINDOW_IDS.map((w) => [w, momentum(ctx, playerId, role, w, modelId)]),
  ) as Record<MomentumWindow, MomentumResult>;
}

export { playerRoles };
