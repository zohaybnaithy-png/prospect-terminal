/**
 * Pre-merge remediation of PR #13 (each test written to reproduce the problem before the fix).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pinged: { url: string; body: string }[] = [];
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  pinged.push({ url: String(url), body: String(init?.body ?? "") });
  return new Response("ok");
}) as typeof fetch;

describe("fatal errors trigger the failure notification", () => {
  for (const c of [
    { name: "missing INGESTION_DATABASE_URL", env: {}, argv: ["--apply"] },
    { name: "invalid arguments", env: { INGESTION_DATABASE_URL: "postgres://x@127.0.0.1:1/none" }, argv: ["--apply", "--sources=nba"] },
    { name: "database unreachable (lock acquisition)", env: { INGESTION_DATABASE_URL: "postgres://postgres@127.0.0.1:1/none" }, argv: ["--apply", "--force"] },
  ])
    test(c.name, async () => {
      const { runRefreshCli } = await import("./refresh-data");
      pinged.length = 0;
      const logDir = mkdtempSync(join(tmpdir(), "pt-refresh-"));
      const code = await runRefreshCli([...c.argv, `--log-dir=${logDir}`], { ...c.env, PT_REFRESH_PING_URL: "https://hc.example/ping/abc" }, { fetch: fakeFetch, quiet: true });
      assert.equal(code, 1);
      assert.equal(pinged.length, 1, "exactly one notification");
      assert.equal(pinged[0].url, "https://hc.example/ping/abc/fail");
      assert.match(pinged[0].body, /"status":"error"/);
      assert.doesNotMatch(pinged[0].body, /postgres:\/\/|127\.0\.0\.1:1/, "no connection details in the notification");
      const last = JSON.parse(readFileSync(join(logDir, "last-job.json"), "utf8"));
      assert.equal(last.status, "error");
    });
});

describe("lock contention: normal overlap vs a stuck holder", () => {
  test("held briefly → locked (exit 0, no ping); held longer than maxLockHoldMs → locked-stale (exit 1, fail ping)", async () => {
    const { runRefreshJob, DEFAULT_REFRESH, jobExitCode, pingKind } = await import("../src/ingestion/refresh/job");
    const run = (ageMs: number | null) =>
      runRefreshJob(
        { season: 2026, sources: ["milb"], apply: true, force: true, ...DEFAULT_REFRESH },
        {
          lock: { acquire: async () => false, release: async () => {} },
          steps: { "milb-structure": async () => ({ status: "ok" }), "milb-games": async () => ({ status: "ok" }), afl: async () => ({ status: "ok" }) },
          lastStructureAppliedAt: async () => null,
          recoverAbandoned: async () => 0,
          lockHolderAgeMs: async () => ageMs,
        },
      );
    const normal = await run(10 * 60_000);
    assert.deepEqual([normal.status, normal.lockHeldForMinutes, jobExitCode(normal), pingKind(normal)], ["locked", 10, 0, null]);
    const stuck = await run(DEFAULT_REFRESH.maxLockHoldMs + 60_000);
    assert.deepEqual([stuck.status, stuck.lockHeldForMinutes, jobExitCode(stuck), pingKind(stuck)], ["locked-stale", 121, 1, "fail"]);
    const unknown = await run(null);
    assert.equal(unknown.status, "locked", "holder age unknown: treated as normal overlap (the dead-man's switch still catches a stuck lock)");
  });
});

describe("releasing a lock whose connection was lost", () => {
  test("never throws (found by the lost-lock integration test)", async () => {
    const { PgJobLock } = await import("../src/ingestion/refresh/lock");
    const lock = new PgJobLock("postgres://unused@127.0.0.1:1/none");
    const dead = { query: async () => { throw new Error("Client has encountered a connection error and is not queryable"); }, end: async () => { throw new Error("already ended"); } };
    (lock as unknown as { client: unknown }).client = dead;
    (lock as unknown as { lost: AbortController }).lost.abort(new Error("lost"));
    await lock.release(); // must resolve
    const fresh = new PgJobLock("postgres://unused@127.0.0.1:1/none");
    (fresh as unknown as { client: unknown }).client = dead;
    await fresh.release();
  });
});

describe("season windows can be configured (an unusual season start/end)", () => {
  test("PT_SEASON_WINDOWS overrides the defaults for both the job and freshness; invalid values are rejected", async () => {
    const { seasonWindowsFromEnv, ACTIVE_WINDOWS, shouldRefresh, isActive } = await import("../src/ingestion/refresh/schedule");
    const w = seasonWindowsFromEnv({ PT_SEASON_WINDOWS: "milb=03-20..10-05,afl=10-03..11-25" });
    assert.deepEqual(w, { milb: { from: "03-20", to: "10-05" }, afl: { from: "10-03", to: "11-25" } });
    assert.equal(isActive("milb", "2026-03-25", w), true);
    assert.equal(isActive("milb", "2026-03-25"), false, "default window");
    assert.equal(shouldRefresh("afl", "2026-12-04", w), true, "grace after the configured end");
    assert.deepEqual(seasonWindowsFromEnv({}), ACTIVE_WINDOWS);
    assert.deepEqual(seasonWindowsFromEnv({ PT_SEASON_WINDOWS: "milb=05-01..09-01" }), { ...ACTIVE_WINDOWS, milb: { from: "05-01", to: "09-01" } });
    for (const bad of ["milb=04-31..09-30", "milb=09-30..04-01", "nba=04-01..09-30", "milb=4-1..9-30", "milb"])
      assert.throws(() => seasonWindowsFromEnv({ PT_SEASON_WINDOWS: bad }), /PT_SEASON_WINDOWS/, bad);
    const { planSteps, DEFAULT_REFRESH } = await import("../src/ingestion/refresh/job");
    const plan = planSteps({ sources: ["milb"], force: false, structureMaxAgeHours: 20, windows: w } as never, "2026-03-25", null, new Date("2026-03-25T10:00:00Z"));
    assert.equal(plan[1].run, true, "the job follows the configured window");
    assert.ok(DEFAULT_REFRESH);
  });
});
