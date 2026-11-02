import Link from "next/link";
import { SectionTitle } from "@/components/ui/primitives";
import { AflOrganizationLink, AflTeamLink } from "@/components/afl/links";
import {
  BattingGameLog,
  BattingWindowTable,
  PitchingGameLog,
  PitchingWindowTable,
  RosterHistoryTable,
} from "@/components/afl/profile-tables";
import {
  aflWindowLabels,
  type AflPlayerProfile,
} from "@/services/afl/read-model";
import type { AflSnapshot } from "@/services/afl/types";
import { shortDate } from "@/lib/format";

const windows = ["7d", "14d", "30d", "season"] as const;

/** Real AFL player profile. Unmodeled analytics are shown as explicit placeholders. */
export function AflPlayerProfileView({
  profile,
  snapshot,
}: {
  profile: AflPlayerProfile;
  snapshot: AflSnapshot;
}) {
  const { player, row, asOf } = profile;
  const hasBatting = profile.windows.season.batting !== null;
  const hasPitching = profile.windows.season.pitching !== null;
  const asOfLabel = asOf ? shortDate(asOf) : null;
  return (
    <>
      <Link href="/players" className="back-link">
        ← AFL player directory
      </Link>
      <header className="player-header">
        <p className="eyebrow">{snapshot.season.name} · player profile</p>
        <h1>{player.name}</h1>
        <div className="context-line">
          {row.organization ? (
            <AflOrganizationLink organization={row.organization} full />
          ) : (
            <span title="No MLB parent organization in the source roster observation">
              Organization unresolved
            </span>
          )}
          {row.team && <AflTeamLink team={row.team} full />}
          <span>AFL</span>
          <span>{row.position}</span>
          {row.age !== null && (
            <span title={`Age as of ${asOfLabel}`}>Age {row.age}</span>
          )}
          {(player.bats || player.throws) && (
            <span>
              Bats {player.bats ?? "—"} / Throws {player.throws ?? "—"}
            </span>
          )}
          {(player.height || player.weight !== null) && (
            <span>
              {player.height ?? "—"}
              {player.weight !== null && `, ${player.weight} lb`}
            </span>
          )}
          {row.rosterStatus && <span>Roster: {row.rosterStatus}</span>}
        </div>
        <div className="profile-scores">
          <span>
            Prospect Grade <strong className="placeholder-value">—</strong>
          </span>
          <span>
            Momentum <strong className="placeholder-value">—</strong>
          </span>
          <span className="small-muted">
            Not yet modeled · no Grade or Momentum formula has been finalized
          </span>
        </div>
      </header>
      <nav className="profile-tabs" aria-label="Player sections">
        {[
          ["Stats", "stats"],
          ["Game log", "game-log"],
          ["Development", "development"],
          ["Trends", "trends"],
          ["News", "news"],
        ].map(([label, anchor]) => (
          <a key={anchor} href={`#${anchor}`}>
            {label}
          </a>
        ))}
        <span title="No split records are ingested">Splits · planned</span>
      </nav>
      <section id="stats" className="page-section">
        <SectionTitle title="AFL performance" />
        <p className="table-note">
          {asOfLabel
            ? `Windows end ${asOfLabel}, the latest completed AFL game date. `
            : ""}
          Totals are summed from ingested final games with complete box scores
          only; AFL statistics are never blended with affiliated-season
          statistics.
        </p>
        {!hasBatting && !hasPitching && (
          <p className="empty-state">
            No AFL game lines have been recorded for this player yet.
          </p>
        )}
        {hasBatting && (
          <>
            <h3 className="table-title">Batting</h3>
            <BattingWindowTable
              rows={windows.map((w) => ({
                id: w,
                label: aflWindowLabels[w],
                stats: profile.windows[w].batting,
              }))}
            />
          </>
        )}
        {hasPitching && (
          <>
            <h3 className="table-title">Pitching</h3>
            <PitchingWindowTable
              rows={windows.map((w) => ({
                id: w,
                label: aflWindowLabels[w],
                stats: profile.windows[w].pitching,
              }))}
            />
          </>
        )}
      </section>
      <section id="game-log" className="page-section">
        <SectionTitle title="Game log" />
        {!profile.gameLog.length && (
          <p className="empty-state">No completed AFL games recorded.</p>
        )}
        {hasBatting && (
          <>
            <h3 className="table-title">Batting</h3>
            <BattingGameLog entries={profile.gameLog} />
          </>
        )}
        {hasPitching && (
          <>
            <h3 className="table-title">Pitching</h3>
            <PitchingGameLog entries={profile.gameLog} />
          </>
        )}
      </section>
      <section id="development" className="page-section">
        <SectionTitle title="AFL roster observations" />
        <p className="table-note">
          Source roster observations are participation evidence captured at
          ingestion time, not dated transactions. Assignment and promotion
          history has not been ingested yet.
        </p>
        <RosterHistoryTable rows={profile.rosterHistory} />
      </section>
      <section id="trends" className="page-section">
        <SectionTitle title="Development trajectory" />
        <p className="placeholder-panel">
          Placeholder · the Grade/Momentum trajectory chart needs a defined
          prospect model, which does not exist yet. No values are estimated.
        </p>
      </section>
      <section id="news" className="page-section">
        <SectionTitle title="Player news" />
        <p className="placeholder-panel">
          No news source is connected for AFL players yet.
        </p>
      </section>
    </>
  );
}
