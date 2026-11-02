import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  aflAsOf,
  buildPlayerRows,
  filterPlayerRows,
  playerProfile,
  recentPerformers,
  scoreboard,
  formatRate,
  inningsFromOuts,
} from "../src/services/afl/read-model";
import { aggregateBatting } from "../src/statistics/aggregate";
import type {
  AflBattingLine,
  AflGame,
  AflPitchingLine,
  AflSnapshot,
} from "../src/services/afl/types";

// Synthetic, clearly fictional snapshot. Internal-style UUIDs only.
const u = (n: number) =>
  `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const LEAGUE = u(1),
  SEASON = u(2),
  T1 = u(11),
  T2 = u(12),
  ORG = u(21),
  HITTER = u(31),
  TWO_WAY = u(32),
  PITCHER = u(33),
  NO_ROSTER = u(34);
const game = (
  n: number,
  date: string,
  status: AflGame["status"],
  complete: boolean,
  homeScore: number | null = null,
  awayScore: number | null = null,
): AflGame => ({
  id: u(100 + n),
  date,
  startsAt: `${date}T19:05:00.000Z`,
  status,
  homeTeamId: T1,
  awayTeamId: T2,
  homeScore,
  awayScore,
  venue: "Synthetic Park",
  boxscoreComplete: complete,
});
const bat = (
  playerId: string,
  gameN: number,
  teamId: string,
  pa: number,
  ab: number,
  h: number,
  hr = 0,
  bb = 0,
): AflBattingLine => ({
  playerId,
  gameId: u(100 + gameN),
  teamId,
  plateAppearances: pa,
  atBats: ab,
  hits: h,
  doubles: 0,
  triples: 0,
  homeRuns: hr,
  walks: bb,
  strikeouts: 1,
  hitByPitch: 0,
  sacrificeFlies: 0,
  stolenBases: 0,
  runs: null,
  rbi: 1,
  caughtStealing: 0,
});
const pitch = (
  playerId: string,
  gameN: number,
  teamId: string,
  outs: number,
  k: number,
  er: number,
): AflPitchingLine => ({
  playerId,
  gameId: u(100 + gameN),
  teamId,
  outsRecorded: outs,
  battersFaced: outs + 3,
  hitsAllowed: 2,
  earnedRuns: er,
  walks: 1,
  strikeouts: k,
  homeRunsAllowed: 0,
  runs: er,
  hitBatters: 0,
  pitches: 40,
});

function snapshot(): AflSnapshot {
  return {
    league: { id: LEAGUE, name: "Synthetic Fall League" },
    season: { id: SEASON, year: 2026, name: "Arizona Fall League 2026" },
    teams: [
      { id: T1, name: "Synthetic Saguaros", abbreviation: "SSG" },
      { id: T2, name: "Fixture Javelinas", abbreviation: "FJV" },
    ],
    organizations: [
      { id: ORG, name: "Example Parent Club", abbreviation: "EPC" },
    ],
    players: [
      ["Alpha Hitter", HITTER, "SS"],
      ["Bravo TwoWay", TWO_WAY, "P"],
      ["Charlie Arm", PITCHER, "P"],
      ["Delta Unlisted", NO_ROSTER, "CF"],
    ].map(([name, id, pos]) => ({
      id,
      name,
      primaryPosition: pos,
      secondaryPosition: id === TWO_WAY ? "DH" : null,
      bats: "R",
      throws: "R",
      birthDate: "2003-11-01",
      height: null,
      weight: null,
    })),
    games: [
      game(1, "2026-10-01", "final", true, 5, 3),
      game(2, "2026-10-20", "final", true, 2, 4),
      game(3, "2026-10-25", "final", true, 6, 6),
      game(4, "2026-10-26", "final", false, 1, 0), // incomplete box score: excluded
      game(5, "2026-10-27", "scheduled", false),
      game(6, "2026-10-28", "scheduled", false),
    ],
    rosterStints: [
      {
        playerId: HITTER,
        teamId: T2,
        organizationId: null,
        rosterStatus: "Active",
        firstObservedAt: "2026-10-01T12:00:00.000Z",
        lastObservedAt: "2026-10-10T12:00:00.000Z",
      },
      {
        playerId: HITTER,
        teamId: T1,
        organizationId: ORG,
        rosterStatus: "Active",
        firstObservedAt: "2026-10-11T12:00:00.000Z",
        lastObservedAt: "2026-10-26T12:00:00.000Z",
      },
      {
        playerId: TWO_WAY,
        teamId: T1,
        organizationId: ORG,
        rosterStatus: "Active",
        firstObservedAt: "2026-10-01T12:00:00.000Z",
        lastObservedAt: "2026-10-26T12:00:00.000Z",
      },
      {
        playerId: PITCHER,
        teamId: T2,
        organizationId: null,
        rosterStatus: null,
        firstObservedAt: "2026-10-01T12:00:00.000Z",
        lastObservedAt: "2026-10-26T12:00:00.000Z",
      },
    ],
    batting: [
      bat(HITTER, 1, T1, 5, 4, 2, 1, 1),
      bat(HITTER, 2, T1, 4, 4, 1),
      bat(HITTER, 3, T1, 5, 5, 3, 1),
      bat(HITTER, 4, T1, 4, 4, 4, 4), // incomplete game: must not count
      bat(TWO_WAY, 3, T1, 3, 3, 1),
      bat(NO_ROSTER, 3, T2, 4, 4, 0),
    ],
    pitching: [
      pitch(TWO_WAY, 2, T1, 6, 3, 1),
      pitch(PITCHER, 2, T2, 9, 5, 0),
      pitch(PITCHER, 3, T2, 6, 2, 3),
    ],
    lastIngestedAt: "2026-10-27T08:00:00.000Z",
  };
}

test("as-of date is the latest final game with a complete box score", () => {
  assert.equal(aflAsOf(snapshot()), "2026-10-25");
  const s = snapshot();
  s.games = s.games.filter((g) => g.status !== "final");
  assert.equal(aflAsOf(s), null);
  assert.deepEqual(
    buildPlayerRows(s).find((r) => r.id === HITTER)?.batting,
    null,
  );
});

test("season and window aggregates use only complete games and shared formulas", () => {
  const s = snapshot();
  const season = buildPlayerRows(s, "season").find((r) => r.id === HITTER)!;
  const expected = aggregateBatting(
    s.batting.filter((l) => l.playerId === HITTER && l.gameId !== u(104)),
  );
  assert.deepEqual(season.batting, expected);
  assert.equal(season.batting!.gameLines, 3);
  assert.equal(season.batting!.homeRuns, 2);
  assert.equal(season.batting!.runs, null, "unknown optional counts stay null");
  // 7D ending Oct 25 covers Oct 19–25: games 2 and 3 only.
  const week = buildPlayerRows(s, "7d").find((r) => r.id === HITTER)!;
  assert.equal(week.batting!.gameLines, 2);
  assert.equal(week.batting!.atBats, 9);
  assert.equal(season.age, 22);
});

test("team and organization come from the latest roster observation, with a box-score fallback", () => {
  const rows = buildPlayerRows(snapshot());
  const hitter = rows.find((r) => r.id === HITTER)!;
  assert.equal(hitter.team?.id, T1);
  assert.equal(hitter.organization?.abbreviation, "EPC");
  assert.equal(hitter.teamSource, "roster");
  const pitcher = rows.find((r) => r.id === PITCHER)!;
  assert.equal(
    pitcher.organization,
    null,
    "unresolved affiliation is never invented",
  );
  const unlisted = rows.find((r) => r.id === NO_ROSTER)!;
  assert.equal(unlisted.team?.id, T2);
  assert.equal(unlisted.teamSource, "game-lines");
  assert.equal(unlisted.organization, null);
  const twoWay = rows.find((r) => r.id === TWO_WAY)!;
  assert.ok(twoWay.batting && twoWay.pitching);
  assert.equal(twoWay.position, "P / DH");
});

test("directory filters by name, team, and organization", () => {
  const rows = buildPlayerRows(snapshot());
  assert.deepEqual(
    filterPlayerRows(rows, { query: "alpha" }).map((r) => r.id),
    [HITTER],
  );
  assert.equal(filterPlayerRows(rows, { query: "javelinas" }).length, 2);
  assert.equal(filterPlayerRows(rows, { query: "EPC" }).length, 2);
  assert.deepEqual(
    filterPlayerRows(rows, { teamId: T1, organizationId: ORG }).map(
      (r) => r.id,
    ),
    [HITTER, TWO_WAY],
  );
});

test("recent performers are a raw-stat sort with a PA qualifier, not a model", () => {
  const s = snapshot();
  const hitters = recentPerformers(s, "30d", "hitters");
  assert.equal(hitters.length, 0, "14 PA is below the 30D minimum of 40");
  const week = recentPerformers(s, "14d", "hitters");
  assert.equal(week.length, 0, "9 PA is below the 14D minimum of 20");
  s.batting.push(bat(HITTER, 3, T1, 30, 30, 9));
  const qualified = recentPerformers(s, "7d", "hitters");
  assert.deepEqual(
    qualified.map((p) => p.playerId),
    [HITTER],
  );
  assert.equal(qualified[0].sortLabel, "OPS");
  const pitchers = recentPerformers(snapshot(), "7d", "pitchers");
  assert.deepEqual(
    pitchers.map((p) => p.playerId),
    [PITCHER, TWO_WAY],
  );
  assert.equal(pitchers[0].sortValue, "7");
  assert.match(pitchers[0].summary, /^5\.0 IP · 5\.40 ERA$/);
});

test("scoreboard shows the latest completed date and the next scheduled date", () => {
  const games = scoreboard(snapshot());
  assert.deepEqual(
    games.map((g) => [g.date, g.statusLabel]),
    [
      ["2026-10-25", "Final"],
      ["2026-10-27", "12:05 PM MST"],
    ],
  );
  assert.equal(games[0].away.abbreviation, "FJV");
  assert.equal(games[0].homeScore, 6);
  const s = snapshot();
  s.games[4].homeScore = 3; // a stray score on a scheduled game is not displayed
  assert.equal(scoreboard(s)[1].homeScore, null);
});

test("player profile builds windows, a complete-games-only game log, and roster history", () => {
  const profile = playerProfile(snapshot(), HITTER)!;
  assert.equal(profile.asOf, "2026-10-25");
  assert.deepEqual(
    profile.gameLog.map((g) => [
      g.date,
      g.result,
      g.home,
      g.opponent?.abbreviation,
    ]),
    [
      ["2026-10-25", "T 6–6", true, "FJV"],
      ["2026-10-20", "L 2–4", true, "FJV"],
      ["2026-10-01", "W 5–3", true, "FJV"],
    ],
  );
  assert.equal(profile.windows.season.batting!.gameLines, 3);
  assert.equal(profile.windows.season.pitching, null);
  assert.deepEqual(
    profile.rosterHistory.map((r) => r.team?.abbreviation),
    ["SSG", "FJV"],
  );
  const pitcherLog = playerProfile(snapshot(), PITCHER)!.gameLog;
  assert.equal(pitcherLog[0].home, false);
  assert.equal(pitcherLog[0].result, "T 6–6");
  assert.equal(pitcherLog[1].result, "W 4–2");
  assert.equal(playerProfile(snapshot(), u(999)), null);
});

test("formatting helpers", () => {
  assert.equal(formatRate(0.3333), ".333");
  assert.equal(formatRate(1.25), "1.250");
  assert.equal(formatRate(null), "—");
  assert.equal(inningsFromOuts(17), "5.2");
});

test("database access stays server-side and read-only", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk("src");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!/^["']use client["']/.test(text)) continue;
    assert.doesNotMatch(
      text,
      /from "@\/(db\/|services\/afl"|services\/afl\/(index|queries))/,
      `${file} is a Client Component and must not import database code`,
    );
  }
  const entry = readFileSync("src/services/afl/index.ts", "utf8");
  assert.match(entry, /^import "server-only";/);
  const queries = readFileSync("src/services/afl/queries.ts", "utf8");
  assert.match(queries, /accessMode: "read only"/);
  assert.doesNotMatch(queries, /\.(insert|update|delete)\(/);
  assert.doesNotMatch(queries, /externalIds\s*:/);
});
