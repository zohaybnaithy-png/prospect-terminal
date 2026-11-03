/**
 * Metric registry. A metric reads one value from an aggregated sample of a role.
 *
 * Samples are the shared statistics aggregates (summed raw counts → rates). When richer data is
 * ingested (exit velocity, xwOBA, whiff%, pitch velocity, Stuff+ ...), extend the sample type with
 * optional fields, register metrics that return null when the field is absent, and reference them
 * from COMPONENT_METRICS / PERCENTILE_CATEGORIES. Nothing else in the pipeline changes, and missing
 * values are excluded (weights renormalize) rather than invented.
 */
import type { aggregateBatting, aggregatePitching } from "@/statistics/aggregate";
import type { Role } from "./config";

export type HitterSample = ReturnType<typeof aggregateBatting>;
export type PitcherSample = ReturnType<typeof aggregatePitching>;
export type SampleFor<R extends Role> = R extends "hitter"
  ? HitterSample
  : PitcherSample;

export type MetricFormat = "rate3" | "pct1" | "fixed2" | "ratio2";

export interface MetricDefinition<R extends Role = Role> {
  id: string;
  label: string;
  role: R;
  /** +1 when higher is better for the player, −1 when lower is better (K% for hitters, ERA). */
  direction: 1 | -1;
  format: MetricFormat;
  value: (sample: SampleFor<R>) => number | null;
  /** Lower bound for the normalization scale, in metric units (prevents division by ~0). */
  minScale: number;
  /** Scale used only when the AFL population is too small to estimate one. */
  fallbackScale: number;
}

const per = (n: number, d: number, k = 1) => (d > 0 ? (k * n) / d : null);

const hitter = (m: Omit<MetricDefinition<"hitter">, "role">) =>
  ({ ...m, role: "hitter" }) as MetricDefinition<"hitter">;
const pitcher = (m: Omit<MetricDefinition<"pitcher">, "role">) =>
  ({ ...m, role: "pitcher" }) as MetricDefinition<"pitcher">;

export const HITTER_METRICS: MetricDefinition<"hitter">[] = [
  hitter({
    id: "ops",
    label: "OPS",
    direction: 1,
    format: "rate3",
    value: (s) => s.ops,
    minScale: 0.04,
    fallbackScale: 0.15,
  }),
  hitter({
    id: "obp",
    label: "OBP",
    direction: 1,
    format: "rate3",
    value: (s) => s.obp,
    minScale: 0.02,
    fallbackScale: 0.06,
  }),
  hitter({
    id: "slg",
    label: "SLG",
    direction: 1,
    format: "rate3",
    value: (s) => s.slg,
    minScale: 0.03,
    fallbackScale: 0.1,
  }),
  hitter({
    id: "avg",
    label: "AVG",
    direction: 1,
    format: "rate3",
    value: (s) => s.avg,
    minScale: 0.02,
    fallbackScale: 0.05,
  }),
  hitter({
    id: "iso",
    label: "ISO",
    direction: 1,
    format: "rate3",
    value: (s) => (s.slg !== null && s.avg !== null ? s.slg - s.avg : null),
    minScale: 0.025,
    fallbackScale: 0.07,
  }),
  hitter({
    id: "hitterKPct",
    label: "K%",
    direction: -1,
    format: "pct1",
    value: (s) => s.kPct,
    minScale: 2,
    fallbackScale: 6,
  }),
  hitter({
    id: "hitterBbPct",
    label: "BB%",
    direction: 1,
    format: "pct1",
    value: (s) => s.bbPct,
    minScale: 1.5,
    fallbackScale: 4,
  }),
  hitter({
    id: "hrPct",
    label: "HR%",
    direction: 1,
    format: "pct1",
    value: (s) => per(s.homeRuns, s.plateAppearances, 100),
    minScale: 0.75,
    fallbackScale: 2,
  }),
  hitter({
    id: "bbPerK",
    label: "BB/K",
    direction: 1,
    format: "ratio2",
    value: (s) => per(s.walks, s.strikeouts),
    minScale: 0.1,
    fallbackScale: 0.3,
  }),
];

export const PITCHER_METRICS: MetricDefinition<"pitcher">[] = [
  pitcher({
    id: "pitcherKPct",
    label: "K%",
    direction: 1,
    format: "pct1",
    value: (s) => s.kPct,
    minScale: 2.5,
    fallbackScale: 7,
  }),
  pitcher({
    id: "pitcherBbPct",
    label: "BB%",
    direction: -1,
    format: "pct1",
    value: (s) => s.bbPct,
    minScale: 1.5,
    fallbackScale: 4,
  }),
  pitcher({
    id: "kMinusBbPct",
    label: "K−BB%",
    direction: 1,
    format: "pct1",
    value: (s) =>
      s.kPct !== null && s.bbPct !== null ? s.kPct - s.bbPct : null,
    minScale: 3,
    fallbackScale: 8,
  }),
  pitcher({
    id: "k9",
    label: "K/9",
    direction: 1,
    format: "fixed2",
    value: (s) => per(s.strikeouts, s.outsRecorded, 27),
    minScale: 1,
    fallbackScale: 3,
  }),
  pitcher({
    id: "bb9",
    label: "BB/9",
    direction: -1,
    format: "fixed2",
    value: (s) => per(s.walks, s.outsRecorded, 27),
    minScale: 0.5,
    fallbackScale: 2,
  }),
  pitcher({
    id: "whip",
    label: "WHIP",
    direction: -1,
    format: "fixed2",
    value: (s) => s.whip,
    minScale: 0.15,
    fallbackScale: 0.45,
  }),
  pitcher({
    id: "era",
    label: "ERA",
    direction: -1,
    format: "fixed2",
    value: (s) => s.era,
    minScale: 0.75,
    fallbackScale: 3,
  }),
];

const registry = new Map<string, MetricDefinition>(
  [...HITTER_METRICS, ...PITCHER_METRICS].map((m) => [
    m.id,
    m as MetricDefinition,
  ]),
);

export function metricDefinition(id: string): MetricDefinition {
  const m = registry.get(id);
  if (!m) throw new Error(`Unknown analytics metric: ${id}`);
  return m;
}

/** Reads a metric value; non-finite results are treated as missing, never coerced to 0. */
export function metricValue(
  id: string,
  sample: HitterSample | PitcherSample | null,
): number | null {
  if (!sample) return null;
  const v = (metricDefinition(id).value as (s: unknown) => number | null)(
    sample,
  );
  return v === null || !Number.isFinite(v) ? null : v;
}

/** Opportunity measure used for sample size: PA for hitters, batters faced for pitchers. */
export function opportunities(
  role: Role,
  sample: HitterSample | PitcherSample | null,
): number {
  if (!sample) return 0;
  return role === "hitter"
    ? (sample as HitterSample).plateAppearances
    : (sample as PitcherSample).battersFaced;
}
export const OPPORTUNITY_LABEL: Record<Role, string> = {
  hitter: "PA",
  pitcher: "BF",
};

/** Compact, dependency-free formatting for metric values and changes. */
export function formatMetric(id: string, value: number | null): string {
  if (value === null) return "—";
  switch (metricDefinition(id).format) {
    case "rate3":
      return value.toFixed(3).replace(/^(-?)0(?=\.)/, "$1");
    case "pct1":
      return `${value.toFixed(1)}%`;
    case "fixed2":
    case "ratio2":
      return value.toFixed(2);
  }
}
export function formatMetricChange(id: string, delta: number | null): string {
  if (delta === null) return "—";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  const abs = Math.abs(delta);
  switch (metricDefinition(id).format) {
    case "rate3":
      return `${sign}${abs.toFixed(3).replace(/^0(?=\.)/, "")}`;
    case "pct1":
      return `${sign}${abs.toFixed(1)}`;
    case "fixed2":
    case "ratio2":
      return `${sign}${abs.toFixed(2)}`;
  }
}
