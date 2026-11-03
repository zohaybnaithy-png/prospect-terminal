/**
 * Pure Momentum building blocks: standardized component changes, weighted combination,
 * sample-size reliability, and the ±100 display mapping. No I/O and no snapshot access.
 *
 * Sign convention: a positive standardized change always means the player IMPROVED
 * (e.g. hitter K% falling, pitcher ERA falling), so components can be combined directly.
 */
import {
  COMPONENT_METRICS,
  COMPONENTS_BY_ROLE,
  MOMENTUM_BANDS,
  type ComponentId,
  type MomentumModel,
  type MomentumSettings,
  type Role,
} from "./config";
import {
  metricDefinition,
  metricValue,
  type HitterSample,
  type PitcherSample,
} from "./metrics";
import type { ScaleTable } from "./population";
import { clamp } from "./stats";

export interface MetricChange {
  metric: string;
  label: string;
  before: number | null;
  now: number | null;
  /** Raw change in metric units (now − before); null when either side is missing. */
  delta: number | null;
  /** Standardized, direction-adjusted, clamped change (positive = improvement). */
  z: number | null;
  scale: number;
}
export interface ComponentChange {
  component: ComponentId;
  /** Weighted mean of the component's metric z values; null when every metric is missing. */
  z: number | null;
  metrics: MetricChange[];
}

export function metricChange(
  metric: string,
  baseline: HitterSample | PitcherSample | null,
  recent: HitterSample | PitcherSample | null,
  scales: ScaleTable,
  settings: MomentumSettings,
): MetricChange {
  const def = metricDefinition(metric);
  const before = metricValue(metric, baseline);
  const now = metricValue(metric, recent);
  const scale = Math.max(
    scales[metric]?.scale ?? def.fallbackScale,
    def.minScale,
  );
  const delta = before !== null && now !== null ? now - before : null;
  const z =
    delta === null
      ? null
      : clamp(
          (def.direction * delta) / scale,
          -settings.scoring.zClamp,
          settings.scoring.zClamp,
        );
  return { metric, label: def.label, before, now, delta, z, scale };
}

export function componentChanges(
  role: Role,
  baseline: HitterSample | PitcherSample | null,
  recent: HitterSample | PitcherSample | null,
  scales: ScaleTable,
  settings: MomentumSettings,
): ComponentChange[] {
  return COMPONENTS_BY_ROLE[role].map((component) => {
    const parts = COMPONENT_METRICS[component].map((m) => ({
      weight: m.weight,
      change: metricChange(m.metric, baseline, recent, scales, settings),
    }));
    const usable = parts.filter((p) => p.change.z !== null && p.weight > 0);
    const totalWeight = usable.reduce((a, p) => a + p.weight, 0);
    return {
      component,
      z: totalWeight
        ? usable.reduce((a, p) => a + p.weight * p.change.z!, 0) / totalWeight
        : null,
      metrics: parts.map((p) => p.change),
    };
  });
}

export interface ComponentContribution {
  component: ComponentId;
  z: number;
  /** Model weight renormalized over the components that have data. */
  weight: number;
  /** weight · z — this component's share of the combined standardized change. */
  weighted: number;
}

/** Weighted combination; missing components are excluded and the remaining weights renormalize. */
export function combineComponents(
  role: Role,
  changes: ComponentChange[],
  model: MomentumModel,
): { z: number | null; contributions: ComponentContribution[] } {
  const weights = model[role] as Record<string, number>;
  const usable = changes.filter(
    (c) => c.z !== null && (weights[c.component] ?? 0) > 0,
  );
  const total = usable.reduce((a, c) => a + weights[c.component], 0);
  if (!total) return { z: null, contributions: [] };
  const contributions = usable.map((c) => {
    const weight = weights[c.component] / total;
    return { component: c.component, z: c.z!, weight, weighted: weight * c.z! };
  });
  return {
    z: contributions.reduce((a, c) => a + c.weighted, 0),
    contributions,
  };
}

/**
 * Reliability in [0, 1) of a recent-vs-baseline comparison. The variance of a difference of two
 * sample rates scales with 1/recent + 1/baseline, so the effective sample is their harmonic
 * combination; reliability = n_eff / (n_eff + k). A tiny recent OR tiny baseline sample both
 * shrink the signal toward 0.
 */
export function reliability(
  role: Role,
  recentOpportunities: number,
  baselineOpportunities: number,
  settings: MomentumSettings,
): number {
  if (recentOpportunities <= 0 || baselineOpportunities <= 0) return 0;
  const nEff =
    (recentOpportunities * baselineOpportunities) /
    (recentOpportunities + baselineOpportunities);
  const k = settings.reliability.k[role];
  return k > 0 ? nEff / (nEff + k) : 1;
}

export type ConfidenceLevel = "low" | "medium" | "high";
export function confidenceLevel(
  r: number,
  settings: MomentumSettings,
): ConfidenceLevel {
  if (r >= settings.reliability.levels.high) return "high";
  if (r >= settings.reliability.levels.medium) return "medium";
  return "low";
}

/** Bounded mapping of a combined standardized change to the ±100 display scale. */
export function zToScore(z: number, settings: MomentumSettings) {
  return 100 * Math.tanh(z / settings.scoring.zDivisor);
}

export function momentumBand(score: number) {
  const rounded = Math.round(score);
  return MOMENTUM_BANDS.find((b) => rounded >= b.min) ?? MOMENTUM_BANDS.at(-1)!;
}
