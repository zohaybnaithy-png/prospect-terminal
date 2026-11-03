/**
 * Central configuration for Prospect Terminal Analytics V1.
 *
 * Every weight, threshold, window, sample-size parameter and normalization setting used by the
 * Momentum framework lives here. Calculation modules receive these values as parameters and UI
 * components never hardcode them.
 *
 * IMPORTANT: none of the candidate models below is the final Momentum formula. They exist so the
 * candidates can be compared on real AFL data; the final weighting is a human decision.
 */

export type Role = "hitter" | "pitcher";
export type MomentumWindow = "7d" | "14d" | "30d";

export const MOMENTUM_WINDOWS: Record<
  MomentumWindow,
  { days: number; label: string; short: string }
> = {
  "7d": { days: 7, label: "Last 7 days", short: "7D" },
  "14d": { days: 14, label: "Last 14 days", short: "14D" },
  "30d": { days: 30, label: "Last 30 days", short: "30D" },
};
export const MOMENTUM_WINDOW_IDS = Object.keys(
  MOMENTUM_WINDOWS,
) as MomentumWindow[];
export const DEFAULT_MOMENTUM_WINDOW: MomentumWindow = "14d";

export type HitterComponent = "production" | "power" | "contact" | "discipline";
export type PitcherComponent =
  | "strikeouts"
  | "command"
  | "baserunners"
  | "runPrevention";
export type ComponentId = HitterComponent | PitcherComponent;

export const HITTER_COMPONENTS: HitterComponent[] = [
  "production",
  "power",
  "contact",
  "discipline",
];
export const PITCHER_COMPONENTS: PitcherComponent[] = [
  "strikeouts",
  "command",
  "baserunners",
  "runPrevention",
];
export const COMPONENTS_BY_ROLE: Record<Role, ComponentId[]> = {
  hitter: HITTER_COMPONENTS,
  pitcher: PITCHER_COMPONENTS,
};

/**
 * Component → metric weights (within a component). Metric ids refer to src/analytics/metrics.ts.
 * Future tracking metrics (exit velocity, xwOBA, whiff%, Stuff+, ...) are added by registering a
 * metric and listing it here — the Momentum pipeline does not change.
 */
export const COMPONENT_METRICS: Record<
  ComponentId,
  { metric: string; weight: number }[]
> = {
  production: [{ metric: "ops", weight: 1 }],
  power: [{ metric: "iso", weight: 1 }],
  contact: [{ metric: "hitterKPct", weight: 1 }],
  discipline: [{ metric: "hitterBbPct", weight: 1 }],
  strikeouts: [
    { metric: "pitcherKPct", weight: 0.7 },
    { metric: "k9", weight: 0.3 },
  ],
  command: [
    { metric: "pitcherBbPct", weight: 0.7 },
    { metric: "bb9", weight: 0.3 },
  ],
  baserunners: [{ metric: "whip", weight: 1 }],
  runPrevention: [{ metric: "era", weight: 1 }],
};

export type ModelId = "production-heavy" | "skills-heavy" | "balanced";

export interface MomentumModel {
  id: ModelId;
  label: string;
  description: string;
  hitter: Record<HitterComponent, number>;
  pitcher: Record<PitcherComponent, number>;
}

/** Candidate weightings to compare. Weights are renormalized over available components. */
export const MOMENTUM_MODELS: Record<ModelId, MomentumModel> = {
  "production-heavy": {
    id: "production-heavy",
    label: "Production-heavy",
    description:
      "Weights overall results (OPS; WHIP/ERA for pitchers) most heavily.",
    hitter: { production: 0.55, power: 0.2, contact: 0.125, discipline: 0.125 },
    pitcher: {
      strikeouts: 0.2,
      command: 0.15,
      baserunners: 0.3,
      runPrevention: 0.35,
    },
  },
  "skills-heavy": {
    id: "skills-heavy",
    label: "Skills-heavy",
    description:
      "Weights underlying skills (contact, discipline, power; strikeouts and walks for pitchers).",
    hitter: { production: 0.15, power: 0.25, contact: 0.35, discipline: 0.25 },
    pitcher: {
      strikeouts: 0.45,
      command: 0.35,
      baserunners: 0.15,
      runPrevention: 0.05,
    },
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description:
      "Equal hitter components; pitchers favor K/BB skills over ERA.",
    hitter: { production: 0.25, power: 0.25, contact: 0.25, discipline: 0.25 },
    pitcher: {
      strikeouts: 0.3,
      command: 0.25,
      baserunners: 0.25,
      runPrevention: 0.2,
    },
  },
};
export const MODEL_IDS = Object.keys(MOMENTUM_MODELS) as ModelId[];

/**
 * The candidate shown on player pages and discovery views until a final model is approved.
 * PROVISIONAL — awaiting human review of the model comparison output.
 */
export const PROVISIONAL_DISPLAY_MODEL: ModelId = "balanced";

export interface MomentumSettings {
  scoring: {
    /** Combined z is mapped to ±100 with 100·tanh(z / zDivisor). */
    zDivisor: number;
    /** Each metric's standardized change is clamped to ±zClamp before weighting. */
    zClamp: number;
  };
  normalization: {
    /**
     * level-sd: divide a change by the AFL population SD of the metric's season level.
     * change-sd: divide by the population SD of the same window's recent-minus-baseline change.
     */
    method: "level-sd" | "change-sd";
    /** Season opportunities (PA / BF) needed to join the normalization population. */
    populationMinOpportunities: Record<Role, number>;
    /** Below this many qualified players, metric fallbackScale is used instead. */
    minPopulation: number;
  };
  reliability: {
    /**
     * Shrinkage constant k in reliability = n / (n + k), where n is the effective sample of the
     * recent-vs-baseline comparison: n = recent·baseline / (recent + baseline).
     */
    k: Record<Role, number>;
    /** Reliability thresholds for the Low / Medium / High confidence label. */
    levels: { medium: number; high: number };
  };
  sample: {
    /** Hard floors: below these the change is not computed at all (no baseline to compare). */
    minRecent: Record<Role, number>;
    minBaseline: Record<Role, number>;
    /** Discovery-list qualification (Risers/Fallers, map, model comparison). */
    leaderboardMinRecent: Record<Role, Record<MomentumWindow, number>>;
    leaderboardMinBaseline: Record<Role, number>;
    /** Risers/Fallers list only changes at least this large (±score points). */
    leaderboardMinMagnitude: number;
  };
  persistence: {
    /** Days between rolling checkpoints of the same window. */
    stepDays: number;
    /** Number of checkpoints evaluated, including the current one. */
    checkpoints: number;
    /** |combined z| needed for a checkpoint to count as a trend in that direction. */
    activeZ: number;
    /** Checkpoints below this reliability do not count as evidence. */
    minReliability: number;
    /** Change in |z| between the last two checkpoints that marks strengthening / fading. */
    changeDelta: number;
    /** Consecutive agreeing checkpoints that earn full run credit. */
    targetRun: number;
    /** Persistence score = runWeight·runCredit + crossWeight·crossWindowAgreement. */
    runWeight: number;
    crossWeight: number;
    /** Momentum multiplier = floor + (1 − floor)·persistence; a one-window spike keeps `floor`. */
    multiplierFloor: number;
    levels: { medium: number; high: number };
  };
  percentiles: {
    populationMinOpportunities: Record<Role, number>;
  };
}

export const MOMENTUM_SETTINGS: MomentumSettings = {
  scoring: { zDivisor: 1.25, zClamp: 3 },
  normalization: {
    method: "level-sd",
    populationMinOpportunities: { hitter: 30, pitcher: 30 },
    minPopulation: 8,
  },
  reliability: {
    k: { hitter: 25, pitcher: 25 },
    levels: { medium: 0.4, high: 0.6 },
  },
  sample: {
    minRecent: { hitter: 5, pitcher: 5 },
    minBaseline: { hitter: 10, pitcher: 10 },
    leaderboardMinRecent: {
      hitter: { "7d": 10, "14d": 20, "30d": 40 },
      pitcher: { "7d": 8, "14d": 15, "30d": 30 },
    },
    leaderboardMinBaseline: { hitter: 20, pitcher: 15 },
    leaderboardMinMagnitude: 5,
  },
  persistence: {
    stepDays: 7,
    checkpoints: 4,
    activeZ: 0.25,
    minReliability: 0.2,
    changeDelta: 0.15,
    targetRun: 3,
    runWeight: 0.6,
    crossWeight: 0.4,
    multiplierFloor: 0.6,
    levels: { medium: 0.34, high: 0.67 },
  },
  percentiles: {
    populationMinOpportunities: { hitter: 30, pitcher: 30 },
  },
};

/** Display interpretation of the ±100 scale. 0 = performing like the player's own baseline. */
export const MOMENTUM_BANDS: {
  id: string;
  label: string;
  min: number;
  direction: "up" | "down" | "flat";
}[] = [
  { id: "extreme-surge", label: "Extreme surge", min: 75, direction: "up" },
  { id: "strong-up", label: "Strong upward trend", min: 40, direction: "up" },
  { id: "trending-up", label: "Trending up", min: 15, direction: "up" },
  { id: "stable", label: "Stable", min: -14, direction: "flat" },
  { id: "trending-down", label: "Trending down", min: -39, direction: "down" },
  {
    id: "significant-slump",
    label: "Significant slump",
    min: -74,
    direction: "down",
  },
  {
    id: "extreme-decline",
    label: "Extreme decline",
    min: -Infinity,
    direction: "down",
  },
];

/** AFL-relative percentile categories (category percentile = mean of metric percentiles). */
export const PERCENTILE_CATEGORIES: Record<
  Role,
  { id: string; label: string; metrics: string[] }[]
> = {
  hitter: [
    { id: "production", label: "Production", metrics: ["ops", "obp", "slg"] },
    { id: "power", label: "Power", metrics: ["iso", "slg", "hrPct"] },
    { id: "contact", label: "Contact", metrics: ["hitterKPct", "avg"] },
    {
      id: "discipline",
      label: "Discipline",
      metrics: ["hitterBbPct", "bbPerK"],
    },
  ],
  pitcher: [
    {
      id: "strikeouts",
      label: "Strikeouts",
      metrics: ["pitcherKPct", "k9"],
    },
    { id: "command", label: "Command", metrics: ["pitcherBbPct", "bb9"] },
    { id: "kbb", label: "K−BB", metrics: ["kMinusBbPct"] },
    { id: "runPrevention", label: "Run prevention", metrics: ["whip", "era"] },
  ],
};

/** Stats selectable for the Performance × Momentum map's x-axis (AFL season percentile). */
export const MAP_PERFORMANCE_METRICS: Record<Role, string[]> = {
  hitter: ["ops", "iso", "hitterKPct", "hitterBbPct"],
  pitcher: ["kMinusBbPct", "pitcherKPct", "pitcherBbPct", "whip", "era"],
};

/** Map quadrant boundaries: AFL percentile of the x-axis stat, and Momentum score. */
export const MAP_QUADRANT_SPLIT = { percentile: 50, momentum: 0 };

/** Metric shown on the development timeline and in summaries as the "key" recent statistic. */
export const KEY_METRIC: Record<Role, string> = {
  hitter: "ops",
  pitcher: "kMinusBbPct",
};

/** Metrics listed in the "What changed?" card and the model-comparison output. */
export const WHAT_CHANGED_METRICS: Record<Role, string[]> = {
  hitter: ["ops", "iso", "hitterKPct", "hitterBbPct"],
  pitcher: ["pitcherKPct", "pitcherBbPct", "k9", "bb9", "whip", "era"],
};
