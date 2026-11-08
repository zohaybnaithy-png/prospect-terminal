import Link from "next/link";
import type { TopLine } from "@/services/home";
import type { LevelCoverage } from "@/services/competition/model";
import type { LevelId } from "@/services/players/levels";
import type { TopProspectsResult } from "@/services/rankings";
import { PlayerLink } from "@/components/ui/entity-links";
import { SourceTag } from "./source-tag";
import { AflTeamLink } from "@/components/afl/links";
import { shortDate } from "@/lib/format";

/** Notable single-game lines from the latest completed date (descriptive sort only). */
export function LatestLines({
  date,
  hitters,
  pitchers,
  level,
  levelLabel,
}: {
  date: string | null;
  hitters: TopLine[];
  pitchers: TopLine[];
  level: LevelId;
  levelLabel: string;
}) {
  return (
    <section className="home-panel" aria-labelledby="latest-lines-title">
      <div className="home-section-heading">
        <h2 id="latest-lines-title">
          Latest Results <SourceTag kind="live" />
        </h2>
        <span className="small-muted">
          {date
            ? `Top ${levelLabel} box-score lines · ${shortDate(date)}`
            : "No completed games"}
        </span>
      </div>
      {date ? (
        <div className="lines-columns">
          <LineList title="At the plate" lines={hitters} level={level} />
          <LineList title="On the mound" lines={pitchers} level={level} />
        </div>
      ) : (
        <p className="empty-state">
          No completed {levelLabel} games have been ingested.
        </p>
      )}
      <p className="table-note">
        Hitters ordered by total bases, pitchers by strikeouts — a descriptive
        sort of that day&apos;s box scores, not a rating.
      </p>
    </section>
  );
}

function LineList({
  title,
  lines,
  level,
}: {
  title: string;
  lines: TopLine[];
  level: LevelId;
}) {
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
                  <PlayerLink
                    player={{ id: l.playerId, name: l.name }}
                    level={level}
                  />
                  <span className="line-matchup">
                    {l.team && <AflTeamLink team={l.team} level={level} />}
                    {l.opponent && (
                      <>
                        {" vs "}
                        <AflTeamLink team={l.opponent} level={level} />
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

const STATUS_TEXT: Record<LevelCoverage["status"], string> = {
  live: "",
  "no-games": "No completed games",
  "not-ingested": "Not ingested",
  unavailable: "Unavailable",
};

/** Coverage at every level, including levels with no data (shown as such, never hidden). */
export function CoveragePanel({ coverage }: { coverage: LevelCoverage[] }) {
  const lastIngested = coverage
    .map((c) => c.coverage?.lastIngestedAt ?? null)
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1);
  return (
    <section className="home-panel" aria-labelledby="coverage-title">
      <div className="home-section-heading">
        <h2 id="coverage-title">Data Coverage</h2>
        <Link href="/data">Methodology →</Link>
      </div>
      <table className="coverage-levels">
        <caption className="sr-only">Data coverage by level</caption>
        <thead>
          <tr>
            <th scope="col">Level</th>
            <th scope="col">Through</th>
            <th scope="col" className="numeric">
              Games
            </th>
            <th scope="col" className="numeric" title="Hitters / pitchers with lines">
              H / P
            </th>
          </tr>
        </thead>
        <tbody>
          {coverage.map(({ level, status, coverage: c }) => (
            <tr key={level.id}>
              <th scope="row" title={level.label}>
                {status === "live" ? (
                  <Link href={`/?level=${level.id}`}>{level.short}</Link>
                ) : (
                  level.short
                )}
              </th>
              {c && status === "live" ? (
                <>
                  <td>{c.asOf ? shortDate(c.asOf) : "—"}</td>
                  <td className="numeric">{c.gamesFinal.toLocaleString()}</td>
                  <td className="numeric">
                    {c.hitters} / {c.pitchers}
                  </td>
                </>
              ) : (
                <td
                  colSpan={3}
                  className={
                    status === "unavailable" ? "status-down" : "small-muted"
                  }
                >
                  {STATUS_TEXT[status]}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="table-note">
        MLB Stats API box scores; final games with complete box scores only.
        {lastIngested && ` Last ingestion ${shortDate(lastIngested.slice(0, 10))}.`}
      </p>
    </section>
  );
}
