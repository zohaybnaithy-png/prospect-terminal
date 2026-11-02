import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PostgresIngestionSink } from "../src/ingestion/postgres-sink";
import { MLBStatsApiSource } from "../src/ingestion/sources/mlb-stats-api";
import { ingest } from "../src/ingestion/runner";
import { GameStatisticsRepository } from "../src/statistics/repository";
import {
  recordedScheduleFetch,
  syntheticMlb,
  mockMlbFetch,
} from "./mlb-test-support";
test("MLB source offline PostgreSQL workflow", async (t) => {
  const url = process.env.MLB_TEST_DATABASE_URL;
  if (!url || new URL(url).pathname !== "/prospect_mlb_test")
    throw new Error(
      "Use a fresh migrated prospect_mlb_test database via MLB_TEST_DATABASE_URL",
    );
  const c = new Client({ connectionString: url });
  await c.connect();
  const sink = new PostgresIngestionSink(url);
  const pool = new Pool({ connectionString: url });
  const stats = new GameStatisticsRepository(drizzle(pool));
  const count = async (table: string) =>
    (await c.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0]
      .n as number;
  const source = (data = syntheticMlb(), date = "2026-10-27T12:00:00Z") =>
    new MLBStatsApiSource(
      { season: 2026 },
      {
        fetcher: mockMlbFetch(data).fetcher,
        sleep: async () => {},
        clock: () => new Date(date),
      },
    );
  const id = async (kind: string, external: string) =>
    (
      await c.query(
        "SELECT internal_id FROM source_identities WHERE provider='mlb-stats-api' AND entity_kind=$1 AND external_id=$2",
        [kind, external],
      )
    ).rows[0].internal_id as string;
  try {
    assert.equal(await count("players"), 0);
    await t.test(
      "dry-run with and without database makes no writes, then live-shaped apply creates normalized game lines",
      async () => {
        const offline = await ingest(source());
        assert.equal(offline.status, "dry-run");
        const preview = await ingest(source(), sink, { dryRun: true });
        assert.ok(preview.databaseComparison!.insert > 0);
        assert.equal(await count("source_snapshots"), 0);
        assert.equal(await count("ingestion_runs"), 0);
        assert.equal(await count("players"), 0);
        const result = await ingest(source(), sink);
        assert.equal(result.issues, 0);
        assert.equal(await count("teams"), 6);
        assert.equal(await count("players"), 3);
        assert.equal(await count("games"), 3);
        assert.equal(await count("player_batting_games"), 4);
        assert.equal(await count("player_pitching_games"), 4);
        assert.equal(await count("player_organization_memberships"), 0);
        assert.equal(await count("player_team_memberships"), 0);
        const row = (
          await c.query(
            "SELECT official_date::text,home_score,away_score,venue,boxscore_complete FROM games WHERE id=$1",
            [await id("game", "8001")],
          )
        ).rows[0];
        assert.equal(row.official_date, "2026-10-24");
        assert.equal(row.home_score, 4);
        assert.equal(row.venue, "Fixture Park");
        assert.equal(row.boxscore_complete, true);
        const snapshot = (
          await c.query("SELECT payload FROM source_snapshots LIMIT 1")
        ).rows[0].payload;
        assert.equal(snapshot.format, "mlb-response-manifest-v1");
        assert.equal(snapshot.records, undefined);
      },
    );
    await t.test(
      "replay preserves identities, games and lines and read-only comparison identifies no-ops",
      async () => {
        const before = (
          await c.query(
            "SELECT provider,entity_kind,external_id,internal_id FROM source_identities ORDER BY entity_kind,external_id",
          )
        ).rows;
        const report = await ingest(source(), sink);
        assert.equal(report.changed, 0);
        assert.deepEqual(
          (
            await c.query(
              "SELECT provider,entity_kind,external_id,internal_id FROM source_identities ORDER BY entity_kind,external_id",
            )
          ).rows,
          before,
        );
        assert.equal(await count("player_batting_games"), 4);
        assert.equal(await count("source_roster_observations"), 4);
        const runs = await count("ingestion_runs");
        const preview = await ingest(source(), sink, { dryRun: true });
        assert.equal(preview.databaseComparison!.insert, 0);
        assert.equal(preview.databaseComparison!.update, 0);
        assert.equal(await count("ingestion_runs"), runs);
      },
    );
    await t.test(
      "rolling aggregation uses official game dates, season/league isolation and complete final games",
      async () => {
        const player = await id("player", "1001"),
          league = await id("league", "119");
        const opts = {
          season: 2026,
          asOf: "2026-10-24",
          leagueId: league,
          window: "14d" as const,
        };
        const recent = await stats.getPlayerBattingStats(player, opts);
        assert.equal(recent.gameLines, 1);
        assert.equal(recent.hits, 2);
        assert.equal(recent.avg, 0.5);
        assert.equal(recent.obp, 0.6);
        assert.equal(recent.slg, 0.75);
        assert.equal(recent.kPct, 20);
        const season = await stats.getPlayerBattingStats(player, {
          ...opts,
          window: "season",
        });
        assert.equal(season.gameLines, 2);
        assert.equal(season.hits, 4);
        const one = await stats.getPlayerBattingStats(player, {
          ...opts,
          window: { from: "2026-10-10", to: "2026-10-10" },
        });
        assert.equal(one.gameLines, 1);
        const pitcher = await stats.getPlayerPitchingStats(
          await id("player", "1002"),
          opts,
        );
        assert.equal(pitcher.outsRecorded, 17);
        assert.ok(Math.abs(pitcher.era! - 81 / 17) < 1e-9);
        const none = await stats.getPlayerBattingStats(player, {
          ...opts,
          teamId: await id("team", "9102"),
        });
        assert.equal(none.hits, 0);
        assert.equal(none.avg, null);
      },
    );
    await t.test(
      "malformed boxscore is audited while other validated updates apply and last good lines survive",
      async () => {
        const data = syntheticMlb();
        data.boxes["8001"].teams.home.players.ID1001.stats.batting.hits = 99;
        data.people.people[0].weight = 190;
        const r = await ingest(source(data, "2026-10-28T12:00:00Z"), sink);
        assert.equal(r.status, "applied-with-quarantine");
        assert.ok(r.issues > 0);
        assert.ok((await count("ingestion_issues")) > 0);
        assert.equal(
          (
            await c.query("SELECT weight FROM players WHERE id=$1", [
              await id("player", "1001"),
            ])
          ).rows[0].weight,
          190,
        );
        assert.equal(
          (
            await c.query(
              "SELECT hits FROM player_batting_games WHERE game_id=$1 AND player_id=$2",
              [await id("game", "8001"), await id("player", "1001")],
            )
          ).rows[0].hits,
          2,
        );
      },
    );
    await t.test(
      "corrected complete boxscore replaces counts and removes only source-owned stale lines",
      async () => {
        const data = syntheticMlb();
        data.boxes["8001"].teams.home.players.ID1001.stats.batting.hits = 3;
        data.boxes["8001"].teams.home.players.ID1003.stats.batting =
          {} as (typeof data.boxes)["8001"]["teams"]["home"]["players"]["ID1003"]["stats"]["batting"];
        const r = await ingest(source(data, "2026-10-29T12:00:00Z"), sink);
        assert.equal(r.status, "applied");
        assert.equal(await count("player_batting_games"), 3);
        assert.equal(
          (
            await c.query(
              "SELECT hits FROM player_batting_games WHERE game_id=$1 AND player_id=$2",
              [await id("game", "8001"), await id("player", "1001")],
            )
          ).rows[0].hits,
          3,
        );
        await ingest(source(data, "2026-10-30T12:00:00Z"), sink);
        assert.equal(await count("player_batting_games"), 3);
        assert.equal(await count("games"), 3);
      },
    );
    await t.test(
      "recorded weather reschedules persist one complete game each and replay safely with transparent special-game notices",
      async () => {
        const recordedSource = () =>
          new MLBStatsApiSource(
            { season: 2026, mode: "games" },
            {
              fetcher: recordedScheduleFetch().fetcher,
              sleep: async () => {},
              clock: () => new Date("2026-11-01T12:00:00Z"),
            },
          );
        const preview = await ingest(recordedSource(), sink, { dryRun: true });
        assert.equal(preview.status, "dry-run");
        assert.equal(preview.issues, 0);
        assert.equal(preview.notices!.length, 8);
        assert.equal(await count("games"), 3);
        const first = await ingest(recordedSource(), sink);
        assert.equal(first.status, "applied");
        assert.equal(first.issues, 0);
        const before = await c.query(
          "SELECT id,game_id,player_id,team_id FROM player_batting_games ORDER BY id",
        );
        for (const external of ["867710", "867709"]) {
          const gameId = await id("game", external);
          const row = (
            await c.query(
              "SELECT starts_at,official_date::text,status,venue,boxscore_complete FROM games WHERE id=$1",
              [gameId],
            )
          ).rows[0];
          assert.equal(row.starts_at.toISOString(), "2026-10-14T20:30:00.000Z");
          assert.equal(row.official_date, "2026-10-14");
          assert.equal(row.status, "final");
          assert.equal(row.boxscore_complete, true);
          assert.equal(
            (
              await c.query(
                "SELECT count(*)::int AS n FROM player_batting_games WHERE game_id=$1",
                [gameId],
              )
            ).rows[0].n,
            2,
          );
          assert.equal(
            (
              await c.query(
                "SELECT count(*)::int AS n FROM player_pitching_games WHERE game_id=$1",
                [gameId],
              )
            ).rows[0].n,
            2,
          );
        }
        const replay = await ingest(recordedSource(), sink);
        assert.equal(replay.changed, 0);
        assert.deepEqual(
          (
            await c.query(
              "SELECT id,game_id,player_id,team_id FROM player_batting_games ORDER BY id",
            )
          ).rows,
          before.rows,
        );
        assert.equal(await count("games"), 93);
        assert.equal(
          (
            await c.query(
              "SELECT count(*)::int AS n FROM source_identities WHERE entity_kind='game' AND external_id IN ('867649','867642','867641','867640','867639','867638')",
            )
          ).rows[0].n,
          0,
        );
      },
    );
  } finally {
    await sink.close();
    await pool.end();
    await c.end();
  }
});
