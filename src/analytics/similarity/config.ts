/**
 * Player similarity configuration (docs/SIMILARITY-METHOD.md, approved D-024). Offline validation only (T-406):
 * nothing here is rendered on the site until the validation passes and the owner approves showing it.
 */

export type SimilarityRole = "hitter" | "pitcher";

export interface SimilarityDimDef {
  key: string;
  label: string;
  /** Number of decimals when a rate is printed. */
  digits: number;
  /** Predicted in the holdout test (skill rates). Usage (BF per appearance) is profile-only. */
  skill: boolean;
}

/**
 * §3 profiles, in order. Every dimension is a ratio of per-game sums (num / den), shrunk toward the level mean
 * with a per-level constant k from split-half reliability. Age vs level is added separately (not a ratio).
 */
export const SIMILARITY_DIMS: Record<SimilarityRole, SimilarityDimDef[]> = {
  hitter: [
    { key: "k", label: "K%", digits: 3, skill: true },
    { key: "bb", label: "BB%", digits: 3, skill: true },
    { key: "iso", label: "ISO", digits: 3, skill: true },
    { key: "babip", label: "BABIP", digits: 3, skill: true },
    { key: "sb", label: "SB rate", digits: 3, skill: true },
  ],
  pitcher: [
    { key: "k", label: "K%", digits: 3, skill: true },
    { key: "bb", label: "BB%", digits: 3, skill: true },
    { key: "hr", label: "HR/BF", digits: 3, skill: true },
    { key: "babip", label: "BABIP", digits: 3, skill: true },
    { key: "bfApp", label: "BF/app", digits: 1, skill: false },
  ],
};

export const AGE_DIM_LABEL = "Age vs level";

export type DistanceKind = "euclidean" | "mahalanobis";

export interface SimilaritySettings {
  /** §4.1 qualification: PA (hitters) / BF (pitchers) at the level. *(calibrate; starting value 100)* */
  minSample: number;
  /** §5 list length. */
  topN: number;
  /** §3 age vs level as a dimension (owner default: on). */
  useAge: boolean;
  /** §4.3 (owner default: weighted Euclidean). */
  distance: DistanceKind;
  /** Minimum players with a known birth date for the level median age (D-020). */
  minAgeSample: number;
  /** D-026: hitters are compared only with hitters of the same position group (C / IF / OF / other). */
  positionGroups: boolean;
  /** D-026: a position group with fewer qualified hitters gets no lists ("not enough similar players"). */
  minGroupSize: number;
}

export const SIMILARITY_SETTINGS: SimilaritySettings = {
  minSample: 100,
  topN: 5,
  useAge: true,
  distance: "euclidean",
  minAgeSample: 20,
  positionGroups: true,
  minGroupSize: 20,
};

/** §6 and §7 validation parameters, fixed before the real-data run. */
export const SIMILARITY_VALIDATION = {
  cutoffs: ["06-15", "07-15", "08-15"],
  /** Post-cutoff PA/BF for a player (or neighbor) to enter the holdout. */
  minPost: 75,
  /** Split-half: the odd-game list is looked up in the even-game top `overlapDepth`. */
  overlapDepth: 10,
  /** Criterion 1: overlap at least this multiple of chance. */
  chanceMultiple: 3,
  /** Criterion 4. */
  minQualified: 50,
  /** Holdout combination weight grid (own · (1 − α) + similar · α), α chosen leave-one-cutoff-out. */
  alphaStep: 0.05,
  bootstrap: 2000,
  /** Face-validity sample per level and role (§6.3: 20 per level). */
  faceValidityPerRole: 10,
  /** Starter-like / reliever-like usage for the automatic usage-mismatch count (BF per appearance). */
  starterBf: 15,
  relieverBf: 8,
  seed: 20261127,
  /** Sensitivity variants (reported only; the approved defaults are what is validated). */
  sensitivityMinSamples: [75, 150],
} as const;

/**
 * Display rules (D-028, owner-approved 2026-11-27, T-408): profile lists are a browsing aid only ("similar so far this
 * season"), never a projection.
 */
export const SIMILARITY_DISPLAY = {
  /** A neighbor below this score is not listed; with none at or above it the list says "no close match". */
  scoreFloor: 70,
  /** Flag a neighbor whose PA/BF differs from the player's by this factor or more. */
  sampleGapFactor: 3,
  /** "Closest" names only dimensions weighted at least this much (§3: reliability 0.3). */
  closestMinWeight: 0.3,
} as const;
