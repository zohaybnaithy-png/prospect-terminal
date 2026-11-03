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
import type { PlayerAnalyticsView } from "@/analytics/views";
import { shortDate } from "@/lib/format";
import {
  Decomposition,
  MomentumMeta,
  MomentumValue,
} from "@/components/analytics/momentum-parts";
import { WhatChanged } from "@/components/analytics/what-changed";
import { DevelopmentTimeline } from "@/components/analytics/development-timeline";
import { DevelopmentFingerprint } from "@/components/analytics/fingerprint";

const windows = ["7d", "14d", "30d", "season"] as const;

const ROLE_LABEL = { hitter: "Hitting", pitcher: "Pitching" } as const;

/**
 * Real AFL player profile. Momentum comes from the provisional analytics model (clearly labeled);
 * Prospect Grade remains an explicit placeholder because no Grade formula exists.
 */
export function AflPlayerProfileView({
  profile,
  snapshot,
  analytics,
}: {
  profile: AflPlayerProfile;
  snapshot: AflSnapshot;
  analytics: PlayerAnalyticsView;
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
          <span title="No Prospect Grade formula has been defined">
            Prospect Grade <strong className="placeholder-value">—</strong>
          </span>
          {analytics.roles.map(({ role, momentum }) => {
            const m = momentum["14d"];
            return (
              <details key={role} className="momentum-summary">
                <summary>
                  <span>
                    {analytics.roles.length > 1 ? `${ROLE_LABEL[role]} ` : ""}
                    Momentum (14D)
                  </span>{" "}
                  <MomentumValue score={m.score} large />
                  {m.band && <span className="band-label">{m.band.label}</span>}
                  {m.status === "ok" && <MomentumMeta m={m} />}
                  <span className="why-link">Why?</span>
                </summary>
                <div className="momentum-popover">
                  <p className="what-changed-explanation">{m.explanation}</p>
                  <Decomposition m={m} />
                </div>
              </details>
            );
          })}
          <span className="small-muted">
            Momentum = change vs. the player&apos;s own earlier AFL games (0 =
            performing like their baseline) · provisional{" "}
            {analytics.model.label} model, not final · Grade not modeled
          </span>
        </div>
      </header>
      <nav className="profile-tabs" aria-label="Player sections">
        {[
          ["Stats", "stats"],
          ["What changed?", "changes"],
          ["Percentiles", "percentiles"],
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
      {analytics.roles.length > 0 && (
        <section id="changes" className="page-section">
          <SectionTitle title="What changed?" />
          <WhatChanged
            roles={analytics.roles.map(({ role, momentum }) => ({ role, momentum }))}
            modelLabel={analytics.model.label}
          />
        </section>
      )}
      {analytics.roles.length > 0 && (
        <section id="percentiles" className="page-section">
          <SectionTitle title="AFL development fingerprint" />
          <div className="fingerprint-grid">
            {analytics.roles.map(({ role, fingerprint }) => (
              <DevelopmentFingerprint
                key={role}
                fp={fingerprint}
                label={`${ROLE_LABEL[role]} — AFL percentiles`}
              />
            ))}
          </div>
        </section>
      )}
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
        <SectionTitle title="Development timeline" />
        {analytics.roles.length ? (
          analytics.roles.map(({ role, timelines }) => (
            <DevelopmentTimeline
              key={role}
              timelines={timelines}
              label={ROLE_LABEL[role]}
            />
          ))
        ) : (
          <p className="placeholder-panel">
            No completed AFL games to chart for this player yet.
          </p>
        )}
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
