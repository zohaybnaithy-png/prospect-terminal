/**
 * Deterministic, rule-based explanations of a Momentum signal. No language model is involved:
 * the sentence is chosen from fixed templates using the computed component contributions.
 */
import type { ComponentId, MomentumSettings } from "./config";
import type { ComponentContribution, ConfidenceLevel } from "./momentum";
import type { PersistenceState } from "./persistence";

export const COMPONENT_LABELS: Record<
  ComponentId,
  { label: string; noun: string; summary: string }
> = {
  production: {
    label: "Production",
    noun: "overall production",
    summary: "OPS",
  },
  power: { label: "Power", noun: "power", summary: "ISO" },
  contact: { label: "Contact", noun: "contact", summary: "K% (lower is better)" },
  discipline: { label: "Discipline", noun: "plate discipline", summary: "BB%" },
  strikeouts: {
    label: "Strikeouts",
    noun: "missing bats",
    summary: "K%, K/9",
  },
  command: {
    label: "Command",
    noun: "command",
    summary: "BB%, BB/9 (lower is better)",
  },
  baserunners: {
    label: "Baserunners",
    noun: "limiting baserunners",
    summary: "WHIP (lower is better)",
  },
  runPrevention: {
    label: "Run prevention",
    noun: "run prevention",
    summary: "ERA (lower is better)",
  },
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Components that drive the signal: same sign as the total and ≥ 25% of the absolute weight. */
export function drivers(contributions: ComponentContribution[], total: number) {
  const dir = Math.sign(total);
  const absTotal = contributions.reduce((a, c) => a + Math.abs(c.weighted), 0);
  if (!dir || !absTotal) return { drivers: [], offsets: [] };
  const sorted = [...contributions].sort(
    (a, b) =>
      Math.abs(b.weighted) - Math.abs(a.weighted) ||
      a.component.localeCompare(b.component),
  );
  return {
    drivers: sorted
      .filter(
        (c) =>
          Math.sign(c.weighted) === dir &&
          Math.abs(c.weighted) >= 0.25 * absTotal,
      )
      .slice(0, 2),
    offsets: sorted.filter(
      (c) =>
        Math.sign(c.weighted) === -dir &&
        Math.abs(c.weighted) >= 0.25 * absTotal,
    ),
  };
}

export function explainMomentum(input: {
  combinedZ: number | null;
  contributions: ComponentContribution[];
  confidence: ConfidenceLevel;
  persistence: PersistenceState;
  settings: MomentumSettings;
}): string {
  const { combinedZ, contributions, confidence, persistence, settings } = input;
  if (combinedZ === null)
    return "Not enough recent and earlier games at this level to measure a change.";
  if (Math.abs(combinedZ) < settings.persistence.activeZ)
    return "Recent performance is close to the player's earlier baseline at this level.";
  const { drivers: lead, offsets } = drivers(contributions, combinedZ);
  const up = combinedZ > 0;
  const nouns = lead.map((c) => COMPONENT_LABELS[c.component].noun);
  const subject =
    nouns.length === 2
      ? `${capitalize(nouns[0])} and ${nouns[1]} are`
      : nouns.length === 1
        ? `${capitalize(nouns[0])} is`
        : "Several small changes are";
  const verb = up
    ? persistence === "emerging"
      ? "driving the recent spike"
      : "driving the rise"
    : persistence === "emerging"
      ? "driving the recent dip"
      : "driving the decline";
  let text = `${subject} ${verb}.`;
  if (offsets.length)
    text += ` ${capitalize(COMPONENT_LABELS[offsets[0].component].noun)} has moved the other way.`;
  if (confidence === "low") text += " Small sample — treat with caution.";
  return text;
}
