import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { PostgresIngestionSink } from "../src/ingestion/postgres-sink";
import { MLBStatsApiSource } from "../src/ingestion/sources/mlb-stats-api";
import { ingest } from "../src/ingestion/runner";
import { GameStatisticsRepository } from "../src/statistics/repository";
import { loadAflSnapshot } from "../src/services/afl/queries";
import {
  aflAsOf,
  buildPlayerRows,
  playerProfile,
} from "../src/services/afl/read-model";
import { mockMlbFetch, syntheticMlb } from "./mlb-test-support";
import {
  MOMENTUM_WINDOW_IDS,
  changeSnapshot,
  compareModels,
  createAnalyticsContext,
  momentum,
  playerRoles,
} from "../src/analytics";
import { mapSets, playerAnalyticsView, riserSets } from "../src/analytics/views";

/**
 * Exercises the read layer's real SQL against a fresh, migrated, disposable database populated
 * by the existing synthetic MLB-shaped ingestion. Never point this at Neon or production.
 */
test("AFL read layer against ingested PostgreSQL data", async (t) => {
  const url = process.env.AFL_READ_TEST_DATABASE_URL;
  if (!url || new URL(url).pathname !== "/prospect_afl_read_test")
    throw new Error(
      "Use a fresh migrated prospect_afl_read_test database via AFL_READ_TEST_DATABASE_URL",
    );
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  try {
    await t.test("returns null before any AFL ingestion", async () => {
      assert.equal(await loadAflSnapshot(db), null);
    });

    const sink = new PostgresIngestionSink(url);
    const result = await ingest(
      new MLBStatsApiSource(
        { season: 2026 },
        {
          fetcher: mockMlbFetch(syntheticMlb()).fetcher,
          sleep: async () => {},
          clock: () => new Date("2026-10-27T12:00:00Z"),
        },
      ),
      sink,
    );
    assert.equal(result.issues, 0);

    await t.test(
      "loads the season inside a read-only transaction",
      async () => {
        const configs: unknown[] = [];
        const spy = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === "transaction")
              return (fn: never, config: unknown) => {
                configs.push(config);
                return target.transaction(fn, config as never);
              };
            return Reflect.get(target, prop, receiver);
          },
        });
        const snapshot = await loadAflSnapshot(spy);
        assert.ok(snapshot);
        assert.deepEqual(configs, [
          { accessMode: "read only", isolationLevel: "repeatable read" },
        ]);
      },
    );

    await t.test(
      "snapshot matches stored rows and repository aggregates",
      async () => {
        const s = (await loadAflSnapshot(db))!;
        assert.equal(s.season.year, 2026);
        assert.equal(s.teams.length, 6);
        assert.equal(s.players.length, 3);
        assert.equal(s.games.length, 3);
        assert.equal(s.batting.length, 4);
        assert.equal(s.pitching.length, 4);
        assert.ok(s.rosterStints.length > 0);
        assert.ok(s.lastIngestedAt);
        for (const p of s.players)
          assert.equal(
            "externalIds" in p,
            false,
            "provider IDs are not exposed",
          );
        const asOf = aflAsOf(s)!;
        assert.equal(asOf, "2026-10-24");
        const repo = new GameStatisticsRepository(db);
        for (const row of buildPlayerRows(s, "season")) {
          const options = {
            season: 2026,
            leagueId: s.league.id,
            asOf,
            window: "season" as const,
          };
          if (row.batting) {
            const expected = await repo.getPlayerBattingStats(row.id, options);
            assert.equal(
              row.batting.plateAppearances,
              expected.plateAppearances,
            );
            assert.equal(row.batting.hits, expected.hits);
            assert.equal(row.batting.ops, expected.ops);
          }
          if (row.pitching) {
            const expected = await repo.getPlayerPitchingStats(row.id, options);
            assert.equal(row.pitching.outsRecorded, expected.outsRecorded);
            assert.equal(row.pitching.era, expected.era);
          }
          const profile = playerProfile(s, row.id)!;
          assert.equal(profile.player.name, row.name);
        }
      },
    );

    await t.test(
      "analytics windows match repository aggregates and views compute read-only",
      async () => {
        const s = (await loadAflSnapshot(db))!;
        const counts = async () =>
          (
            await pool.query(
              "select (select count(*) from player_batting_games) b, (select count(*) from player_pitching_games) p, (select count(*) from games) g",
            )
          ).rows[0];
        const before = await counts();
        const ctx = createAnalyticsContext(s);
        const repo = new GameStatisticsRepository(db);
        const asOf = ctx.ds.asOf!;
        for (const player of s.players)
          for (const role of playerRoles(ctx.ds, player.id))
            for (const w of MOMENTUM_WINDOW_IDS) {
              const snap = changeSnapshot(ctx, player.id, role, w, asOf);
              for (const [range, sample] of [
                [snap.ranges.recent, snap.recent],
                [snap.ranges.baseline, snap.baseline],
              ] as const) {
                if (!range) continue;
                const options = {
                  season: 2026,
                  leagueId: s.league.id,
                  asOf,
                  window: range,
                };
                if (role === "hitter") {
                  const e = await repo.getPlayerBattingStats(player.id, options);
                  assert.equal(
                    sample && "plateAppearances" in sample ? sample.plateAppearances : 0,
                    e.plateAppearances,
                  );
                } else {
                  const e = await repo.getPlayerPitchingStats(player.id, options);
                  assert.equal(
                    sample && "battersFaced" in sample ? sample.battersFaced : 0,
                    e.battersFaced,
                  );
                }
              }
              const m = momentum(ctx, player.id, role, w, "balanced");
              assert.ok(m.score === null || Math.abs(m.score) <= 100);
              assert.doesNotThrow(() => JSON.stringify(m));
            }
        for (const player of s.players)
          assert.doesNotThrow(() =>
            JSON.stringify(playerAnalyticsView(s, player.id)),
          );
        assert.doesNotThrow(() => JSON.stringify(riserSets(s)));
        assert.doesNotThrow(() => JSON.stringify(mapSets(s)));
        assert.equal(compareModels(ctx, "14d").models.length, 3);
        assert.deepEqual(await counts(), before, "analytics never writes");
      },
    );
  } finally {
    await pool.end();
  }
});
