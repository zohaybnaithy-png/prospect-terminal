import Link from "@/components/ui/app-link";
import { PlayerLink } from "@/components/ui/entity-links";
import { ScrollRegion } from "@/components/ui/scroll-region";
import type { CompareCell, CompareGroup, ComparePlayer } from "@/services/compare/model";
import { compareHref } from "@/services/compare/query";
import type { Role } from "@/analytics/config";
import { levelById, type LevelId } from "@/services/players/levels";

/**
 * FanGraphs-style comparison: players as columns, statistics as rows, grouped (season line,
 * percentiles, Momentum). Presentation only — every value arrives precomputed from
 * src/services/compare/model.ts. The best value of a row is bold on a faint tint, with a
 * screen-reader "(best)", and only on rows whose better direction is defined by the metric registry.
 */
export function CompareTable({
  players,
  groups,
  level,
  role,
}: {
  players: ComparePlayer[];
  groups: CompareGroup[];
  level: LevelId;
  role: Role;
}) {
  const lvl = levelById(level);
  const ids = players.map((p) => p.id);
  const caption = `${lvl.label} ${role === "hitter" ? "hitters" : "pitchers"} compared: statistics as rows, players as columns`;
  return (
    <ScrollRegion label={caption} className="compare-scroll">
      <table className="compare-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="compare-stat-head">
              Stat
            </th>
            {players.map((p) => (
              <th scope="col" key={p.id} className="compare-player">
                {p.name ? (
                  <PlayerLink player={{ id: p.id, name: p.name }} level={level} />
                ) : (
                  <span className="compare-unknown">Unknown player</span>
                )}
                {p.available && (
                  <span className="compare-context">
                    {[p.position, p.team?.abbreviation, p.organization?.abbreviation ?? "Org unresolved", p.age !== null ? `Age ${p.age}` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
                {p.notice && <span className="compare-notice">{p.notice}</span>}
                <Link className="compare-remove" href={compareHref({ level, role, ids: ids.filter((id) => id !== p.id) })}>
                  Remove<span className="sr-only"> {p.name ?? "this player"} from the comparison</span>
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((g) =>
          g.rows.length ? (
            <tbody key={g.id}>
              <tr className="compare-group">
                <th scope="rowgroup" colSpan={players.length + 1}>
                  {g.label}
                </th>
              </tr>
              {g.rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row" title={r.title}>
                    {r.label}
                  </th>
                  {r.cells.map((c, i) => (
                    <Cell key={players[i].id} cell={c} />
                  ))}
                </tr>
              ))}
            </tbody>
          ) : null,
        )}
      </table>
    </ScrollRegion>
  );
}

function Cell({ cell }: { cell: CompareCell | null }) {
  if (!cell)
    return (
      <td className="numeric placeholder-value">
        —<span className="sr-only"> no line</span>
      </td>
    );
  return (
    <td className={cell.best ? "numeric best" : "numeric"}>
      {cell.best ? <strong>{cell.text}</strong> : cell.text}
      {cell.best && <span className="sr-only"> (best)</span>}
      {cell.detail && <span className="compare-detail">{cell.detail}</span>}
    </td>
  );
}
