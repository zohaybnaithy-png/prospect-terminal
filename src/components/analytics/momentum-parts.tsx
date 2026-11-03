/**
 * Small presentational pieces for Momentum. No calculations: every value arrives precomputed
 * from src/analytics. Safe to render from server or client components.
 */
import type { ConfidenceLevel } from "@/analytics/momentum";
import type { PersistenceResult } from "@/analytics/persistence";
import { PERSISTENCE_STATE_LABELS } from "@/analytics/persistence";
import type { Contribution, MomentumResult } from "@/analytics/engine";

const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};
const LEVEL_BARS: Record<ConfidenceLevel, number> = { low: 1, medium: 2, high: 3 };

export function MomentumValue({
  score,
  large = false,
}: {
  score: number | null;
  large?: boolean;
}) {
  if (score === null)
    return <span className="momentum-value flat placeholder-value">—</span>;
  const dir = score >= 15 ? "up" : score <= -15 ? "down" : "flat";
  return (
    <span className={`momentum-value ${dir}${large ? " large" : ""}`}>
      {score > 0 ? "+" : score < 0 ? "−" : ""}
      {Math.abs(score)}
      <span aria-hidden="true" className="momentum-arrow">
        {dir === "up" ? "↑" : dir === "down" ? "↓" : "→"}
      </span>
    </span>
  );
}

/** Three-step meter shared by confidence (sample size) and persistence. */
export function LevelMeter({
  level,
  label,
  title,
}: {
  level: ConfidenceLevel;
  label: string;
  title?: string;
}) {
  return (
    <span className="level-meter" title={title}>
      <span className="level-meter-label">{label}</span>
      <span className="level-bars" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <i key={i} className={i <= LEVEL_BARS[level] ? "on" : ""} />
        ))}
      </span>
      <strong>{CONFIDENCE_LABEL[level]}</strong>
    </span>
  );
}

export function persistenceText(
  p: Pick<PersistenceResult, "state" | "trendLengthDays">,
) {
  if (p.state === "insufficient" || p.state === "neutral")
    return PERSISTENCE_STATE_LABELS[p.state];
  return `${PERSISTENCE_STATE_LABELS[p.state]} · ${p.trendLengthDays} days`;
}

export function MomentumMeta({ m }: { m: MomentumResult }) {
  return (
    <span className="momentum-meta">
      <LevelMeter
        level={m.persistence.level}
        label="Persistence"
        title="How consistently the change has held across rolling windows"
      />
      <span className="small-muted">{persistenceText(m.persistence)}</span>
      <LevelMeter
        level={m.confidence}
        label="Confidence"
        title={`Sample reliability ${m.reliability.toFixed(2)}: ${m.sample.recent} recent ${m.sample.unit} vs ${m.sample.baseline} earlier ${m.sample.unit}`}
      />
    </span>
  );
}

/** Horizontal contribution bars, centered at 0, in score points. */
export function Decomposition({ m }: { m: MomentumResult }) {
  if (!m.contributions.length)
    return <p className="small-muted">{m.explanation}</p>;
  const max = Math.max(
    20,
    ...m.contributions.map((c) => Math.abs(c.points)),
  );
  const describe = (c: Contribution) => {
    const a = Math.abs(c.points);
    const size = a < 2 ? "neutral" : a < 6 ? "slight" : a < 15 ? "moderate" : "strong";
    if (size === "neutral") return "little effect";
    return `${size} ${c.points > 0 ? "positive" : "negative"}`;
  };
  return (
    <div className="decomposition">
      <table className="decomposition-table">
        <caption className="sr-only">Momentum decomposition by component</caption>
        <tbody>
          {m.contributions.map((c) => (
            <tr key={c.component}>
              <th scope="row">{c.label}</th>
              <td className="decomp-bar-cell" aria-hidden="true">
                <span className="decomp-axis" />
                <span
                  className={`decomp-bar ${c.points >= 0 ? "pos" : "neg"}`}
                  style={
                    c.points >= 0
                      ? { width: `${(50 * c.points) / max}%`, left: "50%" }
                      : { width: `${(-50 * c.points) / max}%`, right: "50%" }
                  }
                />
              </td>
              <td className="numeric">
                {c.points > 0 ? "+" : c.points < 0 ? "−" : ""}
                {Math.abs(c.points).toFixed(1)}
              </td>
              <td className="small-muted decomp-desc">
                {describe(c)} · weight {Math.round(c.weight * 100)}%
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row">Persistence</th>
            <td colSpan={3} className="small-muted">
              {CONFIDENCE_LABEL[m.persistence.level]} — {persistenceText(m.persistence)}{" "}
              (×{m.persistence.multiplier.toFixed(2)})
            </td>
          </tr>
          <tr>
            <th scope="row">Confidence</th>
            <td colSpan={3} className="small-muted">
              {CONFIDENCE_LABEL[m.confidence]} — {m.sample.recent} recent vs{" "}
              {m.sample.baseline} earlier {m.sample.unit} (reliability{" "}
              {m.reliability.toFixed(2)})
            </td>
          </tr>
        </tbody>
      </table>
      {m.rawScore !== null && (
        <p className="table-note">
          Raw change signal {signedText(m.rawScore)} → after sample-size
          shrinkage {signedText(m.reliabilityAdjusted ?? 0)} → after persistence{" "}
          {signedText(m.score ?? 0)}. Bars show each component&apos;s share of the
          final value.
        </p>
      )}
    </div>
  );
}

export const signedText = (v: number, digits = 0) =>
  `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;
