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
import { mkdtempSync, rmSync } from "node:fs";
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
import { databaseConsistentRead } from "../src/services/competition/consistent-read";
import { sql } from "drizzle-orm";
import { snapshotSource } from "../src/services/competition/snapshot-store";
import { snapshotsEqual } from "../src/services/competition/snapshot-format";
import { LEVEL_IDS } from "../src/services/players/levels";
import { playerProfile } from "../src/services/afl/read-model";
import { playerAnalyticsView } from "../src/analytics/views";
import { trendRiserLists } from "../src/services/competition/prepare";
import { MOMENTUM_WINDOW_IDS } from "../src/analytics/config";
import { mockMlbFetch, syntheticMlb } from "./mlb-test-support";

/** Path and values of the first difference between two JSON-like values (for failure messages). */
function firstDiff(a: unknown, b: unknown, p = "$"): string | null {
  if (Object.is(a, b)) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return `${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${p}.${k}`);
    if (d) return d;
  }
  return null;
}

/**
 * Same data regardless of row order. The loaders return players, games and teams in the database's
 * physical order (no ORDER BY), which an UPDATE changes, so two loads of identical data can list
 * them in a different order. Within one export the order is whatever that read returned.
 */
function sameData(a: unknown, b: unknown) {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm).map((x) => JSON.stringify(x)).sort();
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, norm(x)]));
    return v;
  };
  return firstDiff(norm(a), norm(b));
}

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
      const report = await exportSnapshots({ dir, season: 2026, read: databaseConsistentRead(db, 2026) });
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

    // A player of the AFL level (read LAST by the export) and the AFL capture used for replays.
    const aflBefore = (await load("afl"))!;
    const target = aflBefore.players[0];
    /** A real ingestion apply of an upstream correction (one player's listed weight changes). */
    const replayAflCorrection = (at: string) => {
      const data = syntheticMlb();
      const person = data.people.people[0]!;
      person.weight = (person.weight ?? 180) + 5;
      return ingest(new MLBStatsApiSource({ season: 2026 }, { fetcher: mockMlbFetch(data).fetcher, sleep: async () => {}, clock: () => new Date(at) }), sink);
    };

    await t.test("why one transaction: separate per-level reads mix states, and a version check misses it", async () => {
      // The old procedure: version, then each level in its own transaction, then version again.
      const v1 = await loadIngestionVersion(db);
      const aaa = await load("aaa");
      await owner.query("update players set name = name || ' [corrected]' where id = $1", [target.id]);
      const afl = (await load("afl"))!;
      const v2 = await loadIngestionVersion(db);
      assert.ok(aaa);
      assert.equal(afl.players.find((p) => p.id === target.id)!.name, `${target.name} [corrected]`, "AFL read after the commit");
      assert.equal(v1, v2, "a direct correction leaves the ingestion version unchanged: the old check could not see it");
      await owner.query("update players set name = $2 where id = $1", [target.id, target.name]);
    });

    await t.test("commits during the export (a correction and a real ingestion apply) are invisible to it", async () => {
      const other = path.join(path.dirname(dir), "concurrent");
      const versionAtStart = await loadIngestionVersion(db);
      const runsAtStart = (await counts()).runs;
      const consistent = databaseConsistentRead(db, 2026);
      let committed = false;
      const report = await exportSnapshots({
        dir: other,
        season: 2026,
        read: (work) =>
          consistent((reader) =>
            work({
              ...reader,
              load: async (level) => {
                const snapshot = await reader.load(level);
                if (level === LEVEL_IDS[0]) {
                  // After the first level, while the export's transaction is open: two commits on
                  // other connections. Readers never block writers, so both complete now.
                  // (The ingestion apply first: it rewrites players from the source, so a manual
                  // correction made before it would be replaced.)
                  const r = await replayAflCorrection("2026-10-28T12:00:00Z");
                  assert.ok(r.status === "applied" || r.status === "applied-with-quarantine", r.status);
                  await owner.query("update players set name = name || ' [corrected]' where id = $1", [target.id]);
                  committed = true;
                }
                return snapshot;
              },
            }),
          ),
      });
      assert.ok(committed);
      // The database moved on...
      assert.ok(Number((await counts()).runs) > Number(runsAtStart), "the concurrent ingestion run committed");
      assert.notEqual(await loadIngestionVersion(db), versionAtStart);
      assert.equal((await load("afl"))!.players.find((p) => p.id === target.id)!.name, `${target.name} [corrected]`);
      // ...but the snapshot is exactly the state at the export's start, with that state's version.
      assert.equal(report.ingestionVersion, versionAtStart);
      const exported = (await snapshotSource(other, 2026).load("afl"))!;
      assert.equal(exported.players.find((p) => p.id === target.id)!.name, target.name);
      assert.equal(sameData(exported, aflBefore), null, "AFL level: exactly the pre-commit data");
      for (const level of LEVEL_IDS)
        assert.equal(sameData(await snapshotSource(other, 2026).load(level), await snapshotSource(dir, 2026).load(level)), null, `${level}: same data as the first export`);

      // A new export sees the new state, consistently.
      const after = await exportSnapshots({ dir: other, season: 2026, read: databaseConsistentRead(db, 2026) });
      assert.equal(after.ingestionVersion, await loadIngestionVersion(db));
      assert.equal((await snapshotSource(other, 2026).load("afl"))!.players.find((p) => p.id === target.id)!.name, `${target.name} [corrected]`);
      await owner.query("update players set name = $2 where id = $1", [target.id, target.name]);
    });

    await t.test("the export transaction really is READ ONLY, REPEATABLE READ, with nested loaders as savepoints", async () => {
      const writable = drizzle(owner, { schema });
      // READ ONLY: a write is rejected even on a role that could write.
      await assert.rejects(
        writable.transaction(
          async (tx) => {
            await tx.execute(sql`update players set name = name`);
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        ),
        // Drizzle wraps the PostgreSQL error; the server's message is the cause.
        (e: unknown) => /read-only transaction/.test(String((e as { cause?: Error }).cause?.message ?? e)),
      );
      // The same pattern the reader uses: a level loaded inside an outer RR transaction sees the
      // outer snapshot, not a commit that happens between the outer start and the nested load.
      const seen = await writable.transaction(
        async (tx) => {
          await tx.execute(sql`select 1`); // snapshot taken here
          await owner.query("update players set name = name || ' [later]' where id = $1", [target.id]);
          const afl = (await dbLevelLoader(tx as unknown as typeof db, 2026)("afl"))!;
          return afl.players.find((p) => p.id === target.id)!.name;
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
      assert.equal(seen, target.name);
      await owner.query("update players set name = $2 where id = $1", [target.id, target.name]);
    });

    await t.test("export as a session that cannot write leaves every table count unchanged", async () => {
      const now = await counts();
      await exportSnapshots({ dir: path.join(path.dirname(dir), "again"), season: 2026, read: databaseConsistentRead(db, 2026) });
      assert.deepEqual(await counts(), now);
    });
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
    await readOnly.end();
    await owner.end();
  }
});
