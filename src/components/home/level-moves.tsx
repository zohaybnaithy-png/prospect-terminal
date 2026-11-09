import Link from "next/link";
import type { LevelMove } from "@/services/competition/moves";
import { levelById, type LevelId } from "@/services/players/levels";
import { PlayerLink } from "@/components/ui/entity-links";
import { AflTeamLink } from "@/components/afl/links";
import { shortDate } from "@/lib/format";
import { SourceTag } from "./source-tag";
import { ScrollRegion } from "@/components/ui/scroll-region";

/**
 * Call-ups and other level changes as observed in box scores (first game at a new MiLB level).
 * Labeled as observed evidence: official transactions are not ingested.
 */
export function LevelMoves({ moves, level }: { moves: LevelMove[]; level?: LevelId }) {
  const scope = level && level !== "afl" ? levelById(level).label : "MiLB";
  return (
    <section className="home-panel" aria-labelledby="moves-title">
      <div className="home-section-heading">
        <h2 id="moves-title">
          Level Moves <SourceTag kind="live" />
        </h2>
        <Link href="/players">Player directory →</Link>
      </div>
      {moves.length ? (
        <ScrollRegion label={`Most recent ${scope} level moves`} className="moves-scroll">
          <table className="data-table moves-table">
            <caption className="sr-only">Most recent {scope} level moves observed in box scores</caption>
            <thead>
              <tr>
                <th scope="col">First game</th>
                <th scope="col">Player</th>
                <th scope="col">Move</th>
                <th scope="col">Team</th>
                <th scope="col" className="numeric" title="Games at the new level since the move">
                  G since
                </th>
              </tr>
            </thead>
            <tbody>
              {moves.map((m) => (
                <tr key={`${m.playerId}-${m.to}`}>
                  <td>
                    <time dateTime={m.date}>{shortDate(m.date)}</time>
                  </td>
                  <td>
                    <PlayerLink player={{ id: m.playerId, name: m.name }} level={m.to} />
                  </td>
                  <td>
                    <span className="level-tag" title={levelById(m.from).label}>
                      {levelById(m.from).short}
                    </span>
                    <span className={m.up ? "move-arrow up" : "move-arrow down"} aria-hidden="true">
                      {m.up ? " ↗ " : " ↘ "}
                    </span>
                    <span className="sr-only">{m.up ? " promoted to " : " moved to "}</span>
                    <span className="level-tag" title={levelById(m.to).label}>
                      {levelById(m.to).short}
                    </span>
                  </td>
                  <td>{m.team ? <AflTeamLink team={m.team} level={m.to} /> : "—"}</td>
                  <td className="numeric">{m.games}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      ) : (
        <p className="empty-state">No level moves observed in {scope} box scores this season.</p>
      )}
      <p className="table-note">
        A player&apos;s first game at a new {scope === "MiLB" ? "MiLB level" : `level (to or from ${scope})`}{" "}
        after playing at another level this season, read from box scores. Not an official transaction
        feed: rehab and short assignments look the same, and the move date is the first game played.
      </p>
    </section>
  );
}
