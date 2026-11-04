import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { PostgresIngestionSink } from "../src/ingestion/postgres-sink";
import { MLBStatsApiSource } from "../src/ingestion/sources/mlb-stats-api";
import { ingest } from "../src/ingestion/runner";
import { runMilbIngestion, type MilbRunOptions } from "../src/ingestion/milb-runner";
import {
  buildMilbFixture,
  milbFixtureFetch,
  FIXTURE_IDS,
  batting,
  type MilbFixture,
} from "../src/ingestion/fixtures/milb-synthetic";
import { GameStatisticsRepository } from "../src/statistics/repository";
import { loadAflSnapshot, loadMilbLevelSnapshot } from "../src/services/afl/queries";
import { buildPlayerRows, playerProfile } from "../src/services/afl/read-model";
import { createAnalyticsContext, playerMomentumByWindow } from "../src/analytics";
import { mockMlbFetch, syntheticMlb } from "./mlb-test-support";

/**
 * MiLB pipeline against a fresh, migrated, DISPOSABLE PostgreSQL database populated only by the
 * clearly fictional fixtures. Never point this at Neon or production.
 */
const { teams: T, players: P, games: G, leagues: L } = FIXTURE_IDS;
const opts = (o: Partial<MilbRunOptions> = {}): MilbRunOptions => ({
  season: 2026,
  levels: ["aaa", "aa", "high-a", "single-a"],
  mode: "all",
  apply: true,
  incremental: false,
  refetchComplete: false,
  chunkDays: 7,
  concurrency: 4,
  lookbackDays: 3,
  refetchWindowDays: 3,
  rosterType: "fullSeason",
  gameTypes: ["R"],
  from: "2026-04-15",
  to: "2026-05-31",
  ...o,
});

test("MiLB ingestion against PostgreSQL", async (t) => {
  const url = process.env.MILB_TEST_DATABASE_URL;
  if (!url || new URL(url).pathname !== "/prospect_milb_test")
    throw new Error("Use a fresh migrated prospect_milb_test database via MILB_TEST_DATABASE_URL");
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const sink = new PostgresIngestionSink(url);
  const q = async <R = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await pool.query(text, values)).rows as R[];
  const one = async (text: string, values: unknown[] = []) =>
    Number(Object.values((await q(text, values))[0])[0]);
  const internal = async (kind: string, externalId: string | number) =>
    (await q<{ internal_id: string }>(
      "select internal_id from source_identities where provider='mlb-stats-api' and entity_kind=$1 and external_id=$2",
      [kind, String(externalId)],
    ))[0]?.internal_id;
  const counts = async () => ({
    games: await one("select count(*) from games"),
    batting: await one("select count(*) from player_batting_games"),
    pitching: await one("select count(*) from player_pitching_games"),
    players: await one("select count(*) from players"),
    teams: await one("select count(*) from teams"),
    identities: await one("select count(*) from source_identities"),
  });
  // Each capture gets a later timestamp (as real captures do); `at` pins one for exact replays.
  let tick = 0;
  const run = (o: Partial<MilbRunOptions> = {}, data: MilbFixture = buildMilbFixture(), at?: Date) => {
    const mock = milbFixtureFetch(data);
    const captured = at ?? new Date(Date.parse("2026-06-01T12:00:00Z") + 60_000 * tick++);
    return runMilbIngestion(opts(o), { sink, fetcher: mock.fetcher, sleep: async () => {}, clock: () => captured }).then((summary) => ({ summary, mock }));
  };

  try {
    // AFL data must be unaffected by everything below.
    await ingest(
      new MLBStatsApiSource({ season: 2026 }, { fetcher: mockMlbFetch(syntheticMlb()).fetcher, sleep: async () => {}, clock: () => new Date("2026-10-27T12:00:00Z") }),
      sink,
    );
    const aflBefore = await loadAflSnapshot(db);
    assert.ok(aflBefore);

    await t.test("dry run with a database is read-only", async () => {
      const before = await counts();
      const runs = await one("select count(*) from ingestion_runs");
      const { summary } = await run({ apply: false });
      assert.equal(summary.chunks[0].status, "dry-run");
      assert.ok(summary.chunks[0].databaseComparison!.insert > 0);
      assert.deepEqual(await counts(), before);
      assert.equal(await one("select count(*) from ingestion_runs"), runs);
    });

    let first: Awaited<ReturnType<typeof run>>;
    await t.test("backfill applies structure and game chunks", async () => {
      first = await run();
      const { summary, mock } = first;
      assert.equal(summary.status, "ok-with-quarantine", JSON.stringify(summary.chunks.map((c) => [c.from, c.status, c.error])));
      assert.equal(summary.chunks.length, 1 + 7);
      assert.ok(summary.chunks.every((c) => c.status === "applied" || c.status === "applied-with-quarantine"));
      // Only the conflicting duplicate game is quarantined.
      assert.equal(summary.totals.issues, 1);
      assert.equal(await one("select count(*) from games g join source_identities s on s.internal_id=g.id and s.entity_kind='game' and s.external_id like '96%'"), 12);
      assert.equal(await internal("game", G.conflicting), undefined);
      assert.equal(await internal("game", G.exhibition), undefined);
      assert.equal(await one("select count(*) from games g join source_identities s on s.internal_id=g.id and s.entity_kind='game' and s.external_id like '96%' where g.boxscore_complete"), 10);
      // One boxscore request per completed game, including the reconciled ones.
      assert.equal(mock.count(/\/boxscore$/), 10);
      assert.equal(await one("select count(*) from teams t join source_identities s on s.internal_id=t.id and s.entity_kind='team' and s.external_id like '93%'"), 9);
      assert.ok(await internal("organization", FIXTURE_IDS.orgs.epc));
      assert.ok(await internal("organization", FIXTURE_IDS.orgs.sbc));
      assert.equal(await internal("organization", FIXTURE_IDS.orgs.notMlb), undefined);
    });

    await t.test("hierarchy: organization → affiliate → level → league", async () => {
      const [row] = await q<{ team: string; org: string | null; level: string; league: string }>(
        `select t.name team, o.abbreviation org, l.name level, lg.name league
           from teams t join levels l on l.id=t.level_id join leagues lg on lg.id=l.league_id
           left join organizations o on o.id=t.organization_id where t.id=$1`,
        [await internal("team", T.aaa3)],
      );
      assert.deepEqual(row, { team: "Fixture Triple-A Canyons", org: "EPC", level: "Triple-A", league: "Synthetic Pacific League" });
      const [unaffiliated] = await q<{ organization_id: string | null }>("select organization_id from teams where id=$1", [await internal("team", T.highA2)]);
      assert.equal(unaffiliated.organization_id, null);
      assert.equal(await one("select count(*) from levels where name in ('Triple-A','Double-A','High-A','Single-A')"), 5);
    });

    await t.test("no duplicate source games, players or lines; lines reference valid games/teams", async () => {
      assert.equal(await one("select count(*) from (select entity_kind, external_id from source_identities group by 1,2 having count(*)>1) d"), 0);
      assert.equal(await one("select count(*) from (select player_id, game_id from player_batting_games group by 1,2 having count(*)>1) d"), 0);
      assert.equal(
        await one(`select count(*) from player_batting_games b join games g on g.id=b.game_id
                   where b.team_id not in (g.home_team_id, g.away_team_id)`),
        0,
      );
      assert.equal(
        await one(`select count(*) from games g where g.boxscore_complete and g.status <> 'final'`),
        0,
      );
      // Completed games reconcile with stored lines: every complete MiLB game has lines for both sides.
      assert.equal(
        await one(`select count(*) from games g join source_identities s on s.internal_id=g.id and s.entity_kind='game' and s.external_id like '96%'
                   where g.boxscore_complete and (select count(distinct team_id) from player_pitching_games p where p.game_id=g.id) <> 2`),
        0,
      );
    });

    await t.test("replay is idempotent", async () => {
      const before = await counts();
      const observations = await one("select count(*) from source_roster_observations");
      // Exact replay of the same capture: nothing changes at all.
      const exact = await run({}, buildMilbFixture(), new Date("2026-06-01T12:00:00Z"));
      assert.equal(exact.summary.totals.changed, 0);
      assert.equal(await one("select count(*) from source_roster_observations"), observations);
      // A new capture of unchanged data: no duplicate games/lines/identities; only the new
      // capture's roster observations are new rows (observations are keyed by capture time).
      const { summary } = await run();
      assert.deepEqual(await counts(), before);
      const games = summary.chunks.filter((c) => c.phase === "games");
      assert.ok(games.every((c) => c.changed === 0), JSON.stringify(games.map((c) => c.changed)));
      assert.equal(summary.chunks[0].changed, 20);
      assert.equal(await one("select count(*) from source_roster_observations"), observations + 20);
    });

    await t.test("multi-level movement keeps history; one player identity", async () => {
      const riser = await internal("player", P.riser);
      const stints = await q<{ level: string }>(
        `select distinct l.name level from source_roster_observations r join teams t on t.id=r.team_id
           join levels l on l.id=t.level_id where r.player_id=$1 order by 1`,
        [riser],
      );
      assert.deepEqual(stints.map((s) => s.level), ["Double-A", "Triple-A"]);
      // A later capture where the AA roster no longer lists the riser keeps the earlier observation.
      const data = buildMilbFixture();
      data.rosters[T.aa1] = data.rosters[T.aa1].filter((r) => (r.person as { id: number }).id !== P.riser);
      await run({ mode: "structure", levels: ["aa"] }, data);
      assert.equal(
        await one("select count(*) from source_roster_observations r where r.player_id=$1 and r.team_id=$2", [riser, await internal("team", T.aa1)]),
        2,
        "both earlier AA observations remain history; the new capture adds none for AA",
      );
      assert.equal(await one("select count(*) from players where id=$1", [riser]), 1);
      const lineLevels = await q<{ level: string; n: string }>(
        `select l.name level, count(*) n from player_batting_games b join teams t on t.id=b.team_id
           join levels l on l.id=t.level_id where b.player_id=$1 group by 1 order by 1`,
        [riser],
      );
      assert.deepEqual(lineLevels.map((r) => [r.level, Number(r.n)]), [["Double-A", 1], ["Triple-A", 2]]);
    });

    await t.test("incremental run reuses complete games and fetches nothing unchanged", async () => {
      assert.equal(await sink.latestCompleteGameDate("mlb-stats-api", "milb-2026"), "2026-05-12");
      assert.equal(await sink.latestCompleteGameDate("mlb-stats-api", "milb-2026", ["milb:13:"]), "2026-05-01");
      const complete = await sink.completedGameIds("mlb-stats-api");
      assert.ok(complete.has(String(G.aaLate)) && !complete.has(String(G.cancelled)));
      const before = await counts();
      const { summary, mock } = await run({ incremental: true, from: undefined, to: undefined, mode: "games" });
      assert.deepEqual(summary.range, { from: "2026-05-09", to: "2026-06-01" });
      assert.equal(mock.count(/\/boxscore$/), 0);
      assert.equal(mock.count(/\/people$/), 0, "known players are not looked up");
      assert.deepEqual(await counts(), before);
    });

    await t.test("a corrected boxscore replaces lines without duplicates", async () => {
      const data = buildMilbFixture();
      const box = data.boxes[G.aaLate] as { teams: { home: { players: Record<string, unknown> } } };
      (box.teams.home.players[`ID${P.aa2Bat}`] as { stats: { batting: unknown } }).stats.batting = batting(5, 4, 3, { hr: 2, bb: 1 });
      delete box.teams.home.players[`ID${P.aa2Arm}`]; // scorer removed a line
      const before = await counts();
      const { summary } = await run({ levels: ["aa"], mode: "games", refetchComplete: true, from: "2026-05-12", to: "2026-05-12" }, data);
      assert.equal(summary.status, "ok");
      const gameId = await internal("game", G.aaLate);
      const [line] = await q<{ hits: number; home_runs: number }>(
        "select hits, home_runs from player_batting_games where game_id=$1 and player_id=$2",
        [gameId, await internal("player", P.aa2Bat)],
      );
      assert.deepEqual(line, { hits: 3, home_runs: 2 });
      assert.equal(await one("select count(*) from player_pitching_games where game_id=$1", [gameId]), 1);
      assert.deepEqual(await counts(), { ...before, pitching: before.pitching - 1 });
    });

    await t.test("a failing chunk rolls back completely and reports where to resume", async () => {
      const before = await counts();
      // Another provider owns the canonical row of a game in this chunk → ownership conflict.
      const gameId = await internal("game", G.highA);
      await q("update ingestion_record_state set provider='another-provider' where canonical_key=$1", [`entity:game:${gameId}`]);
      const data = buildMilbFixture();
      // New data in the same chunk must not be partially written.
      data.schedule[13].push(["2026-05-02", { ...(data.schedule[13][0][1] as object), gamePk: 9622, officialDate: "2026-05-02", gameDate: "2026-05-02T23:05:00Z" }]);
      data.boxes[9622] = data.boxes[G.highA];
      ((data.schedule[13][0][1] as { teams: { home: { score: number } } }).teams.home.score = 11);
      const { summary } = await run({ levels: ["high-a"], mode: "games", refetchComplete: true, from: "2026-04-29", to: "2026-05-05" }, data);
      assert.equal(summary.status, "failed");
      assert.equal(summary.resumeFrom, "2026-04-29");
      assert.match(summary.chunks.at(-1)!.error!, /rolled back \(source-ownership-conflict/);
      assert.deepEqual(await counts(), before);
      assert.equal(await internal("game", 9622), undefined);
      assert.equal(await one("select home_score from games where id=$1", [gameId]), 5);
      assert.equal(await one("select count(*) from ingestion_runs where status='failed' and error_code='source-ownership-conflict'"), 1);
      await q("update ingestion_record_state set provider='mlb-stats-api' where canonical_key=$1", [`entity:game:${gameId}`]);
    });

    await t.test("a malformed boxscore is quarantined; the game stays incomplete and earlier lines survive", async () => {
      const data = buildMilbFixture();
      const box = data.boxes[G.singleA] as { teams: { away: { players: Record<string, { stats: { pitching: Record<string, unknown> } }> } } };
      box.teams.away.players[`ID${P.lo2Arm}`].stats.pitching = { inningsPitched: "5.4" };
      const gameId = await internal("game", G.singleA);
      const lines = await one("select count(*) from player_batting_games where game_id=$1", [gameId]);
      const { summary } = await run({ levels: ["single-a"], mode: "games", refetchComplete: true, from: "2026-05-01", to: "2026-05-01" }, data);
      assert.equal(summary.status, "ok-with-quarantine");
      assert.equal(summary.chunks.at(-1)!.status, "applied-with-quarantine");
      assert.equal(await one("select count(*) from player_batting_games where game_id=$1", [gameId]), lines);
      assert.ok(await one("select count(*) from ingestion_issues where record_key like $1", [`%${G.singleA}%`]) > 0);
      // A brand-new game with a malformed boxscore is stored but never marked complete.
      const fresh = buildMilbFixture();
      fresh.schedule[14].push(["2026-05-03", { ...(fresh.schedule[14][0][1] as object), gamePk: 9632, officialDate: "2026-05-03", gameDate: "2026-05-03T23:05:00Z" }]);
      fresh.boxes[9632] = data.boxes[G.singleA];
      await run({ levels: ["single-a"], mode: "games", from: "2026-05-03", to: "2026-05-03" }, fresh);
      const freshId = await internal("game", 9632);
      assert.ok(freshId);
      assert.equal(await one("select boxscore_complete::int from games where id=$1", [freshId]), 0);
      assert.equal(await one("select count(*) from player_batting_games where game_id=$1", [freshId]), 0);
    });

    await t.test("level read model feeds the shared aggregation and Analytics V1", async () => {
      const aaa = (await loadMilbLevelSnapshot(db, "aaa", 2026))!;
      assert.ok(aaa);
      assert.equal(aaa.league.name, "Triple-A");
      assert.equal(aaa.scope?.kind, "milb-level");
      assert.equal(aaa.scope?.leagueIds.length, 2);
      assert.equal(aaa.teams.length, 3);
      assert.equal(aaa.games.length, 8);
      const aaaTeams = new Set(await Promise.all([T.aaa1, T.aaa2, T.aaa3].map((id) => internal("team", id))));
      assert.ok(aaa.games.every((g) => aaaTeams.has(g.homeTeamId) && aaaTeams.has(g.awayTeamId)));
      const repo = new GameStatisticsRepository(db);
      const leagueOf = async (id: number) => internal("league", id);
      for (const row of buildPlayerRows(aaa, "season")) {
        if (!row.batting) continue;
        let pa = 0;
        for (const league of [L.aaaEast, L.aaaWest])
          pa += (await repo.getPlayerBattingStats(row.id, { season: 2026, leagueId: (await leagueOf(league))!, asOf: "2026-05-31", window: "season" })).plateAppearances;
        assert.equal(row.batting.plateAppearances, pa, row.name);
      }
      const riser = await internal("player", P.riser);
      const aaaRow = buildPlayerRows(aaa, "season").find((r) => r.id === riser)!;
      assert.equal(aaaRow.batting!.plateAppearances, 8, "only Triple-A games");
      assert.equal(aaaRow.team?.name, "Fixture Triple-A Comets");
      const aa = (await loadMilbLevelSnapshot(db, "aa", 2026))!;
      const aaRow = buildPlayerRows(aa, "season").find((r) => r.id === riser)!;
      assert.equal(aaRow.batting!.plateAppearances, 5);
      assert.ok(playerProfile(aa, riser));
      const ctx = createAnalyticsContext(aaa);
      const momentum = playerMomentumByWindow(ctx, riser, "hitter", "balanced");
      assert.doesNotThrow(() => JSON.stringify(momentum));
      assert.ok(Object.values(momentum).every((m) => m.score === null || Math.abs(m.score) <= 100));
      assert.equal(await loadMilbLevelSnapshot(db, "aaa", 2025), null);
    });

    await t.test("AFL data is untouched", async () => {
      const aflAfter = await loadAflSnapshot(db);
      assert.deepEqual(
        { ...aflAfter!, lastIngestedAt: null },
        { ...aflBefore!, lastIngestedAt: null },
      );
    });
  } finally {
    await sink.close();
    await pool.end();
  }
});
