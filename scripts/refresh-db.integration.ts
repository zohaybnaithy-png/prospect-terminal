import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { DEFAULT_REFRESH, runRefreshJob, type RefreshOptions } from "../src/ingestion/refresh/job";
import { PgJobLock, JOB_LOCK_NAME, lockHolderAgeMs } from "../src/ingestion/refresh/lock";
import { assessFreshness, lastStructureAppliedAt, readFreshnessFacts, recoverAbandonedRuns } from "../src/ingestion/refresh/freshness";
import { pipelineSteps } from "../src/ingestion/refresh/steps";
import { setProgressReporter } from "../src/ingestion/progress";
import { buildMilbFixture, FIXTURE_IDS, milbFixtureFetch } from "../src/ingestion/fixtures/milb-synthetic";

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
    assert.ok(f.levels.filter((l) => l.level !== "afl").every((l) => l.lastSuccessAt === null && l.verdict === "no-data"));
    assert.ok(f.reasons.includes("aaa: in season but no complete game stored"));
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
    assert.ok(f.levels.filter((l) => l.level !== "afl").every((l) => l.lastSuccessAt !== null), "each MiLB level has its own success");
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

  await t.test("lock contention: a real holder is reported with its age; too long → locked-stale", async () => {
    const holder = new PgJobLock(url);
    assert.equal(await holder.acquire(), true);
    await new Promise((r) => setTimeout(r, 1200));
    const age = await lockHolderAgeMs((sql) => pool.query(sql));
    assert.ok(age !== null && age >= 1000, `holder age ${age}`);
    const run = (maxLockHoldMs: number) =>
      runRefreshJob({ ...options, maxLockHoldMs }, {
        lock: new PgJobLock(url),
        steps: pipelineSteps({ url, season: 2026, apply: true, fetcher: milbFixtureFetch().fetcher, sleep: async () => {}, clock: () => NOW }),
        lastStructureAppliedAt: () => lastStructureAppliedAt(pool, 2026),
        recoverAbandoned: (ms) => recoverAbandonedRuns(pool, ms),
        lockHolderAgeMs: () => lockHolderAgeMs((sql) => pool.query(sql)),
        clock: () => NOW,
      });
    assert.equal((await run(DEFAULT_REFRESH.maxLockHoldMs)).status, "locked", "normal overlap");
    const stale = await run(500);
    assert.equal(stale.status, "locked-stale");
    assert.ok((stale.lockHeldForMinutes ?? -1) >= 0);
    await holder.release();
  });

  await t.test("lock connection lost during an active ingestion: aborted, nothing partial applied, next run completes", async () => {
    // A real change in the source (a Double-A game inside the incremental window): one more hit.
    const data = buildMilbFixture();
    const box = data.boxes[FIXTURE_IDS.games.aaLate] as { teams: { home: { players: Record<string, { stats: { batting: { hits: number } } }> } } };
    box.teams.home.players[`ID${FIXTURE_IDS.players.aa2Bat}`].stats.batting.hits = 3;
    const hitsInDb = async () =>
      one(
        `SELECT b.hits FROM player_batting_games b
         JOIN source_identities sp ON sp.internal_id = b.player_id AND sp.entity_kind = 'player' AND sp.external_id = $1
         JOIN source_identities sg ON sg.internal_id = b.game_id AND sg.entity_kind = 'game' AND sg.external_id = $2`,
        [String(FIXTURE_IDS.players.aa2Bat), String(FIXTURE_IDS.games.aaLate)],
      );
    assert.equal(await hitsInDb(), 2, "before: the stored value");
    const later = new Date(NOW.getTime() + 3_600_000); // a newer capture than the stored one
    const mock = milbFixtureFetch(data);
    const lock = new PgJobLock(url);
    let requests = 0, terminated = false;
    const fetcher: typeof fetch = async (input, init) => {
      requests++;
      if (requests === 3 && !terminated) {
        terminated = true;
        // The lock's session dies while the capture is being fetched (as if the network dropped).
        await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'pt-ingestion-job-lock'`);
        for (let i = 0; i < 100 && !lock.lostSignal.aborted; i++) await new Promise((r) => setTimeout(r, 10));
      }
      return mock.fetcher(input, init);
    };
    const runsBefore = await one("SELECT count(*) FROM ingestion_runs");
    const r = await runRefreshJob({ ...options, structureMaxAgeHours: 1e6 }, {
      lock,
      steps: pipelineSteps({ url, season: 2026, apply: true, fetcher, sleep: async () => {}, clock: () => later }),
      lastStructureAppliedAt: () => lastStructureAppliedAt(pool, 2026),
      recoverAbandoned: (ms) => recoverAbandonedRuns(pool, ms),
      lockLost: lock.lostSignal,
      clock: () => later,
      sleep: async () => {},
    });
    assert.ok(terminated);
    assert.equal(r.status, "aborted", JSON.stringify(r));
    assert.equal(r.abortReason, "lock-lost");
    assert.equal(await one("SELECT count(*) FROM ingestion_runs WHERE status = 'running'"), 0, "no capture left running");
    assert.equal(await hitsInDb(), 2, "the in-flight capture was not applied (no partial write)");
    const interrupted = await one(`SELECT count(*) FROM ingestion_runs WHERE error_code = 'interrupted'`);
    assert.ok(interrupted >= 1 || (await one("SELECT count(*) FROM ingestion_runs")) === runsBefore, "the capture stopped before or at its apply, recorded as interrupted");
    assert.equal(await heldLocks(), 0);
    // The next run applies the whole change.
    const next = await runRefreshJob({ ...options, structureMaxAgeHours: 1e6 }, {
      lock: new PgJobLock(url),
      steps: pipelineSteps({ url, season: 2026, apply: true, fetcher: milbFixtureFetch(data).fetcher, sleep: async () => {}, clock: () => later }),
      lastStructureAppliedAt: () => lastStructureAppliedAt(pool, 2026),
      recoverAbandoned: (ms) => recoverAbandonedRuns(pool, ms),
      clock: () => later,
      sleep: async () => {},
    });
    assert.ok(next.status === "ok" || next.status === "ok-with-quarantine", JSON.stringify(next.steps));
    assert.equal(await hitsInDb(), 3, "after: the change is applied in full");
  });

  await t.test("lock lost INSIDE the apply transaction: the whole capture rolls back, recorded as interrupted", async () => {
    // Another real change (one more walk for the same line), applied by a newer capture.
    const data = buildMilbFixture();
    const box = data.boxes[FIXTURE_IDS.games.aaLate] as { teams: { home: { players: Record<string, { stats: { batting: { hits: number; baseOnBalls: number; plateAppearances: number } } }> } } };
    const line = box.teams.home.players[`ID${FIXTURE_IDS.players.aa2Bat}`].stats.batting;
    line.hits = 3;
    line.baseOnBalls = 2;
    line.plateAppearances = 5;
    const walks = () =>
      one(
        `SELECT b.walks FROM player_batting_games b
         JOIN source_identities sp ON sp.internal_id = b.player_id AND sp.entity_kind = 'player' AND sp.external_id = $1
         JOIN source_identities sg ON sg.internal_id = b.game_id AND sg.entity_kind = 'game' AND sg.external_id = $2`,
        [String(FIXTURE_IDS.players.aa2Bat), String(FIXTURE_IDS.games.aaLate)],
      );
    assert.equal(await walks(), 1);
    const later = new Date(NOW.getTime() + 2 * 3_600_000);
    const lost = new AbortController();
    // Lose the lock at the exact moment the apply transaction has taken its source lock.
    setProgressReporter((event) => {
      if (event === "apply:lock-acquired" && !lost.signal.aborted) lost.abort(new Error("ingestion job lock connection lost"));
    });
    t.after(() => setProgressReporter(() => {}));
    const r = await runRefreshJob({ ...options, structureMaxAgeHours: 1e6 }, {
      lock: { acquire: async () => true, release: async () => {} },
      steps: pipelineSteps({ url, season: 2026, apply: true, fetcher: milbFixtureFetch(data).fetcher, sleep: async () => {}, clock: () => later }),
      lastStructureAppliedAt: () => lastStructureAppliedAt(pool, 2026),
      recoverAbandoned: (ms) => recoverAbandonedRuns(pool, ms),
      lockLost: lost.signal,
      clock: () => later,
      sleep: async () => {},
    });
    setProgressReporter(() => {});
    assert.equal(r.status, "aborted");
    assert.equal(r.abortReason, "lock-lost");
    assert.equal(await walks(), 1, "rolled back: nothing of the capture was written");
    assert.ok((await one(`SELECT count(*) FROM ingestion_runs WHERE status = 'failed' AND error_code = 'interrupted'`)) >= 1, "the capture is recorded as interrupted");
    assert.equal(await one("SELECT count(*) FROM ingestion_runs WHERE status = 'running'"), 0);
  });
});
