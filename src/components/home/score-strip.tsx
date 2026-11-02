import Link from "next/link";
import { getAflData } from "@/services/afl";
import { aflAsOf, scoreboard } from "@/services/afl/read-model";
import { AflTeamLink } from "@/components/afl/links";
import { aflDataNoticeText } from "@/components/afl/data-notice";
import { shortDate } from "@/lib/format";

function StripShell({
  detail,
  children,
}: {
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <section className="score-strip" aria-label="Arizona Fall League scores">
      <div className="score-strip-inner">
        <div className="score-strip-label">
          <strong>AFL 2026</strong>
          <span>{detail}</span>
          <Link href="/players">AFL players →</Link>
        </div>
        {children}
      </div>
    </section>
  );
}

export function ScoreStripFallback() {
  return (
    <StripShell detail="Loading scores…">
      <div className="score-games" aria-busy="true" />
    </StripShell>
  );
}

/** Real AFL games from the database: latest completed date plus the next scheduled date. */
export async function ScoreStrip() {
  const data = await getAflData();
  if (data.status !== "ok")
    return (
      <StripShell detail="Scores unavailable">
        <p className="score-strip-empty">{aflDataNoticeText(data.status)}</p>
      </StripShell>
    );
  const games = scoreboard(data.snapshot);
  const asOf = aflAsOf(data.snapshot);
  return (
    <StripShell
      detail={asOf ? `Through ${shortDate(asOf)}` : "No completed games yet"}
    >
      {games.length ? (
        <div
          className="score-games"
          tabIndex={0}
          role="region"
          aria-label="AFL scoreboard, scroll for more games"
        >
          {games.map((game) => (
            <article className="score-game" key={game.id}>
              <div className="score-game-heading">
                <time dateTime={game.date}>{shortDate(game.date)}</time>
                <span>{game.statusLabel}</span>
              </div>
              <div>
                <AflTeamLink team={game.away} />
                <strong>{game.awayScore ?? "—"}</strong>
              </div>
              <div>
                <AflTeamLink team={game.home} />
                <strong>{game.homeScore ?? "—"}</strong>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="score-strip-empty">No AFL games have been ingested.</p>
      )}
    </StripShell>
  );
}
