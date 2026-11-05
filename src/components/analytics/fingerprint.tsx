import type { Fingerprint } from "@/analytics/engine";
import { formatMetric } from "@/analytics/metrics";

const ordinal = (n: number) => {
  const r = Math.round(n);
  const s = r % 100 >= 11 && r % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[r % 10] ?? "th";
  return `${r}${s}`;
};

function Bar({ pct }: { pct: number | null }) {
  return (
    <span className="pct-bar" aria-hidden="true">
      {pct !== null && <span style={{ width: `${Math.max(2, pct)}%` }} />}
    </span>
  );
}

/** Same-level percentile fingerprint. Expand a category to see its underlying metrics. */
export function DevelopmentFingerprint({ fp, label }: { fp: Fingerprint; label: string }) {
  return (
    <div className="fingerprint">
      <h3 className="table-title">{label}</h3>
      {!fp.qualified && (
        <p className="table-note">
          Below the {fp.minOpportunities} {fp.role === "hitter" ? "PA" : "BF"}
          comparison threshold ({fp.playerOpportunities} so far): percentiles are
          shown against qualified players but are not stable.
        </p>
      )}
      <ul className="fingerprint-list">
        {fp.categories.map((c) => (
          <li key={c.id}>
            <details>
              <summary>
                <span className="fp-label">{c.label}</span>
                <Bar pct={c.percentile} />
                <span className="fp-value">
                  {c.percentile === null ? "—" : ordinal(c.percentile)}
                </span>
              </summary>
              <ul className="fingerprint-metrics">
                {c.metrics.map((m) => (
                  <li key={m.metric}>
                    <span className="fp-label">
                      {m.label} {formatMetric(m.metric, m.value)}
                    </span>
                    <Bar pct={m.percentile} />
                    <span className="fp-value">
                      {m.percentile === null ? "—" : ordinal(m.percentile)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
        <li>
          <div className="fp-row">
            <span className="fp-label">Momentum (14D)</span>
            <Bar pct={fp.momentum.percentile} />
            <span className="fp-value">
              {fp.momentum.percentile === null ? "—" : ordinal(fp.momentum.percentile)}
            </span>
          </div>
        </li>
      </ul>
      <p className="table-note">
        Percentiles are relative to {fp.populationSize}{" "}
        {fp.role === "hitter" ? "hitters" : "pitchers"} with at least{" "}
        {fp.minOpportunities} {fp.role === "hitter" ? "PA" : "BF"} at the same level and
        season — not MLB percentiles or other levels. Momentum percentile is among {fp.momentum.population}{" "}
        players qualified for the 14D change lists.
      </p>
    </div>
  );
}
