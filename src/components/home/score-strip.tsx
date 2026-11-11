import Link from "@/components/ui/app-link";
import { getCompetitionData, DATA_SEASON } from "@/services/competition";
import { defaultLevel } from "@/services/competition/model";
import { aflAsOf, scoreboard } from "@/services/afl/read-model";
import { levelById, type LevelId } from "@/services/players/levels";
import { AflTeamLink } from "@/components/afl/links";
import { aflDataNoticeText } from "@/components/afl/data-notice";
import { shortDate } from "@/lib/format";

function StripShell({
  detail,
  level,
  children,
}: {
  detail: string;
  level?: LevelId;
  children: React.ReactNode;
}) {
  const label = level ? levelById(level) : null;
  return (
    <section
      className="score-strip"
      aria-label={`${label?.label ?? "Latest"} scores`}
    >
      <div className="score-strip-inner">
        <div className="score-strip-label">
          <strong title={label?.label}>
            {label ? `${label.short} ${DATA_SEASON}` : `${DATA_SEASON}`}
          </strong>
          <span>{detail}</span>
          <Link href={level ? `/players?level=${level}` : "/players"}>
            {label ? `${label.short} players →` : "Players →"}
          </Link>
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

/**
 * Real games from the database for the level with the most recent completed game (the same
 * default level as the homepage): its latest completed date plus its next scheduled date.
 */
export async function ScoreStrip() {
  const data = await getCompetitionData();
  if (data.status !== "ok")
    return (
      <StripShell detail="Scores unavailable">
        <p className="score-strip-empty">{aflDataNoticeText(data.status)}</p>
      </StripShell>
    );
  const level = defaultLevel(data.levels)!;
  const snapshot = data.levels.find((l) => l.level === level)!.snapshot;
  const games = scoreboard(snapshot, 8, level);
  const asOf = aflAsOf(snapshot);
  return (
    <StripShell
      level={level}
      detail={asOf ? `Through ${shortDate(asOf)}` : "No completed games yet"}
    >
      {games.length ? (
        <div
          className="score-games"
          tabIndex={0}
          role="region"
          aria-label={`${levelById(level).label} scoreboard, scroll for more games`}
        >
          {games.map((game) => (
            <article className="score-game" key={game.id}>
              <div className="score-game-heading">
                <time dateTime={game.date}>{shortDate(game.date)}</time>
                <span>{game.statusLabel}</span>
              </div>
              <div>
                <AflTeamLink team={game.away} level={level} />
                <strong>{game.awayScore ?? "—"}</strong>
              </div>
              <div>
                <AflTeamLink team={game.home} level={level} />
                <strong>{game.homeScore ?? "—"}</strong>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="score-strip-empty">No {levelById(level).label} games have been ingested.</p>
      )}
    </StripShell>
  );
}
