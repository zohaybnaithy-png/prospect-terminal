import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { PostgresIngestionSink } from "../src/ingestion/postgres-sink";
import { runMilbIngestion } from "../src/ingestion/milb-runner";
import { parseMilbArgs } from "../src/ingestion/cli-options";
import { milbFixtureFetch } from "../src/ingestion/fixtures/milb-synthetic";
import { DEFAULT_REFRESH } from "../src/ingestion/refresh/job";
import { assessFreshness, readFreshnessFacts } from "../src/ingestion/refresh/freshness";

/**
 * Freshness must judge each level by ITS OWN successful captures (same source, same season), never
 * by an unrelated AFL or previous-season success. DISPOSABLE database only:
 *   REFRESH_FRESHNESS_TEST_DATABASE_URL=postgres://…/prospect_freshness_test npm run test:refresh:db
 */
test("freshness is evaluated per season, source and level", async (t) => {
  const url = process.env.REFRESH_FRESHNESS_TEST_DATABASE_URL;
  if (!url || new URL(url).pathname !== "/prospect_freshness_test")
    throw new Error("Use a fresh migrated prospect_freshness_test database via REFRESH_FRESHNESS_TEST_DATABASE_URL");
  const pool = new Pool({ connectionString: url, max: 2 });
  t.after(() => pool.end());
  // Real MiLB 2026 data (fixture games 2026-04-20 … 2026-05-12) through the real pipeline.
  const sink = new PostgresIngestionSink(url);
  const clock = () => new Date("2026-05-13T12:00:00Z");
  const s = await runMilbIngestion(parseMilbArgs(["--season=2026", "--apply"]), { sink, fetcher: milbFixtureFetch().fetcher, sleep: async () => {}, clock });
  await sink.close();
  assert.notEqual(s.status, "failed");
  // Those captures succeeded 2.5 days before the check (stale: > 36 h).
  await pool.query(`UPDATE ingestion_runs SET completed_at = '2026-05-11T06:00:00Z', created_at = '2026-05-11T05:59:00Z'`);
  // Unrelated recent successes: an AFL 2026 capture and a MiLB 2025 capture, 6 h before the check.
  const snap = async (key: string) =>
    (await pool.query(
      `INSERT INTO source_snapshots (provider, snapshot_key, content_hash, observed_at, fetched_at, payload, source_url)
       VALUES ('mlb-stats-api', $1, md5($1), '2026-05-13T12:00:00Z', '2026-05-13T12:00:00Z', '{}', 'test') RETURNING id`, [key])).rows[0].id;
  for (const key of ["afl:2026:all:season:end:all", "milb:2025:aa+aaa+high-a+single-a:games:2025-09-01:2025-09-07:all-leagues:all-teams"])
    await pool.query(
      `INSERT INTO ingestion_runs (provider, adapter_version, snapshot_id, status, created_at, completed_at)
       VALUES ('mlb-stats-api', 'test', $1, 'applied', '2026-05-13T11:59:00Z', '2026-05-13T12:00:00Z')`, [await snap(key)]);
  const now = new Date("2026-05-13T18:00:00Z");
  const report = assessFreshness(await readFreshnessFacts(pool, { season: 2026, now, abandonedAfterMs: DEFAULT_REFRESH.abandonedAfterMs }));
  // Double-A's latest game (2026-05-12) is only 1 day old, so its game age looks fine: only its own
  // capture age (2.5 days) shows it is behind. An unrelated recent success must not hide that.
  assert.equal(report.levels.find((x) => x.level === "aa")!.verdict, "stale", JSON.stringify(report.levels));
  assert.equal(report.verdict, "stale", JSON.stringify(report.reasons));
  for (const level of ["aaa", "aa", "high-a", "single-a"] as const) {
    const l = report.levels.find((x) => x.level === level)!;
    assert.equal(l.lastSuccessAt, "2026-05-11T06:00:00.000Z", `${level}: its own last success`);
    assert.equal(l.verdict, "stale", `${level} must be stale`);
  }
});
