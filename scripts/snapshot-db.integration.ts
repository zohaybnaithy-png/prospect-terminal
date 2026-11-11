/**
 * Build-time snapshot export against a fresh, migrated, DISPOSABLE PostgreSQL database populated
 * only by the fictional AFL and MiLB fixtures (docs/VERCEL.md). Never point this at Neon.
 *
 *   createdb prospect_snapshot_test
 *   DATABASE_URL="$SNAPSHOT_TEST_DATABASE_URL" npm run db:migrate
 *   SNAPSHOT_TEST_DATABASE_URL=… npm run test:snapshot:db
 *
 * Proves, on real SQL: the export reads every level through the site's read layer in a
 * read-only session and writes nothing; the files reproduce the database read exactly (so every
 * statistic and Momentum value served from a snapshot equals the database-served one); the export
 * refuses to mix two ingestion states.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { PostgresIngestionSink } from "../src/ingestion/postgres-sink";
import { MLBStatsApiSource } from "../src/ingestion/sources/mlb-stats-api";
import { ingest } from "../src/ingestion/runner";
import { runMilbIngestion } from "../src/ingestion/milb-runner";
import { buildMilbFixture, milbFixtureFetch } from "../src/ingestion/fixtures/milb-synthetic";
import { loadIngestionVersion } from "../src/services/afl/queries";
import { dbLevelLoader, loadCompetition } from "../src/services/competition/load";
import { exportSnapshots } from "../src/services/competition/snapshot-export";
import { snapshotSource } from "../src/services/competition/snapshot-store";
import { snapshotsEqual } from "../src/services/competition/snapshot-format";
import { LEVEL_IDS } from "../src/services/players/levels";
import { playerProfile } from "../src/services/afl/read-model";
import { playerAnalyticsView } from "../src/analytics/views";
import { trendRiserLists } from "../src/services/competition/prepare";
import { MOMENTUM_WINDOW_IDS } from "../src/analytics/config";
import { mockMlbFetch, syntheticMlb } from "./mlb-test-support";

test("snapshot export against PostgreSQL", async (t) => {
  const url = process.env.SNAPSHOT_TEST_DATABASE_URL;
  if (!url || new URL(url).pathname !== "/prospect_snapshot_test")
    throw new Error("Use a fresh migrated prospect_snapshot_test database via SNAPSHOT_TEST_DATABASE_URL");
  const owner = new Pool({ connectionString: url, max: 2 });
  // The export runs on a session that cannot write at all (like the pt_web role, whose sessions
  // default to read-only: deploy/neon-readonly-role.sql).
  const readOnly = new Pool({ connectionString: url, max: 6, options: "-c default_transaction_read_only=on" });
  const db = drizzle(readOnly, { schema });
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "pt-snapshot-db-")), "snap");
  const counts = async () =>
    (
      await owner.query(
        `select (select count(*) from games) games, (select count(*) from player_batting_games) batting,
                (select count(*) from player_pitching_games) pitching, (select count(*) from players) players,
                (select count(*) from ingestion_runs) runs, (select count(*) from source_identities) identities`,
      )
    ).rows[0];
  try {
    const sink = new PostgresIngestionSink(url);
    await ingest(
      new MLBStatsApiSource({ season: 2026 }, { fetcher: mockMlbFetch(syntheticMlb()).fetcher, sleep: async () => {}, clock: () => new Date("2026-10-27T12:00:00Z") }),
      sink,
    );
    const milb = await runMilbIngestion(
      {
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
      },
      { sink, fetcher: milbFixtureFetch(buildMilbFixture()).fetcher, sleep: async () => {}, clock: () => new Date("2026-06-01T12:00:00Z") },
    );
    assert.ok(milb.status.startsWith("ok"), milb.status);

    const before = await counts();
    const version = await loadIngestionVersion(db);
    const load = dbLevelLoader(db, 2026);

    await t.test("exports every level read-only and writes nothing to the database", async () => {
      const report = await exportSnapshots({ dir, season: 2026, load, version: () => loadIngestionVersion(db) });
      assert.equal(report.status, "ok");
      assert.equal(report.ingestionVersion, version);
      assert.deepEqual(await counts(), before);
      assert.ok(Object.values(report.levels).some((l) => l.status === "ok"));
    });

    await t.test("the files reproduce the database read of every level exactly", async () => {
      const files = snapshotSource(dir, 2026);
      for (const level of LEVEL_IDS) assert.ok(snapshotsEqual(await files.load(level), await load(level)), level);
      const fromDb = await loadCompetition(load);
      const fromFiles = await loadCompetition(files.load);
      assert.equal(fromFiles.status, fromDb.status);
      assert.ok(fromDb.status === "ok" && fromFiles.status === "ok");
      assert.deepEqual(fromFiles.levelStatus, fromDb.levelStatus);
    });

    await t.test("statistics and Momentum served from the snapshot equal the database-served values", async () => {
      const files = snapshotSource(dir, 2026);
      for (const level of LEVEL_IDS) {
        const a = await load(level);
        const b = await files.load(level);
        if (!a || !b) continue;
        for (const role of ["hitter", "pitcher"] as const)
          for (const w of MOMENTUM_WINDOW_IDS) assert.deepEqual(trendRiserLists(b, role, w), trendRiserLists(a, role, w), `${level} ${role} ${w}`);
        for (const p of a.players.slice(0, 20)) {
          assert.deepEqual(playerProfile(b, p.id), playerProfile(a, p.id), `${level} profile`);
          assert.deepEqual(playerAnalyticsView(b, p.id), playerAnalyticsView(a, p.id), `${level} momentum`);
        }
      }
    });

    await t.test("the session the export uses cannot write", async () => {
      await assert.rejects(readOnly.query("update players set name = name"), /read-only transaction/);
    });

    await t.test("an ingestion run applied mid-export fails the export and leaves no snapshot", async () => {
      const other = path.join(path.dirname(dir), "other");
      let calls = 0;
      await assert.rejects(
        exportSnapshots({
          dir: other,
          season: 2026,
          load,
          version: async () => (calls++ === 0 ? version : `${version}+1`),
        }),
        /applied during the export/,
      );
      assert.equal(existsSync(other), false);
    });
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
    await readOnly.end();
    await owner.end();
  }
});
