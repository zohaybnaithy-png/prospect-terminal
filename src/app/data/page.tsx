import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import {
  COMPONENTS_BY_ROLE,
  DEFAULT_MOMENTUM_MODEL,
  MOMENTUM_BANDS,
  MOMENTUM_MODELS,
  MOMENTUM_SETTINGS,
  MOMENTUM_WINDOWS,
  MOMENTUM_WINDOW_IDS,
} from "@/analytics/config";
import { COMPONENT_LABELS } from "@/analytics/explain";
import { getCompetitionData } from "@/services/competition";
import { levelCoverage, type LevelCoverage } from "@/services/competition/model";
import { levelCoverageSummary } from "@/services/competition/prepare";
import { AflDataNotice } from "@/components/afl/data-notice";
import { MomentumValue } from "@/components/analytics/momentum-parts";
import { shortDate } from "@/lib/format";
import { ScrollRegion } from "@/components/ui/scroll-region";

export const metadata: Metadata = {
  title: "Data & methodology",
  description:
    "What data Prospect Terminal uses, how Momentum is calculated and read, and which metrics are still in development.",
};

const model = MOMENTUM_MODELS[DEFAULT_MOMENTUM_MODEL];
const s = MOMENTUM_SETTINGS;

const bandRange = (i: number) => {
  const band = MOMENTUM_BANDS[i];
  const upper = i === 0 ? 100 : MOMENTUM_BANDS[i - 1].min - 1;
  const lower = band.min === -Infinity ? -100 : band.min;
  return `${lower > 0 ? "+" : ""}${lower} to ${upper > 0 ? "+" : ""}${upper}`;
};

export default function DataPage() {
  return (
    <>
      <div className="page-heading">
        <h1>Data &amp; methodology</h1>
        <p>
          Where the numbers come from, what Momentum measures, and what it
          doesn&apos;t. Everything on Prospect Terminal is computed from
          recorded box scores — nothing is estimated, scraped or hand-entered.
        </p>
      </div>
      <nav className="profile-tabs" aria-label="Methodology sections">
        <a href="#coverage">Coverage</a>
        <a href="#levels">Levels</a>
        <a href="#momentum">Momentum</a>
        <a href="#reading">Reading Momentum</a>
        <a href="#statistics">Statistics</a>
        <a href="#in-development">In development</a>
      </nav>
      <div className="method-grid">
        <div className="method-main">
          <section id="coverage" className="page-section method-section">
            <h2>Data coverage</h2>
            <Suspense
              fallback={
                <p className="empty-state" aria-busy="true">
                  Loading coverage…
                </p>
              }
            >
              <Coverage />
            </Suspense>
            <p className="table-note">
              Source: MLB Stats API schedules, rosters and box scores (used
              under development terms; licensing is reviewed before any public
              launch). Only final games with complete box scores count toward
              statistics. Regular-season games only for MiLB levels; the AFL is
              its own fall season.
            </p>
            <h3 className="table-title" id="levels">
              Levels are separate competitions
            </h3>
            <ul className="method-list">
              <li>
                Every statistic, window, percentile and Momentum value is
                computed within one level and season. Lines from different
                levels are never added together, averaged or ranked against
                each other.
              </li>
              <li>
                No level-of-competition adjustment is applied: a .900 OPS at
                Single-A and at Triple-A are not equivalent, and Prospect
                Terminal does not yet have an approved normalization to convert
                between them.
              </li>
              <li>
                A player has one profile across levels. Promotions are visible
                as the levels they played at, with first and last game dates;
                dated transactions are not ingested.
              </li>
              <li>
                Statistics are &ldquo;through&rdquo; each level&apos;s own latest
                completed game, so 7/14/30-day windows end on different dates
                for different levels.
              </li>
            </ul>
          </section>

          <section id="momentum" className="page-section method-section">
            <h2>Momentum</h2>
            <p className="method-lede">
              Momentum answers one question:{" "}
              <strong>
                is this player performing better or worse lately than before?
              </strong>{" "}
              It compares each player&apos;s recent games with{" "}
              <em>that player&apos;s own</em> earlier games — not with the
              league, and not with other prospects.
            </p>
            <ol className="method-steps">
              <li>
                <strong>Recent vs. baseline.</strong> The recent window is the
                last{" "}
                {MOMENTUM_WINDOW_IDS.map((w) => MOMENTUM_WINDOWS[w].days)
                  .join(", ")
                  .replace(/, (\d+)$/, " or $1")}{" "}
                days of completed games (14 days by default). The baseline is
                every earlier game that season. Windows end at the latest
                completed game date, not today&apos;s date.
              </li>
              <li>
                <strong>Components.</strong> The change is measured in four
                parts per role, each standardized by how much that statistic
                normally varies across the league:
                <table className="method-table compact">
                  <caption className="sr-only">
                    Momentum components and weights
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Role</th>
                      <th scope="col">Component</th>
                      <th scope="col">Based on</th>
                      <th scope="col" className="numeric">
                        Weight
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(["hitter", "pitcher"] as const).flatMap((role) =>
                      COMPONENTS_BY_ROLE[role].map((c, i) => (
                        <tr key={c}>
                          <td>
                            {i === 0
                              ? role === "hitter"
                                ? "Hitters"
                                : "Pitchers"
                              : ""}
                          </td>
                          <th scope="row">{COMPONENT_LABELS[c].label}</th>
                          <td>{COMPONENT_LABELS[c].summary}</td>
                          <td className="numeric">
                            {Math.round(
                              ((model[role] as Record<string, number>)[c] ??
                                0) * 100,
                            )}
                            %
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </li>
              <li>
                <strong>Sample-size shrinkage.</strong> Small samples are pulled
                toward 0. A hot week on 15 plate appearances moves the number
                far less than the same change over 50.
              </li>
              <li>
                <strong>Persistence.</strong> A change that has held up across
                several rolling checkpoints keeps its full value; a one-off
                spike is discounted (down to ×{s.persistence.multiplierFloor}).
              </li>
            </ol>
          </section>

          <section id="reading" className="page-section method-section">
            <h2>Reading Momentum</h2>
            <div className="method-two">
              <div>
                <h3 className="table-title">Scale</h3>
                <table className="method-table">
                  <caption className="sr-only">Momentum bands</caption>
                  <tbody>
                    {MOMENTUM_BANDS.map((b, i) => (
                      <tr key={b.id}>
                        <td className="numeric">
                          <MomentumValue
                            score={
                              b.direction === "flat"
                                ? 0
                                : b.min === -Infinity
                                  ? -80
                                  : b.min
                            }
                          />
                        </td>
                        <th scope="row">{b.label}</th>
                        <td className="small-muted numeric">{bandRange(i)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h3 className="table-title">Confidence</h3>
                <p className="method-text">
                  How much data supports the signal, from the recent and
                  baseline samples together.
                </p>
                <ul className="method-list">
                  <li>
                    <strong>Low</strong> — fewer than ~4 games on either side;
                    treat as a hint.
                  </li>
                  <li>
                    <strong>Medium</strong> — a normal 14-day sample (at least{" "}
                    {s.confidence.minSample.medium.hitter} PA /{" "}
                    {s.confidence.minSample.medium.pitcher} BF on each side).
                  </li>
                  <li>
                    <strong>High</strong> — about ten games of regular play on
                    both sides (at least {s.confidence.minSample.high.hitter} PA
                    / {s.confidence.minSample.high.pitcher} BF); rare for
                    relievers.
                  </li>
                </ul>
                <p className="method-text">
                  These thresholds were calibrated on Arizona Fall League
                  samples. MiLB seasons give much larger earlier baselines, so
                  medium and high confidence are reached more often there; any
                  MiLB-specific recalibration will be documented here before it
                  is applied.
                </p>
                <h3 className="table-title">When it&apos;s blank</h3>
                <p className="method-text">
                  Momentum shows “—” when there is no earlier baseline to
                  compare with (fewer than {s.sample.minBaseline.hitter} earlier
                  PA/BF) or too little recent playing time (fewer than{" "}
                  {s.sample.minRecent.hitter}). Trending lists additionally
                  require {s.sample.leaderboardMinRecent.hitter["14d"]} recent
                  PA ({s.sample.leaderboardMinRecent.pitcher["14d"]} BF) over 14
                  days and hide changes smaller than ±
                  {s.sample.leaderboardMinMagnitude}.
                </p>
              </div>
            </div>
            <div className="method-callout">
              <strong>What Momentum is not.</strong> It is not a talent grade, a
              projection, or a probability of reaching the majors. A star
              performing at a usual level reads 0; a struggling player who
              improves reads positive. Use it to spot change, then look at the
              statistics to judge quality.
            </div>
          </section>

          <section id="statistics" className="page-section method-section">
            <h2>Statistics</h2>
            <dl className="glossary">
              {[
                [
                  "AVG / OBP / SLG",
                  "Batting average, on-base percentage, slugging percentage, from summed counts.",
                ],
                ["OPS", "OBP + SLG."],
                ["ISO", "Isolated power: SLG − AVG."],
                [
                  "BB% / K%",
                  "Walks or strikeouts per plate appearance (hitters) or batter faced (pitchers).",
                ],
                [
                  "K−BB%",
                  "Strikeout rate minus walk rate; a compact pitching skill measure.",
                ],
                [
                  "ERA / WHIP",
                  "Earned runs per nine innings; walks plus hits per inning pitched.",
                ],
                [
                  "IP",
                  "Innings pitched, shown in baseball notation (5.2 = 5⅔).",
                ],
                [
                  "Percentiles",
                  "Rank among players at the same level, season and role with at least 30 PA or BF — not MLB percentiles and never across levels.",
                ],
              ].map(([term, def]) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{def}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>

        <aside className="method-side" aria-labelledby="in-development">
          <section className="page-section method-section">
            <h2 id="in-development">In development</h2>
            <p className="method-text">
              These Prospect Terminal metrics are being designed. None is shown
              anywhere on the site until its methodology is finalized and
              validated.
            </p>
            <ul className="dev-list">
              {[
                ["Prospect Grade", "Overall prospect value on a single scale."],
                ["P(MLB)", "Probability of reaching the major leagues."],
                [
                  "Breakout detection",
                  "Flags sustained, skill-driven improvement.",
                ],
                ["Similarity", "Historical comparable players."],
                [
                  "Top prospect rankings",
                  "Overall list, from a licensed source or the Grade.",
                ],
              ].map(([name, desc]) => (
                <li key={name}>
                  <strong>{name}</strong>
                  <span>{desc}</span>
                  <em>Not available</em>
                </li>
              ))}
            </ul>
            <p className="table-note">
              Explore Momentum in practice on <Link href="/trends">Trends</Link>{" "}
              and any <Link href="/players">player profile</Link>.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}

const STATUS: Record<LevelCoverage["status"], [string, string]> = {
  live: ["status-live", "Live"],
  "no-games": ["status-pending", "Ingested — no completed games yet"],
  "not-ingested": ["small-muted", "Not ingested"],
  unavailable: ["status-down", "Temporarily unavailable"],
};

async function Coverage() {
  const data = await getCompetitionData();
  if (data.status === "not-configured" || data.status === "unavailable")
    return <AflDataNotice status={data.status} />;
  const rows =
    data.status === "ok"
      ? levelCoverage(data.levels, data.levelStatus, levelCoverageSummary)
      : levelCoverage([], data.levelStatus);
  return (
    <>
      {data.status === "empty" && <AflDataNotice status="empty" />}
      <ScrollRegion label="Data coverage by level">
        <table className="method-table coverage-levels">
          <caption className="sr-only">Data coverage by level</caption>
          <thead>
            <tr>
              <th scope="col">Level</th>
              <th scope="col">Status</th>
              <th scope="col">Season</th>
              <th scope="col">Through</th>
              <th scope="col" className="numeric">Final games</th>
              <th scope="col" className="numeric">Scheduled</th>
              <th scope="col" className="numeric">Teams</th>
              <th scope="col" className="numeric">Hitters</th>
              <th scope="col" className="numeric">Pitchers</th>
              <th scope="col" className="numeric" title="Season OPS of all batting lines at this level">
                Level OPS
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ level, status, coverage: c }) => (
              <tr key={level.id}>
                <th scope="row">
                  {level.label} <span className="small-muted">({level.short})</span>
                </th>
                <td className={STATUS[status][0]}>{STATUS[status][1]}</td>
                {c ? (
                  <>
                    <td>{c.season}</td>
                    <td>{c.asOf ? shortDate(c.asOf) : "—"}</td>
                    <td className="numeric">{c.gamesFinal.toLocaleString()}</td>
                    <td className="numeric">{c.gamesScheduled.toLocaleString()}</td>
                    <td className="numeric">{c.teams}</td>
                    <td className="numeric">{c.hitters.toLocaleString()}</td>
                    <td className="numeric">{c.pitchers.toLocaleString()}</td>
                    <td className="numeric">{c.leagueOps}</td>
                  </>
                ) : (
                  <td colSpan={8} className="small-muted">
                    —
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <LastIngestion rows={rows} />
    </>
  );
}

function LastIngestion({ rows }: { rows: LevelCoverage[] }) {
  const last = rows
    .map((r) => r.coverage?.lastIngestedAt ?? null)
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1);
  return last ? (
    <p className="table-note">
      Last applied ingestion run: {shortDate(last.slice(0, 10))}.
    </p>
  ) : null;
}
