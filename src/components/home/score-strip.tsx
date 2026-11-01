import Link from "next/link";
import { demoGames } from "@/data/demo-home";
import { teams, contexts, DEMO_AS_OF } from "@/data/demo";
import { TeamLink } from "@/components/ui/entity-links";
import { shortDate } from "@/lib/format";
export function ScoreStrip() {
  return (
    <section className="score-strip" aria-label="Fictional game scores">
      <div className="score-strip-inner">
        <div className="score-strip-label">
          <strong>DEMO GAMES</strong>
          <span>{shortDate(DEMO_AS_OF)} · 2026</span>
          <Link href="/leagues">MiLB / AFL →</Link>
        </div>
        <div
          className="score-games"
          tabIndex={0}
          role="region"
          aria-label="Demo scoreboard, scroll for more games"
        >
          {demoGames.map((game) => (
            <article className="score-game" key={game.id}>
              <div className="score-game-heading">
                <Link href={`/leagues/${game.context}`}>
                  {contexts.find((c) => c.slug === game.context)!.shortName}
                </Link>
                <span>{game.status}</span>
              </div>
              <div>
                <TeamLink team={teams.find((t) => t.id === game.awayTeamId)!} />
                <strong>{game.awayScore ?? "—"}</strong>
              </div>
              <div>
                <TeamLink team={teams.find((t) => t.id === game.homeTeamId)!} />
                <strong>{game.homeScore ?? "—"}</strong>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
