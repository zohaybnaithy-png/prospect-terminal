/**
 * Breakout detection parameters (docs/BREAKOUT-METHOD.md, approved as proposed: D-021).
 *
 * Owner decisions are marked (owner); starting values the validation reports on are marked (calibrate).
 * Nothing here is shown to users: the detector exists only for the offline validation (T-405).
 */
export type BreakoutRole = "hitter" | "pitcher";

export interface BreakoutMetricDef {
  id: string;
  label: string;
  role: BreakoutRole;
  /** +1: higher is better; −1: lower is better. */
  direction: 1 | -1;
  /** binomial: count / opportunities (K%, BB%); ratio: a non-proportion ratio (ISO). */
  kind: "binomial" | "ratio";
}

/** §3 signals. Per-game counts are [opportunities (PA/BF), then one numerator/denominator pair per metric]. */
export const BREAKOUT_METRICS: Record<BreakoutRole, BreakoutMetricDef[]> = {
  hitter: [
    { id: "k", label: "K%", role: "hitter", direction: -1, kind: "binomial" },
    { id: "bb", label: "BB%", role: "hitter", direction: 1, kind: "binomial" },
    { id: "iso", label: "ISO", role: "hitter", direction: 1, kind: "ratio" },
  ],
  pitcher: [
    { id: "k", label: "K%", role: "pitcher", direction: 1, kind: "binomial" },
    { id: "bb", label: "BB%", role: "pitcher", direction: -1, kind: "binomial" },
  ],
};

export interface BreakoutSettings {
  /** §4.1 block minimums in PA (hitters) / BF (pitchers). (calibrate) */
  nRecent: number;
  nEarlier: number;
  /** §4.4.1 Benjamini–Hochberg level. (owner) */
  fdrQ: number;
  /** §4.4 "Watch": one-sided permutation p before false-discovery control. */
  watchP: number;
  /** §4.4.2 minimum composite effect, in level SDs. (calibrate) */
  minEffect: number;
  /** §4.4.3 level-standing percentile of the recent-block composite (0–1). (owner) */
  standingPercentile: number;
  /** §4.4.4 earlier weekly checkpoints, and how many of them must also meet criteria 1–3. (owner) */
  checkpointStepDays: number;
  checkpoints: number;
  checkpointsRequired: number;
  /** §6.1: a metric whose reliability at nRecent is below this is dropped at that level. */
  minReliabilityAtRecent: number;
  /**
   * Test statistic for criterion 1 (§4.3). "shrunk-over-raw-se" is the approved text: shrunk change / raw-rate SE.
   * "raw" is the standard two-sample statistic (raw change / raw SE), kept as an owner option only; shrinkage
   * still sets effect and standing either way, and p-values always come from the permutation null.
   */
  statistic: "shrunk-over-raw-se" | "raw";
  /** Permutation null (§6.2): shuffles per player used to build the pooled null of the composite z. */
  nullShufflesPerPlayer: number;
  /** The pooled null is rebuilt on a grid of this many days (it changes slowly over a season). */
  nullGridDays: number;
}

export const BREAKOUT_SETTINGS: BreakoutSettings = {
  nRecent: 100,
  nEarlier: 100,
  fdrQ: 0.1,
  watchP: 0.05,
  minEffect: 0.5,
  standingPercentile: 0.7,
  checkpointStepDays: 7,
  checkpoints: 3,
  checkpointsRequired: 2,
  minReliabilityAtRecent: 0.3,
  statistic: "shrunk-over-raw-se",
  nullShufflesPerPlayer: 50,
  nullGridDays: 7,
};

/** §6 validation settings. */
export const BREAKOUT_VALIDATION = {
  /** Holdout cutoffs (month-day, in the snapshot's season year). */
  cutoffs: ["06-15", "07-15", "08-15"],
  /** Minimum post-cutoff sample at the same level. */
  minPost: 75,
  /** Matched controls: earlier-block composite within ± this many SDs, earlier sample within ± this share. */
  controlCompositeTolerance: 0.25,
  controlSampleTolerance: 0.25,
  /** Promotion window reported after a flag (days). */
  promotionDays: 45,
  /** Churn: a flag that switches off within this many days of switching on counts as churn. */
  churnDays: 14,
  /** Full-detector null runs per level (§6.2). */
  nullRuns: 1000,
  /** Bootstrap resamples (reliability intervals, control-difference interval, ISO SE check). */
  bootstrap: 2000,
  seed: 20261126,
  /** §7 success criteria. */
  criteria: {
    maxNullFlagsPerDate: 1,
    minRetention: 0.5,
    maxChurn: 0.2,
    minFlagsPerCutoff: 10,
  },
} as const;
