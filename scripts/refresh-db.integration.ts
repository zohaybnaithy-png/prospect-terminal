import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { DEFAULT_REFRESH, runRefreshJob, type RefreshOptions } from "../src/ingestion/refresh/job";
import { PgJobLock, JOB_LOCK_NAME } from "../src/ingestion/refresh/lock";
import { assessFreshness, lastStructureAppliedAt, readFreshnessFacts, recoverAbandonedRuns } from "../src/ingestion/refresh/freshness";
import { pipelineSteps } from "../src/ingestion/refresh/steps";
import { milbFixtureFetch } from "../src/ingestion/fixtures/milb-synthetic";

/**
 * The scheduled refresh against a fresh, migrated, DISPOSABLE PostgreSQL database populated only by
 * the clearly fictional MiLB fixture (served by a mock fetch; no network). Never point this at Neon
 * or production:
 *   createdb prospect_refresh_test && DATABASE_URL=… npm run db:migrate
 *   REFRESH_TEST_DATABASE_URL=postgres://…/prospect_refresh_test npm run test:refresh:db
 */
const NOW = new Date("2026-05-15T12:00:00Z"); // in season; fixture games run 2026-04-20 … 2026-05-12

test("scheduled refresh against PostgreSQL", async (t) => {
  const url = process.env.REFRESH_TEST_DATABASE_URL;
  if (!url || new URL(url).pathname !== "/prospect_refresh_test")
    throw new Error("Use a fresh migrated prospect_refresh_test database via REFRESH_TEST_DATABASE_URL");
  const pool = new Pool({ connectionString: url, max: 3 });
  t.after(() => pool.end());
  const one = async (q: string, v: unknown[] = []) => Number(Object.values((await pool.query(q, v)).rows[0])[0]);
  const runs = () => one("SELECT count(*) FROM ingestion_runs");
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        ["players", "games", "teams", "player_batting_games", "player_pitching_games", "source_identities"].map(async (tbl) => [tbl, await one(`SELECT count(*) FROM ${tbl}`)]),
      ),
    );
  assert.equal(await runs(), 0, "start from an empty, migrated database");

  const options: RefreshOptions = { season: 2026, sources: ["milb"], apply: true, force: false, ...DEFAULT_REFRESH, retryDelaysMs: [10] };
  const job = (fetcher: typeof fetch, lock = new PgJobLock(url), onRetryWait: () => void = () => {}) =>
    runRefreshJob(options, {
      lock,
      steps: pipelineSteps({ url, season: 2026, apply: true, fetcher, sleep: async () => {}, clock: () => NOW }),
      lastStructureAppliedAt: () => lastStructureAppliedAt(pool, 2026),
      recoverAbandoned: (ms) => recoverAbandonedRuns(pool, ms),
      clock: () => NOW,
      sleep: async () => onRetryWait(),
      lockLost: lock.lostSignal,
    });
  const facts = async () => assessFreshness(await readFreshnessFacts(pool, { season: 2026, now: NOW, abandonedAfterMs: DEFAULT_REFRESH.abandonedAfterMs }));
  const heldLocks = () => one("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted");

  await t.test("before any job: stale, no successful capture", async () => {
    const f = await facts();
    assert.equal(f.verdict, "stale");
    assert.equal(f.lastSuccess, null);
    assert.ok(f.reasons.includes("no successful capture recorded"));
  });

  let afterFirst: Record<string, number> = {};
  await t.test("first job: structure + incremental games applied, lock released", async () => {
    const r = await job(milbFixtureFetch().fetcher);
    assert.notEqual(r.status, "failed", JSON.stringify(r.steps));
    assert.deepEqual(r.steps.map((s) => [s.step, s.status === "ok" || s.status === "ok-with-quarantine"]), [["milb-structure", true], ["milb-games", true], ["afl", false]]);
    assert.equal(r.steps[2].reason, "not selected");
    assert.ok(await one("SELECT count(*) FROM ingestion_runs WHERE status IN ('applied','applied-with-quarantine')") >= 2);
    assert.equal(await heldLocks(), 0, "job lock released");
    afterFirst = await counts();
    assert.ok(afterFirst.player_batting_games > 0 && afterFirst.games > 0);
  });

  await t.test("freshness reflects what is stored, per level", async () => {
    const f = await facts();
    assert.equal(f.lastSuccess?.status === "applied" || f.lastSuccess?.status === "applied-with-quarantine", true);
    assert.equal(f.levels.find((l) => l.level === "aa")?.latestGame, "2026-05-12");
    assert.equal(f.levels.find((l) => l.level === "aa")?.verdict, "fresh");
    // The fixture's High-A/Single-A games are on 2026-05-01: two weeks old in season = stale.
    assert.equal(f.levels.find((l) => l.level === "high-a")?.verdict, "stale");
    assert.equal(f.levels.find((l) => l.level === "afl")?.verdict, "off-season");
    assert.equal(f.verdict, "stale");
  });

  await t.test("second job: structure skipped (recent), games re-captured without changing anything", async () => {
    const before = await runs();
    const r = await job(milbFixtureFetch().fetcher);
    assert.equal(r.steps[0].status, "skipped");
    assert.equal(r.steps[0].reason, "structure-recent");
    assert.equal(r.steps[1].detail?.changed, 0, "idempotent: nothing reprocessed into a change");
    assert.ok((await runs()) > before, "each capture is still recorded");
    assert.deepEqual(await counts(), afterFirst);
  });

  await t.test("overlap: while another holder has the lock, a job runs nothing", async () => {
    const holder = new PgJobLock(url);
    assert.equal(await holder.acquire(), true);
    const before = await runs();
    const fetched: string[] = [];
    const r = await job(async (input) => {
      fetched.push(String(input));
      return milbFixtureFetch().fetcher(input);
    });
    assert.equal(r.status, "locked");
    assert.equal(await runs(), before, "no capture recorded");
    assert.deepEqual(fetched, [], "no API requests");
    await holder.release();
    assert.equal(await heldLocks(), 0);
  });

  await t.test("a crashed holder's lock is released by the server", async () => {
    const a = new PgJobLock(url);
    assert.equal(await a.acquire(), true);
    assert.equal(await new PgJobLock(url).acquire(), false);
    // Simulate the process dying: the server ends its session.
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'pt-ingestion-job-lock' AND pid <> pg_backend_pid()`,
    );
    for (let i = 0; i < 50 && !a.lostSignal.aborted; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(a.lostSignal.aborted, true, "the holder learns its lock is gone");
    const b = new PgJobLock(url);
    assert.equal(await b.acquire(), true);
    await b.release();
    await a.release().catch(() => {});
    assert.equal(JOB_LOCK_NAME, "prospect-terminal:ingestion-job");
  });

  await t.test("a dead process's 'running' capture is reported, then recovered as abandoned", async () => {
    const snapshot = (await pool.query("SELECT id FROM source_snapshots LIMIT 1")).rows[0].id;
    const { rows } = await pool.query(
      `INSERT INTO ingestion_runs (provider, adapter_version, snapshot_id, status, created_at)
       VALUES ('mlb-stats-api', 'test', $1, 'running', $2) RETURNING id`,
      [snapshot, new Date(Date.now() - 3 * 3_600_000)],
    );
    const fresh = await pool.query(
      `INSERT INTO ingestion_runs (provider, adapter_version, snapshot_id, status) VALUES ('mlb-stats-api', 'test', $1, 'running') RETURNING id`,
      [snapshot],
    );
    // readFreshnessFacts compares against the real clock for stuck rows.
    const stuck = assessFreshness(await readFreshnessFacts(pool, { season: 2026, now: new Date(), abandonedAfterMs: DEFAULT_REFRESH.abandonedAfterMs }));
    assert.equal(stuck.stuckRunning.length, 1, "only the old one is stuck");
    const r = await job(milbFixtureFetch().fetcher);
    assert.equal(r.recoveredAbandonedRuns, 1);
    const row = (await pool.query("SELECT status, error_code, completed_at FROM ingestion_runs WHERE id = $1", [rows[0].id])).rows[0];
    assert.deepEqual([row.status, row.error_code, row.completed_at !== null], ["failed", "abandoned", true]);
    assert.equal((await pool.query("SELECT status FROM ingestion_runs WHERE id = $1", [fresh.rows[0].id])).rows[0].status, "running", "a recent run is left alone");
    await pool.query("DELETE FROM ingestion_runs WHERE id = $1", [fresh.rows[0].id]);
  });

  await t.test("API outage: the capture fails, is retried, and succeeds; data stays identical", async () => {
    const before = await counts();
    // The API is down for the whole first attempt (every request and each of its 3 transport
    // retries fails; requests run 4 at a time, so a few isolated failures would just be absorbed
    // by the transport) and back by the time the job's retry wait is over.
    let outage = true, failedCalls = 0;
    const mock = milbFixtureFetch();
    const flaky: typeof fetch = async (input, init) => {
      if (outage) {
        failedCalls++;
        throw new TypeError("fetch failed");
      }
      return mock.fetcher(input, init);
    };
    const r = await job(flaky, new PgJobLock(url), () => (outage = false));
    assert.ok(failedCalls >= 3, `${failedCalls} failed calls`);
    const games = r.steps.find((s) => s.step === "milb-games")!;
    assert.equal(games.attempts, 2, JSON.stringify(games));
    assert.ok(games.status === "ok" || games.status === "ok-with-quarantine");
    assert.equal(await one("SELECT count(*) FROM ingestion_runs WHERE status = 'running'"), 0, "no capture left running");
    assert.deepEqual(await counts(), before, "the failed attempt wrote nothing; the retry changed nothing");
  });

  await t.test("a persistent outage ends as failed after maxAttempts, recorded for operators", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const r = await job(down);
    const games = r.steps.find((s) => s.step === "milb-games")!;
    assert.equal(r.status, "failed");
    assert.equal(games.status, "failed");
    assert.equal(games.attempts, DEFAULT_REFRESH.maxAttempts);
    assert.match(games.error ?? "", /transport failed|fetch failed/i);
    assert.equal(await heldLocks(), 0, "lock released after failure");
  });
});
