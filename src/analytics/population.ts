/**
 * AFL comparison populations: normalization scales for standardized changes, and percentile
 * populations. Everything is relative to the ingested AFL season — never MLB or league-average
 * baselines from outside the data.
 */
import {
  COMPONENT_METRICS,
  COMPONENTS_BY_ROLE,
  type MomentumSettings,
  type MomentumWindow,
  type Role,
} from "./config";
import {
  metricDefinition,
  metricValue,
  opportunities,
  type HitterSample,
  type PitcherSample,
} from "./metrics";
import { standardDeviation } from "./stats";
import {
  comparisonRanges,
  sampleInRange,
  seasonSample,
  type AnalyticsDataset,
} from "./windows";

export interface MetricScale {
  scale: number;
  /** Players contributing to the estimate (0 when the fallback scale was used). */
  n: number;
  source: "population" | "fallback";
}
export type ScaleTable = Record<string, MetricScale>;

export interface RolePopulation {
  role: Role;
  /** Season sample for every player with lines in this role. */
  season: Map<string, HitterSample | PitcherSample>;
  /** Player ids meeting the season-opportunity qualification for normalization/percentiles. */
  qualified: string[];
}

export function rolePopulation(
  ds: AnalyticsDataset,
  role: Role,
  minOpportunities: number,
): RolePopulation {
  const season = new Map<string, HitterSample | PitcherSample>();
  const ids = role === "hitter" ? ds.batting.keys() : ds.pitching.keys();
  for (const id of ids) {
    const s = seasonSample(ds, role, id);
    if (s) season.set(id, s);
  }
  const qualified = [...season.entries()]
    .filter(([, s]) => opportunities(role, s) >= minOpportunities)
    .map(([id]) => id)
    .sort();
  return { role, season, qualified };
}

export function momentumMetricIds(role: Role) {
  return [
    ...new Set(
      COMPONENTS_BY_ROLE[role].flatMap((c) =>
        COMPONENT_METRICS[c].map((m) => m.metric),
      ),
    ),
  ];
}

function finalize(
  metric: string,
  values: number[],
  settings: MomentumSettings,
): MetricScale {
  const def = metricDefinition(metric);
  const sd = standardDeviation(values);
  if (values.length < settings.normalization.minPopulation || sd === null)
    return { scale: def.fallbackScale, n: 0, source: "fallback" };
  return {
    scale: Math.max(sd, def.minScale),
    n: values.length,
    source: "population",
  };
}

/**
 * Per-metric scale used to standardize a change: Δ / scale. With `level-sd` the scale is the
 * spread of season levels among qualified AFL players; with `change-sd` it is the spread of the
 * same window's recent-minus-baseline change among players with adequate samples.
 */
export function normalizationScales(
  ds: AnalyticsDataset,
  role: Role,
  settings: MomentumSettings,
  window: MomentumWindow,
  population?: RolePopulation,
): ScaleTable {
  const metrics = momentumMetricIds(role);
  const out: ScaleTable = {};
  if (settings.normalization.method === "level-sd") {
    const pop =
      population ??
      rolePopulation(
        ds,
        role,
        settings.normalization.populationMinOpportunities[role],
      );
    for (const m of metrics) {
      const values = pop.qualified
        .map((id) => metricValue(m, pop.season.get(id) ?? null))
        .filter((v): v is number => v !== null);
      out[m] = finalize(m, values, settings);
    }
    return out;
  }
  const changes: Record<string, number[]> = Object.fromEntries(
    metrics.map((m) => [m, []]),
  );
  if (ds.asOf) {
    const ranges = comparisonRanges(ds, ds.asOf, window);
    const ids = role === "hitter" ? ds.batting.keys() : ds.pitching.keys();
    for (const id of ids) {
      const recent = sampleInRange(ds, role, id, ranges.recent);
      const base = sampleInRange(ds, role, id, ranges.baseline);
      if (
        opportunities(role, recent) <
          settings.sample.leaderboardMinRecent[role][window] ||
        opportunities(role, base) < settings.sample.leaderboardMinBaseline[role]
      )
        continue;
      for (const m of metrics) {
        const r = metricValue(m, recent),
          b = metricValue(m, base);
        if (r !== null && b !== null) changes[m].push(r - b);
      }
    }
  }
  for (const m of metrics) out[m] = finalize(m, changes[m], settings);
  return out;
}
