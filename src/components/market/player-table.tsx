import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { Player, Team } from "@/types/baseball";
import { Grade, Momentum, TeamMark } from "@/components/ui/primitives";
export function PlayerTable({
  players,
  teams,
}: {
  players: Player[];
  teams: Team[];
}) {
  if (!players.length)
    return (
      <div className="empty-state">
        No demo players match these filters. Try another name or position.
      </div>
    );
  return (
    <div className="table-scroll">
      <table className="player-table">
        <caption className="sr-only">
          Fictional demo prospects and illustrative scores
        </caption>
        <thead>
          <tr>
            <th scope="col" className="rank-col">
              #
            </th>
            <th scope="col">Player</th>
            <th scope="col">Team</th>
            <th scope="col">Pos</th>
            <th scope="col">Level</th>
            <th scope="col">Prospect Grade</th>
            <th scope="col">Momentum</th>
            <th scope="col">6-week trend</th>
            <th scope="col">
              <span className="sr-only">Profile</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {players.map((p, i) => {
            const team = teams.find((t) => t.id === p.teamId)!;
            const min = Math.min(...p.history.map((h) => h.grade));
            const max = Math.max(...p.history.map((h) => h.grade));
            const points = p.history
              .map(
                (h, j) =>
                  `${j * 12},${24 - ((h.grade - min) / (max - min || 1)) * 20}`,
              )
              .join(" ");
            return (
              <tr key={p.id}>
                <td className="rank-col">{String(i + 1).padStart(2, "0")}</td>
                <td>
                  <Link className="player-name" href={`/players/${p.id}`}>
                    {p.name}
                  </Link>
                  <span className="player-year">{p.year}</span>
                </td>
                <td>
                  <Link className="team-cell" href={`/teams/${team.id}`}>
                    <TeamMark
                      abbreviation={team.abbreviation}
                      color={team.color}
                      small
                    />
                    <span>
                      {team.name.replace(/ (Comets|Foxes|Tides|Owls)$/, "")}
                    </span>
                  </Link>
                </td>
                <td>
                  <span className="position">{p.position}</span>
                </td>
                <td className="muted">{team.level}</td>
                <td>
                  <Grade value={p.grade} />
                </td>
                <td>
                  <Momentum value={p.momentum} />
                </td>
                <td>
                  <svg
                    className={
                      p.momentum >= 0
                        ? "sparkline positive"
                        : "sparkline negative"
                    }
                    width="68"
                    height="30"
                    viewBox="-2 -2 66 32"
                    role="img"
                    aria-label={`Grade ${p.history[0].grade} to ${p.grade}`}
                  >
                    <polyline
                      points={points}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                    />
                    <circle
                      cx="60"
                      cy={24 - ((p.grade - min) / (max - min || 1)) * 20}
                      r="2.4"
                      fill="currentColor"
                    />
                  </svg>
                </td>
                <td>
                  <Link
                    className="row-link"
                    href={`/players/${p.id}`}
                    aria-label={`View ${p.name}`}
                  >
                    <ArrowUpRight size={16} />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
