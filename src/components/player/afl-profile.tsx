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
  formatFixed,
  formatPct,
  formatRate,
  inningsFromOuts,
  type AflPlayerProfile,
  type BattingAggregate,
  type PitchingAggregate,
} from "@/services/afl/read-model";
import type { AflSnapshot } from "@/services/afl/types";
import type { PlayerAnalyticsView, RoleAnalyticsView } from "@/analytics/views";
import type { PlayerLevelPresence } from "@/services/competition/model";
import { levelById, type LevelId } from "@/services/players/levels";
import { playerHref } from "@/components/ui/entity-links";
import { MOMENTUM_WINDOWS, MOMENTUM_WINDOW_IDS } from "@/analytics/config";
import { shortDate } from "@/lib/format";
import {
  ConfidenceMeter,
  Decomposition,
  MomentumValue,
  PersistenceMeter,
  persistenceText,
} from "@/components/analytics/momentum-parts";
import { WhatChanged } from "@/components/analytics/what-changed";
import { DevelopmentTimeline } from "@/components/analytics/development-timeline";
import { timelineViews } from "@/analytics/trend-views";
import { DevelopmentFingerprint } from "@/components/analytics/fingerprint";

const windows = ["7d", "14d", "30d", "season"] as const;
const ROLE_LABEL = { hitter: "Hitting", pitcher: "Pitching" } as const;
const RECENT_GAMES = 10;

/**
 * Real player profile for one level (AFL, Triple-A, Double-A, High-A or Single-A). Everything on
 * it — statistics, windows, Momentum, percentiles, game log — comes from that level's snapshot
 * only; other levels are listed (never blended) in the "Levels" section. Momentum comes from the
 * V1 analytics model (src/analytics); nothing here computes or adjusts it. Prospect Grade is not
 * shown because no Grade model exists.
 */
export function AflPlayerProfileView({
  profile,
  snapshot,
  analytics,
  level = "afl",
  presence = [],
}: {
  profile: AflPlayerProfile;
  snapshot: AflSnapshot;
  analytics: PlayerAnalyticsView;
  level?: LevelId;
  /** Every level the player appears at this season (most recent first). */
  presence?: PlayerLevelPresence[];
}) {
  const lvl = levelById(level);
  const { player, row, asOf } = profile;
  const season = profile.windows.season;
  const hasBatting = season.batting !== null;
  const hasPitching = season.pitching !== null;
  // Lead with the player's primary role (pitchers first for P), matching the analytics view.
  const pitcherFirst = player.primaryPosition === "P";
  const asOfLabel = asOf ? shortDate(asOf) : null;
  const battingLog = profile.gameLog.filter((g) => g.batting);
  const pitchingLog = profile.gameLog.filter((g) => g.pitching);
  const sections = [
    ["Recent games", "recent"],
    ["Trend", "trend"],
    ["Splits by window", "windows"],
    ...(analytics.roles.length ? [["Percentiles", "percentiles"]] : []),
    ["Game log", "game-log"],
    ["Levels", "levels"],
    ["Roster", "roster"],
  ];
  const recent = profile.windows["14d"];
  const strips = [
    hasBatting && (
      <div key="b" className="strip-group">
        <BattingStrip label={`${lvl.short} season`} s={season.batting!} />
        <BattingStrip label="Last 14 days" s={recent.batting} />
      </div>
    ),
    hasPitching && (
      <div key="p" className="strip-group">
        <PitchingStrip label={`${lvl.short} season`} s={season.pitching!} />
        <PitchingStrip label="Last 14 days" s={recent.pitching} />
      </div>
    ),
  ];
  if (pitcherFirst) strips.reverse();

  return (
    <>
      <Link href="/players" className="back-link">
        ← Players
      </Link>
      <div className="profile-top">
        <header className="player-header">
          <p className="eyebrow">
            {snapshot.season.name}
            {asOfLabel && ` · stats through ${asOfLabel}`}
          </p>
          <h1>{player.name}</h1>
          <div className="context-line">
            <span className="level-badge" title={lvl.label}>
              {lvl.short}
            </span>
            <strong>{row.position}</strong>
            {row.team && <AflTeamLink team={row.team} full level={level} />}
            {row.organization ? (
              <AflOrganizationLink organization={row.organization} full />
            ) : (
              <span title="No MLB parent organization in the source roster observation">
                Organization unresolved
              </span>
            )}
          </div>
          {presence.length > 1 && (
            <nav className="level-nav profile-levels" aria-label="Player level">
              <span className="level-nav-label">{snapshot.season.year} levels</span>
              <div className="button-group">
                {presence.map((p) => (
                  <Link
                    key={p.level}
                    href={playerHref(player.id, p.level)}
                    className="button-link"
                    title={`${levelById(p.level).label} — ${p.games} games${p.firstGame && p.lastGame ? `, ${shortDate(p.firstGame)} – ${shortDate(p.lastGame)}` : ""}`}
                    aria-current={p.level === level ? "page" : undefined}
                  >
                    {levelById(p.level).short}
                    <span className="level-games"> · {p.games} G</span>
                  </Link>
                ))}
              </div>
            </nav>
          )}
          <dl className="bio-line">
            {row.age !== null && (
              <div title={asOfLabel ? `Age as of ${asOfLabel}` : undefined}>
                <dt>Age</dt>
                <dd>{row.age}</dd>
              </div>
            )}
            {(player.bats || player.throws) && (
              <div>
                <dt>B/T</dt>
                <dd>
                  {player.bats ?? "—"}/{player.throws ?? "—"}
                </dd>
              </div>
            )}
            {player.height && (
              <div>
                <dt>Ht</dt>
                <dd>{player.height}</dd>
              </div>
            )}
            {player.weight !== null && (
              <div>
                <dt>Wt</dt>
                <dd>{player.weight}</dd>
              </div>
            )}
            {player.birthDate && (
              <div>
                <dt>Born</dt>
                <dd>{player.birthDate}</dd>
              </div>
            )}
            {row.rosterStatus && (
              <div>
                <dt>Roster</dt>
                <dd>{row.rosterStatus}</dd>
              </div>
            )}
          </dl>
          {hasBatting || hasPitching ? (
            <div className="season-strips">{strips}</div>
          ) : (
            <p className="empty-state">
              No {lvl.label} game lines have been recorded for this player
              yet.
            </p>
          )}
        </header>
        <div className="momentum-stack">
          {analytics.roles.length ? (
            analytics.roles.map((r) => (
              <MomentumPanel
                key={r.role}
                view={r}
                labelRole={analytics.roles.length > 1}
              />
            ))
          ) : (
            <section className="momentum-panel" aria-label="Momentum">
              <div className="mp-head">
                <h2>Momentum</h2>
              </div>
              <p className="small-muted">
                Momentum needs completed {lvl.label} games before it can
                compare recent and earlier performance.
              </p>
            </section>
          )}
        </div>
      </div>

      <nav className="profile-tabs" aria-label="Player sections">
        {sections.map(([label, anchor]) => (
          <a key={anchor} href={`#${anchor}`}>
            {label}
          </a>
        ))}
      </nav>

      <section id="recent" className="page-section">
        <SectionTitle
          title="Recent games"
          action={
            profile.gameLog.length > RECENT_GAMES ? (
              <a href="#game-log">Full game log ({profile.gameLog.length}) →</a>
            ) : undefined
          }
        />
        {!profile.gameLog.length && (
          <p className="empty-state">
            No completed {lvl.label} games recorded.
          </p>
        )}
        {orderByRole(pitcherFirst, [
          hasBatting && (
            <div key="b">
              {hasPitching && <h3 className="table-title">Batting</h3>}
              <BattingGameLog
                entries={battingLog.slice(0, RECENT_GAMES)}
                level={level}
              />
            </div>
          ),
          hasPitching && (
            <div key="p">
              {hasBatting && <h3 className="table-title">Pitching</h3>}
              <PitchingGameLog
                entries={pitchingLog.slice(0, RECENT_GAMES)}
                level={level}
              />
            </div>
          ),
        ])}
      </section>

      <section id="trend" className="page-section">
        <SectionTitle title="Trend" />
        {analytics.roles.length ? (
          <>
            {analytics.roles.map(({ role, timelines }) => (
              <DevelopmentTimeline
                key={role}
                timelines={timelineViews(timelines)}
                label={ROLE_LABEL[role]}
              />
            ))}
            <h3 className="table-title">What changed?</h3>
            <WhatChanged
              roles={analytics.roles.map(({ role, momentum }) => ({
                role,
                momentum,
              }))}
            />
          </>
        ) : (
          <p className="placeholder-panel">
            No completed {lvl.label} games to chart for this player yet.
          </p>
        )}
      </section>

      <section id="windows" className="page-section">
        <SectionTitle title="Splits by window" />
        <p className="table-note">
          {asOfLabel
            ? `Windows end ${asOfLabel}, the latest completed ${lvl.label} game date. `
            : ""}
          Totals are summed from final {lvl.label} games with complete box
          scores; statistics from other levels are never blended in.
        </p>
        {orderByRole(pitcherFirst, [
          hasBatting && (
            <div key="b">
              <h3 className="table-title">Batting</h3>
              <BattingWindowTable
                rows={windows.map((w) => ({
                  id: w,
                  label: w === "season" ? `${lvl.short} season` : aflWindowLabels[w],
                  stats: profile.windows[w].batting,
                }))}
              />
            </div>
          ),
          hasPitching && (
            <div key="p">
              <h3 className="table-title">Pitching</h3>
              <PitchingWindowTable
                rows={windows.map((w) => ({
                  id: w,
                  label: w === "season" ? `${lvl.short} season` : aflWindowLabels[w],
                  stats: profile.windows[w].pitching,
                }))}
              />
            </div>
          ),
        ])}
      </section>

      {analytics.roles.length > 0 && (
        <section id="percentiles" className="page-section">
          <SectionTitle title={`${lvl.label} percentiles`} />
          <div className="fingerprint-grid">
            {analytics.roles.map(({ role, fingerprint }) => (
              <DevelopmentFingerprint
                key={role}
                fp={fingerprint}
                label={`${ROLE_LABEL[role]} — vs. ${lvl.short} ${role}s`}
              />
            ))}
          </div>
        </section>
      )}

      <section id="game-log" className="page-section">
        <SectionTitle title="Game log" />
        {!profile.gameLog.length && (
          <p className="empty-state">
            No completed {lvl.label} games recorded.
          </p>
        )}
        {profile.gameLog.length > 0 && (
          <details
            className="log-details"
            open={profile.gameLog.length <= RECENT_GAMES}
          >
            <summary>
              All {profile.gameLog.length} {lvl.label} games
            </summary>
            {orderByRole(pitcherFirst, [
              hasBatting && (
                <div key="b">
                  <h3 className="table-title">Batting</h3>
                  <BattingGameLog entries={battingLog} level={level} />
                </div>
              ),
              hasPitching && (
                <div key="p">
                  <h3 className="table-title">Pitching</h3>
                  <PitchingGameLog entries={pitchingLog} level={level} />
                </div>
              ),
            ])}
          </details>
        )}
      </section>

      <section id="levels" className="page-section">
        <SectionTitle title={`${snapshot.season.year} by level`} />
        <LevelHistory presence={presence} current={level} playerId={player.id} />
      </section>

      <section id="roster" className="page-section">
        <SectionTitle title="Roster observations" />
        <p className="table-note">
          Source roster observations are participation evidence captured at
          ingestion time, not dated transactions. Assignment and promotion
          history is not ingested yet.
        </p>
        <RosterHistoryTable rows={profile.rosterHistory} level={level} />
      </section>
    </>
  );
}

function orderByRole<T>(pitcherFirst: boolean, items: [T, T]) {
  return pitcherFirst ? [items[1], items[0]] : items;
}

function Stat({
  label,
  value,
  title,
}: {
  label: string;
  value: string | number;
  title?: string;
}) {
  return (
    <div title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function StripLabel({ label, role }: { label: string; role: string }) {
  return (
    <div className="strip-label">
      <span>{label}</span>
      <span className="small-muted">{role}</span>
    </div>
  );
}

function BattingStrip({
  label,
  s,
}: {
  label: string;
  s: BattingAggregate | null;
}) {
  if (!s)
    return (
      <div className="stat-strip-row">
        <StripLabel label={label} role="Batting" />
        <p className="stat-strip-empty">No plate appearances</p>
      </div>
    );
  return (
    <div className="stat-strip-row">
      <StripLabel label={label} role="Batting" />
      <dl className="stat-strip" aria-label={`${label} batting`}>
        <Stat label="G" value={s.gameLines} />
        <Stat label="PA" value={s.plateAppearances} />
        <Stat label="AVG" value={formatRate(s.avg)} />
        <Stat label="OBP" value={formatRate(s.obp)} />
        <Stat label="SLG" value={formatRate(s.slg)} />
        <Stat label="OPS" value={formatRate(s.ops)} />
        <Stat label="HR" value={s.homeRuns} />
        <Stat label="RBI" value={s.rbi ?? "—"} />
        <Stat label="SB" value={s.stolenBases} />
        <Stat label="BB%" value={formatPct(s.bbPct)} />
        <Stat label="K%" value={formatPct(s.kPct)} />
      </dl>
    </div>
  );
}

function PitchingStrip({
  label,
  s,
}: {
  label: string;
  s: PitchingAggregate | null;
}) {
  if (!s)
    return (
      <div className="stat-strip-row">
        <StripLabel label={label} role="Pitching" />
        <p className="stat-strip-empty">No batters faced</p>
      </div>
    );
  const kbb = s.kPct !== null && s.bbPct !== null ? s.kPct - s.bbPct : null;
  return (
    <div className="stat-strip-row">
      <StripLabel label={label} role="Pitching" />
      <dl className="stat-strip" aria-label={`${label} pitching`}>
        <Stat label="G" value={s.gameLines} />
        <Stat label="IP" value={inningsFromOuts(s.outsRecorded)} />
        <Stat label="ERA" value={formatFixed(s.era, 2)} />
        <Stat label="WHIP" value={formatFixed(s.whip, 2)} />
        <Stat label="SO" value={s.strikeouts} />
        <Stat label="BB" value={s.walks} />
        <Stat label="K%" value={formatPct(s.kPct)} />
        <Stat label="BB%" value={formatPct(s.bbPct)} />
        <Stat label="K−BB%" value={formatPct(kbb)} />
      </dl>
    </div>
  );
}

/** Momentum headline for one role: 14D value, direction, confidence, persistence, all windows. */
function MomentumPanel({
  view,
  labelRole,
}: {
  view: RoleAnalyticsView;
  labelRole: boolean;
}) {
  const m = view.momentum["14d"];
  const titleId = `momentum-${view.role}`;
  return (
    <section className="momentum-panel" aria-labelledby={titleId}>
      <div className="mp-head">
        <h2 id={titleId}>
          {labelRole ? `${ROLE_LABEL[view.role]} ` : ""}Momentum
          <span className="small-muted"> · 14 days</span>
        </h2>
        <Link href="/data#momentum">How it works</Link>
      </div>
      <div className="mp-main">
        <MomentumValue score={m.score} large />
        <div>
          <strong className="mp-band">
            {m.band?.label ?? "Not enough data"}
          </strong>
          <p className="mp-explanation">{m.explanation}</p>
        </div>
      </div>
      {m.status === "ok" && (
        <div className="mp-meters">
          <ConfidenceMeter
            level={m.confidence}
            detail={`${m.sample.recent} recent vs ${m.sample.baseline} earlier ${m.sample.unit}.`}
          />
          <PersistenceMeter level={m.persistence.level} />
          <span className="small-muted">{persistenceText(m.persistence)}</span>
        </div>
      )}
      <table className="mp-windows">
        <caption className="sr-only">Momentum by comparison window</caption>
        <thead>
          <tr>
            <th scope="col">Window</th>
            <th scope="col" className="numeric">
              Momentum
            </th>
            <th scope="col">Reading</th>
            <th
              scope="col"
              className="numeric"
              title="Recent vs. earlier sample"
            >
              Sample
            </th>
          </tr>
        </thead>
        <tbody>
          {MOMENTUM_WINDOW_IDS.map((w) => {
            const x = view.momentum[w];
            return (
              <tr key={w} className={w === "14d" ? "current" : undefined}>
                <th scope="row">{MOMENTUM_WINDOWS[w].short}</th>
                <td className="numeric">
                  <MomentumValue score={x.score} />
                </td>
                <td>{x.band?.label ?? "Unavailable"}</td>
                <td className="numeric small-muted">
                  {x.status === "ok"
                    ? `${x.sample.recent} / ${x.sample.baseline} ${x.sample.unit}`
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {m.status === "ok" && (
        <details className="mp-why">
          <summary>Why this number?</summary>
          <Decomposition m={m} />
        </details>
      )}
      <p className="mp-footnote">
        Change vs. this player&apos;s own earlier games at this level on a −100 to +100
        scale; 0 means performing like their baseline. Not a measure of overall
        talent or MLB outlook.
      </p>
    </section>
  );
}

/**
 * The player's levels this season side by side. Each row is that level's own totals; rows are
 * never summed or compared, because the levels are different competitions.
 */
function LevelHistory({
  presence,
  current,
  playerId,
}: {
  presence: PlayerLevelPresence[];
  current: LevelId;
  playerId: string;
}) {
  if (!presence.length)
    return <p className="empty-state">No level data recorded.</p>;
  return (
    <>
      <div className="table-scroll">
        <table className="coverage-levels level-history">
          <caption className="sr-only">Levels this season</caption>
          <thead>
            <tr>
              <th scope="col">Level</th>
              <th scope="col" className="hide-narrow">Season</th>
              <th scope="col">Team</th>
              <th scope="col" className="numeric">G</th>
              <th scope="col">Games</th>
              <th scope="col">Batting</th>
              <th scope="col">Pitching</th>
            </tr>
          </thead>
          <tbody>
            {presence.map((p) => (
              <tr key={p.level} aria-current={p.level === current ? "true" : undefined}>
                <th scope="row">
                  {p.level === current ? (
                    <strong>{levelById(p.level).label}</strong>
                  ) : (
                    <Link href={playerHref(playerId, p.level)}>
                      {levelById(p.level).label}
                    </Link>
                  )}
                </th>
                <td className="hide-narrow">{p.season}</td>
                <td>
                  {p.team ? (
                    <AflTeamLink team={p.team} level={p.level} />
                  ) : (
                    "—"
                  )}
                </td>
                <td className="numeric">{p.games}</td>
                <td>
                  {p.firstGame && p.lastGame
                    ? `${shortDate(p.firstGame)} – ${shortDate(p.lastGame)}`
                    : "No completed games"}
                </td>
                <td>
                  {p.batting
                    ? `${formatRate(p.batting.avg)}/${formatRate(p.batting.obp)}/${formatRate(p.batting.slg)} · ${p.batting.plateAppearances} PA`
                    : "—"}
                </td>
                <td>
                  {p.pitching
                    ? `${inningsFromOuts(p.pitching.outsRecorded)} IP · ${formatFixed(p.pitching.era, 2)} ERA · ${p.pitching.battersFaced} BF`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="table-note">
        Each level&apos;s line is its own; levels are different competitions,
        so lines are not added together or compared directly. Promotion dates
        are not ingested — first and last game dates show when the player
        appeared at each level.
      </p>
    </>
  );
}
