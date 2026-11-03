/**
 * Trend Persistence: does an improvement (or decline) relative to baseline hold up across time?
 *
 * Inputs are rolling checkpoints of the SAME window (e.g. the 14-day window ending today, 7 days
 * ago, 14 days ago, ...) each compared with everything before it, plus the current signal in the
 * other windows (7D / 14D / 30D). Checkpoints carry the combined component z (all Momentum
 * components, not batting average) and their reliability.
 */
import type { MomentumSettings } from "./config";
import { clamp } from "./stats";

export interface Checkpoint {
  /** Last date of the checkpoint's recent window. */
  end: string;
  /** Combined standardized change at that checkpoint; null when not computable. */
  z: number | null;
  reliability: number;
}

export type PersistenceState =
  | "insufficient" // no current signal
  | "neutral" // current change too small to call a trend
  | "emerging" // only the most recent checkpoint shows it
  | "strengthening" // persisted, and larger than the previous checkpoint
  | "sustained" // persisted at a similar magnitude
  | "fading" // persisted, but smaller than the previous checkpoint
  | "reversed"; // previous checkpoint trended the other way

export type PersistenceLevel = "low" | "medium" | "high";

export interface PersistenceResult {
  state: PersistenceState;
  /** 0–1 persistence credit. */
  score: number;
  level: PersistenceLevel;
  /** Consecutive agreeing checkpoints, counting back from the current one. */
  runLength: number;
  /** Days covered by the agreeing run (first window start → latest date), 0 when none. */
  trendLengthDays: number;
  /** Share of other comparison windows pointing the same direction (0–1). */
  crossWindowAgreement: number;
  /** Multiplier applied to Momentum: floor + (1 − floor) · score. */
  multiplier: number;
  direction: 1 | -1 | 0;
}

const isEvidence = (c: Checkpoint, s: MomentumSettings["persistence"]) =>
  c.z !== null && c.reliability >= s.minReliability;

/**
 * @param checkpoints latest first; checkpoints[0] is the current signal.
 * @param windowDays  length of the window the checkpoints use.
 * @param otherWindows current combined z for the other comparison windows (null = unavailable).
 */
export function trendPersistence(
  checkpoints: Checkpoint[],
  windowDays: number,
  otherWindows: (number | null)[],
  settings: MomentumSettings,
): PersistenceResult {
  const s = settings.persistence;
  const none = (state: PersistenceState): PersistenceResult => ({
    state,
    score: 0,
    level: "low",
    runLength: 0,
    trendLengthDays: 0,
    crossWindowAgreement: 0,
    multiplier: s.multiplierFloor,
    direction: 0,
  });
  const current = checkpoints[0];
  if (!current || current.z === null) return none("insufficient");
  if (Math.abs(current.z) < s.activeZ) return none("neutral");
  const direction: 1 | -1 = current.z > 0 ? 1 : -1;
  const agrees = (c: Checkpoint) =>
    isEvidence(c, s) && direction * c.z! >= s.activeZ;

  let runLength = 0;
  for (const c of checkpoints) {
    if (!agrees(c)) break;
    runLength++;
  }
  // The current checkpoint may itself be too unreliable to count; it still sets the direction.
  const previous = checkpoints[1];
  let state: PersistenceState;
  if (
    previous &&
    isEvidence(previous, s) &&
    direction * previous.z! <= -s.activeZ
  )
    state = "reversed";
  else if (runLength <= 1) state = "emerging";
  else {
    const diff = Math.abs(current.z) - Math.abs(previous!.z!);
    state =
      diff > s.changeDelta
        ? "strengthening"
        : diff < -s.changeDelta
          ? "fading"
          : "sustained";
  }

  const available = otherWindows.filter((z): z is number => z !== null);
  const crossWindowAgreement = available.length
    ? available.filter((z) => direction * z >= s.activeZ).length /
      available.length
    : 0;
  const runCredit =
    s.targetRun > 1 ? clamp((runLength - 1) / (s.targetRun - 1), 0, 1) : 1;
  const score = clamp(
    s.runWeight * runCredit + s.crossWeight * crossWindowAgreement,
    0,
    1,
  );
  const trendLengthDays =
    runLength > 0 ? (runLength - 1) * s.stepDays + windowDays : 0;
  return {
    state,
    score,
    level:
      score >= s.levels.high ? "high" : score >= s.levels.medium ? "medium" : "low",
    runLength,
    trendLengthDays,
    crossWindowAgreement,
    multiplier: s.multiplierFloor + (1 - s.multiplierFloor) * score,
    direction,
  };
}

export const PERSISTENCE_STATE_LABELS: Record<PersistenceState, string> = {
  insufficient: "Not enough data",
  neutral: "No clear trend",
  emerging: "Recent only",
  strengthening: "Strengthening",
  sustained: "Sustained",
  fading: "Fading",
  reversed: "Reversed",
};
