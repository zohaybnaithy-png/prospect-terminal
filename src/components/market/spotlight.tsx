import Link from "next/link";
import { ArrowUpRight, Lightbulb } from "lucide-react";
import type { Player, Team } from "@/types/baseball";
import { Momentum, TeamMark } from "@/components/ui/primitives";
import { ScoreChart } from "./score-chart";
import { average, era, innings } from "@/lib/format";
export function PlayerStats({ player }: { player: Player }) {
  const b = player.batting;
  const p = player.pitching;
  const stats = [
    ...(b
      ? [
          ["AVG", average(b.hits, b.atBats)],
          ["HR", b.homeRuns],
          ["SB", b.stolenBases],
        ]
      : []),
    ...(p
      ? [
          ["ERA", era(p.earnedRuns, p.outsRecorded)],
          ["IP", innings(p.outsRecorded)],
          ["K", p.strikeouts],
        ]
      : []),
  ];
  return (
    <div className="stat-strip">
      {stats.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}
export function Spotlight({ player, team }: { player: Player; team: Team }) {
  return (
    <div className="spotlight-content">
      <div className="spotlight-identity">
        <TeamMark abbreviation={team.abbreviation} color={team.color} />
        <div>
          <h3>
            <Link href={`/players/${player.id}`}>
              {player.name} <ArrowUpRight size={17} />
            </Link>
          </h3>
          <p>
            {team.name} <span>·</span> {player.position} <span>·</span>{" "}
            {player.year}
          </p>
        </div>
      </div>
      <div className="spotlight-scores">
        <div>
          <span className="eyebrow">PROSPECT GRADE</span>
          <strong>
            {player.grade}
            <small>/100</small>
          </strong>
        </div>
        <div>
          <span className="eyebrow">MOMENTUM</span>
          <Momentum value={player.momentum} />
          <span className="score-label">Illustrative / demo</span>
        </div>
      </div>
      <PlayerStats player={player} />
      <ScoreChart observations={player.history} />
      <div className="why-trending">
        <Lightbulb size={16} />
        <div>
          <h4>
            Why they’re trending <span>PLACEHOLDER</span>
          </h4>
          <p>{player.note}</p>
        </div>
      </div>
    </div>
  );
}
