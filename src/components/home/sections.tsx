import Link from "next/link";
import type { CoverageSummary, TopLine } from "@/services/home";
import type { TopProspectsResult } from "@/services/rankings";
import { PlayerLink } from "@/components/ui/entity-links";
import { AflTeamLink } from "@/components/afl/links";
import { shortDate } from "@/lib/format";

/** Notable single-game lines from the latest completed date (descriptive sort only). */
export function LatestLines({
  date,
  hitters,
  pitchers,
}: {
  date: string | null;
  hitters: TopLine[];
  pitchers: TopLine[];
}) {
  return (
    <section className="home-panel" aria-labelledby="latest-lines-title">
      <div className="home-section-heading">
        <h2 id="latest-lines-title">Latest Results</h2>
        <span className="small-muted">
          {date
            ? `Top box-score lines · ${shortDate(date)}`
            : "No completed games"}
        </span>
      </div>
      {date ? (
        <div className="lines-columns">
          <LineList title="At the plate" lines={hitters} />
          <LineList title="On the mound" lines={pitchers} />
        </div>
      ) : (
        <p className="empty-state">
          No completed AFL games have been ingested.
        </p>
      )}
      <p className="table-note">
        Hitters ordered by total bases, pitchers by strikeouts — a descriptive
        sort of that day&apos;s box scores, not a rating.
      </p>
    </section>
  );
}

function LineList({ title, lines }: { title: string; lines: TopLine[] }) {
  return (
    <div>
      <h3 className="mini-heading">{title}</h3>
      {lines.length ? (
        <table className="line-table">
          <caption className="sr-only">{title}</caption>
          <tbody>
            {lines.map((l) => (
              <tr key={`${l.playerId}-${l.line}`}>
                <th scope="row">
                  <PlayerLink player={{ id: l.playerId, name: l.name }} />
                  <span className="line-matchup">
                    {l.team && <AflTeamLink team={l.team} />}
                    {l.opponent && (
                      <>
                        {" vs "}
                        <AflTeamLink team={l.opponent} />
                      </>
                    )}
                  </span>
                </th>
                <td>{l.line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty-state">No lines recorded.</p>
      )}
    </div>
  );
}

/** MLB-wide rankings: honest unavailable state until a legitimate source exists. */
export function TopProspectsPanel({ result }: { result: TopProspectsResult }) {
  return (
    <section className="home-panel" aria-labelledby="top-prospects-title">
      <div className="home-section-heading">
        <h2 id="top-prospects-title">MLB Top Prospects</h2>
        {result.status === "ok" && (
          <span className="small-muted">
            {result.source} · {shortDate(result.asOf)}
          </span>
        )}
      </div>
      {result.status === "ok" ? (
        <ol className="ranking-list">
          {result.entries.map((e) => (
            <li key={e.rank}>
              <span className="list-rank">{e.rank}</span>
              {e.playerId ? (
                <PlayerLink player={{ id: e.playerId, name: e.name }} />
              ) : (
                <span>{e.name}</span>
              )}
              <span className="small-muted">
                {[e.position, e.organization, e.level]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="unavailable-panel" role="status">
          <strong>Rankings not yet available</strong>
          <p>
            Overall prospect rankings will appear here once a licensed ranking
            source or the Prospect Terminal Grade is ready. No list is shown
            until then.
          </p>
          <Link href="/data#in-development">What&apos;s in development →</Link>
        </div>
      )}
    </section>
  );
}

export function CoveragePanel({ coverage }: { coverage: CoverageSummary }) {
  const rows: [string, string][] = [
    ["Through", coverage.asOf ? shortDate(coverage.asOf) : "—"],
    ["Final games", String(coverage.gamesFinal)],
    ["Scheduled", String(coverage.gamesScheduled)],
    ["Hitters / pitchers", `${coverage.hitters} / ${coverage.pitchers}`],
    ["League OPS", coverage.leagueOps],
    [
      "Last ingestion",
      coverage.lastIngestedAt
        ? shortDate(coverage.lastIngestedAt.slice(0, 10))
        : "—",
    ],
  ];
  return (
    <section className="home-panel" aria-labelledby="coverage-title">
      <div className="home-section-heading">
        <h2 id="coverage-title">Data Coverage</h2>
        <Link href="/data">Methodology →</Link>
      </div>
      <dl className="coverage-list">
        <div className="coverage-source">
          <dt>Source</dt>
          <dd>{coverage.season} · MLB Stats API box scores</dd>
        </div>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="table-note">
        Affiliated MiLB levels (AAA → Single-A) are added when MiLB ingestion
        lands.
      </p>
    </section>
  );
}
