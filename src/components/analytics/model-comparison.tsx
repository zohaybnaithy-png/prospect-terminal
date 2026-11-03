import Link from "next/link";
import type { ComparisonEntry, ModelComparison } from "@/analytics/engine";
import { formatMetric, formatMetricChange } from "@/analytics/metrics";
import { MOMENTUM_MODELS } from "@/analytics/config";
import { MomentumValue, signedText } from "./momentum-parts";

function EntryTable({ title, entries }: { title: string; entries: ComparisonEntry[] }) {
  return (
    <>
      <h4 className="table-title">{title}</h4>
      {entries.length ? (
        <div className="table-scroll" tabIndex={0} role="region" aria-label={title}>
          <table className="data-table compact-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Player</th>
                <th scope="col" className="numeric">Mom.</th>
                <th scope="col" className="numeric">Raw</th>
                <th scope="col" className="numeric">Rel.</th>
                <th scope="col" className="numeric">Sample</th>
                <th scope="col">Persistence</th>
                <th scope="col">Contributions (pts)</th>
                <th scope="col">Before → now</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={e.playerId}>
                  <td className="numeric">{i + 1}</td>
                  <td>
                    <Link className="player-name" href={`/players/${e.playerId}`}>{e.name}</Link>{" "}
                    <span className="small-muted">{e.team?.abbreviation}</span>
                  </td>
                  <td className="numeric"><MomentumValue score={e.score} /></td>
                  <td className="numeric">{e.rawScore === null ? "—" : signedText(e.rawScore)}</td>
                  <td className="numeric" title={e.confidence}>{e.reliability.toFixed(2)}</td>
                  <td className="numeric">{e.sample.recent}/{e.sample.baseline} {e.sample.unit}</td>
                  <td>{e.persistence.level} · {e.persistence.state} · {e.persistence.trendLengthDays}d</td>
                  <td className="small-muted">
                    {e.contributions.map((c) => `${c.label} ${signedText(c.points, 1)}`).join(" · ")}
                  </td>
                  <td className="small-muted">
                    {e.metrics.map((m) => `${m.label} ${formatMetric(m.metric, m.before)}→${formatMetric(m.metric, m.now)} (${formatMetricChange(m.metric, m.delta)})`).join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty-state">No qualified players.</p>
      )}
    </>
  );
}

/** Development review output: candidate Momentum weightings side by side. No winner is chosen. */
export function ModelComparisonView({ cmp }: { cmp: ModelComparison }) {
  return (
    <>
      <section className="page-section">
        <h3 className="table-title">Agreement between candidates</h3>
        <table className="data-table compact-table">
          <thead>
            <tr>
              <th scope="col">Pair</th>
              <th scope="col">Role</th>
              <th scope="col" className="numeric">Spearman ρ</th>
              <th scope="col" className="numeric">Shared top-20</th>
            </tr>
          </thead>
          <tbody>
            {cmp.agreement.map((a) => (
              <tr key={`${a.a}-${a.b}-${a.role}`}>
                <td>{MOMENTUM_MODELS[a.a].label} vs {MOMENTUM_MODELS[a.b].label}</td>
                <td>{a.role}</td>
                <td className="numeric">{a.spearman === null ? "—" : a.spearman.toFixed(2)}</td>
                <td className="numeric">{a.topOverlap}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {cmp.models.map(({ model, hitters, pitchers }) => (
        <section key={model.id} className="page-section model-section">
          <h3>{model.label}</h3>
          <p className="table-note">
            {model.description} Hitter weights:{" "}
            {Object.entries(model.hitter).map(([k, v]) => `${k} ${v}`).join(", ")}. Pitcher weights:{" "}
            {Object.entries(model.pitcher).map(([k, v]) => `${k} ${v}`).join(", ")}.
          </p>
          <EntryTable title="Top hitter Momentum" entries={hitters.top} />
          <EntryTable title="Bottom hitter Momentum" entries={hitters.bottom} />
          <EntryTable title="Top pitcher Momentum" entries={pitchers.top} />
          <EntryTable title="Bottom pitcher Momentum" entries={pitchers.bottom} />
        </section>
      ))}
    </>
  );
}
