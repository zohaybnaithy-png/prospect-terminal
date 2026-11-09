/**
 * Phase 5C: scheduled refresh orchestration and freshness (no database, no network). The same
 * code against a disposable PostgreSQL with the synthetic fixtures: scripts/refresh-db.integration.ts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isActive, shouldRefresh } from "../src/ingestion/refresh/schedule";
import { DEFAULT_REFRESH, isPermanentError, jobExitCode, planSteps, runRefreshJob, type JobLock, type RefreshDeps, type RefreshOptions, type StepName, type StepOutcome } from "../src/ingestion/refresh/job";
import { assessFreshness, freshnessExitCode, type FreshnessFacts } from "../src/ingestion/refresh/freshness";
import { directConnectionString } from "../src/ingestion/refresh/lock";
import { aflOutcome, milbOutcome } from "../src/ingestion/refresh/steps";
import { parseRefreshArgs } from "./refresh-data";
import type { MilbRunSummary } from "../src/ingestion/milb-runner";
import type { IngestionReport } from "../src/ingestion/runner";

const ROOT = new URL("..", import.meta.url).pathname;
const IN_SEASON = new Date("2026-06-15T09:00:00Z");
const opts = (o: Partial<RefreshOptions> = {}): RefreshOptions => ({ season: 2026, sources: ["milb", "afl"], apply: true, force: false, ...DEFAULT_REFRESH, ...o });

class FakeLock implements JobLock {
  held = false;
  acquired = 0;
  released = 0;
  constructor(private readonly available = true) {}
  async acquire() {
    if (!this.available || this.held) return false;
    this.held = true;
    this.acquired++;
    return true;
  }
  async release() {
    this.held = false;
    this.released++;
  }
}

function deps(over: Partial<RefreshDeps> & { outcomes?: Partial<Record<StepName, (StepOutcome | Error)[]>> } = {}) {
  const calls: StepName[] = [];
  const waits: number[] = [];
  const queue = { ...over.outcomes };
  const step = (name: StepName) => async () => {
    calls.push(name);
    const next = queue[name]?.shift();
    if (next instanceof Error) throw next;
    return next ?? { status: "ok" as const };
  };
  const lock = (over.lock as FakeLock) ?? new FakeLock();
  const d: RefreshDeps = {
    lock,
    steps: { "milb-structure": step("milb-structure"), "milb-games": step("milb-games"), afl: step("afl") },
    lastStructureAppliedAt: async () => null,
    recoverAbandoned: async () => 0,
    clock: () => IN_SEASON,
    sleep: async (ms) => {
      waits.push(ms);
    },
    random: () => 0,
    ...over,
  };
  return { d, calls, waits, lock };
}

describe("season windows", () => {
  test("MiLB April–September, AFL October–November 20, plus a grace period for the job", () => {
    assert.equal(isActive("milb", "2026-03-31"), false);
    assert.equal(isActive("milb", "2026-04-01"), true);
    assert.equal(isActive("milb", "2026-09-30"), true);
    assert.equal(isActive("milb", "2026-10-01"), false);
    assert.equal(shouldRefresh("milb", "2026-10-10"), true, "grace for late corrections");
    assert.equal(shouldRefresh("milb", "2026-10-11"), false);
    assert.equal(isActive("afl", "2026-10-01"), true);
    assert.equal(isActive("afl", "2026-11-21"), false);
    assert.equal(shouldRefresh("afl", "2026-11-30"), true);
    assert.equal(shouldRefresh("afl", "2026-12-01"), false);
    assert.equal(isActive("milb", "2028-02-29"), false, "leap day");
  });

  test("planSteps: off-season, forced, unselected and recent structure", () => {
    const winter = new Date("2026-12-15T00:00:00Z");
    assert.deepEqual(planSteps(opts(), "2026-12-15", null, winter).map((p) => [p.step, p.run, p.reason]), [
      ["milb-structure", false, "off-season"],
      ["milb-games", false, "off-season"],
      ["afl", false, "off-season"],
    ]);
    assert.ok(planSteps(opts({ force: true }), "2026-12-15", null, winter).every((p) => p.run));
    const summer = planSteps(opts({ sources: ["milb"] }), "2026-06-15", new Date("2026-06-15T00:00:00Z"), IN_SEASON);
    assert.deepEqual(summer.map((p) => [p.step, p.run, p.reason]), [
      ["milb-structure", false, "structure-recent"],
      ["milb-games", true, undefined],
      ["afl", false, "not selected"],
    ]);
    const stale = planSteps(opts({ sources: ["milb"] }), "2026-06-15", new Date("2026-06-14T00:00:00Z"), IN_SEASON);
    assert.equal(stale[0].run, true, "structure older than 20 h runs again");
  });
});

describe("refresh job", () => {
  test("runs the due steps in order under the lock and releases it", async () => {
    const { d, calls, lock } = deps();
    const r = await runRefreshJob(opts({ sources: ["milb"] }), d);
    assert.equal(r.status, "ok");
    assert.deepEqual(calls, ["milb-structure", "milb-games"]);
    assert.deepEqual(r.steps.map((s) => [s.step, s.status]), [["milb-structure", "ok"], ["milb-games", "ok"], ["afl", "skipped"]]);
    assert.equal(lock.acquired, 1);
    assert.equal(lock.released, 1);
    assert.equal(lock.held, false);
    assert.equal(jobExitCode(r), 0);
  });

  test("overlapping jobs: the second finds the lock held and runs nothing", async () => {
    const lock = new FakeLock();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = deps({ lock });
    first.d.steps["milb-games"] = async () => {
      await gate;
      return { status: "ok" };
    };
    const running = runRefreshJob(opts({ sources: ["milb"] }), first.d);
    const second = deps({ lock });
    const r2 = await runRefreshJob(opts({ sources: ["milb"] }), second.d);
    assert.equal(r2.status, "locked");
    assert.deepEqual(second.calls, []);
    assert.equal(jobExitCode(r2), 0, "a skipped overlap is not an error");
    release();
    assert.equal((await running).status, "ok");
  });

  test("recovers abandoned runs only when applying, and only while holding the lock", async () => {
    let recoveredWithLock: boolean | undefined;
    const lock = new FakeLock();
    const { d } = deps({ lock, recoverAbandoned: async (ms) => {
      recoveredWithLock = lock.held;
      assert.equal(ms, DEFAULT_REFRESH.abandonedAfterMs);
      return 2;
    } });
    const r = await runRefreshJob(opts(), d);
    assert.equal(r.recoveredAbandonedRuns, 2);
    assert.equal(recoveredWithLock, true);
    let called = false;
    await runRefreshJob(opts({ apply: false }), deps({ recoverAbandoned: async () => ((called = true), 0) }).d);
    assert.equal(called, false, "dry runs never write");
  });

  test("a failing step is retried with bounded, jittered backoff, then succeeds", async () => {
    const { d, calls, waits } = deps({
      outcomes: { "milb-games": [{ status: "failed", error: "Source transport failed after 3 attempts" }, new Error("ECONNRESET"), { status: "ok" }] },
      random: () => 0.5,
    });
    const r = await runRefreshJob(opts({ sources: ["milb"] }), d);
    assert.equal(r.status, "ok");
    const games = r.steps.find((s) => s.step === "milb-games")!;
    assert.equal(games.attempts, 3);
    assert.deepEqual(waits, [66_000, 330_000], "60 s and 300 s, +10% jitter");
    assert.deepEqual(calls.filter((c) => c === "milb-games").length, 3);
  });

  test("a step that keeps failing ends the job as failed after maxAttempts; later steps still run", async () => {
    const { d, calls, waits } = deps({ outcomes: { "milb-structure": Array(5).fill({ status: "failed", error: "503" }) } });
    const r = await runRefreshJob(opts({ force: true }), d); // force: the AFL is off-season in June
    assert.equal(r.status, "failed");
    assert.equal(r.steps[0].status, "failed");
    assert.equal(r.steps[0].attempts, 3);
    assert.equal(r.steps[0].error, "503");
    assert.equal(waits.length, 2, "no wait after the last attempt");
    assert.deepEqual(calls.slice(3), ["milb-games", "afl"]);
    assert.equal(jobExitCode(r), 1);
  });

  test("permanent errors (HTTP 4xx except 408/429) are not retried; transient ones are", async () => {
    const { d, calls, waits } = deps({ outcomes: { "milb-games": [{ status: "failed", error: "/api/v1/league/119: Source HTTP 404" }] } });
    const r = await runRefreshJob(opts({ sources: ["milb"] }), d);
    const games = r.steps.find((s) => s.step === "milb-games")!;
    assert.deepEqual([games.status, games.attempts, games.detail?.permanent], ["failed", 1, true]);
    assert.deepEqual(waits, []);
    assert.equal(calls.filter((c) => c === "milb-games").length, 1);
    for (const transient of ["Source HTTP 503", "Source HTTP 429", "Source HTTP 408", "Source transport failed after 3 attempts: fetch failed", "Ingestion rolled back (database-write-failed, SQLSTATE 40001); run x", undefined])
      assert.equal(isPermanentError(transient), false, String(transient));
    for (const permanent of ["/x: Source HTTP 404", "Source HTTP 400", "Source HTTP 403", "HTTPS without embedded credentials is required"])
      assert.equal(isPermanentError(permanent), true, permanent);
  });

  test("quarantine is a data problem: never retried, reported for review", async () => {
    const { d, calls } = deps({ outcomes: { afl: [{ status: "quarantined", error: "2 issue(s); nothing applied" }] } });
    const r = await runRefreshJob(opts({ force: true }), d);
    assert.equal(calls.filter((c) => c === "afl").length, 1);
    assert.equal(r.steps[2].status, "quarantined");
    assert.equal(r.status, "failed");
    const partial = await runRefreshJob(opts(), deps({ outcomes: { "milb-games": [{ status: "ok-with-quarantine" }] } }).d);
    assert.equal(partial.status, "ok-with-quarantine");
    assert.equal(jobExitCode(partial), 0);
  });

  test("the deadline stops the job between attempts (real timers), and the lock is released", async () => {
    const lock = new FakeLock();
    const { d } = deps({ lock, sleep: undefined, outcomes: { "milb-structure": [{ status: "failed", error: "outage" }] } });
    const t = performance.now();
    const r = await runRefreshJob(opts({ timeoutMs: 80, retryDelaysMs: [10_000] }), d);
    assert.ok(performance.now() - t < 2000, "did not wait out the 10 s retry delay");
    assert.equal(r.status, "timed-out");
    assert.equal(r.steps[0].status, "timed-out");
    assert.equal(lock.held, false);
  });

  test("losing the lock's connection stops the job (another job could start)", async () => {
    const lost = new AbortController();
    const { d, calls } = deps({ lockLost: lost.signal });
    d.steps["milb-structure"] = async () => {
      lost.abort(new Error("ingestion job lock connection lost"));
      throw new Error("aborted");
    };
    const r = await runRefreshJob(opts(), d);
    assert.equal(r.status, "timed-out");
    assert.deepEqual(calls, [], "no further steps");
  });

  test("the lock is released even when a dependency throws", async () => {
    const lock = new FakeLock();
    const { d } = deps({ lock, lastStructureAppliedAt: async () => {
      throw new Error("database unavailable");
    } });
    await assert.rejects(runRefreshJob(opts(), d), /database unavailable/);
    assert.equal(lock.held, false);
  });

  test("nothing due off-season: no steps, exit 0", async () => {
    const { d, calls } = deps({ clock: () => new Date("2026-01-10T09:00:00Z") });
    const r = await runRefreshJob(opts(), d);
    assert.equal(r.status, "nothing-due");
    assert.deepEqual(calls, []);
    assert.equal(jobExitCode(r), 0);
  });
});

describe("step outcomes", () => {
  const summary = (o: Partial<MilbRunSummary>): MilbRunSummary => ({ provider: "mlb-stats-api", season: 2026, levels: ["aaa"], mode: "games", apply: true, incremental: true, chunks: [], totals: { records: 10, issues: 0, changed: 2, unchanged: 8, notices: 0 }, status: "ok", ...o });
  test("MiLB: ok / quarantine / failed with the resume point", () => {
    assert.equal(milbOutcome(summary({})).status, "ok");
    assert.equal(milbOutcome(summary({ status: "ok-with-quarantine" })).status, "ok-with-quarantine");
    const f = milbOutcome(summary({ status: "failed", resumeFrom: "2026-06-10", chunks: [{ phase: "games", status: "failed", error: "Source transport failed" }] }));
    assert.deepEqual([f.status, f.error, f.detail?.resumeFrom], ["failed", "Source transport failed", "2026-06-10"]);
  });
  test("AFL: a quarantined capture applies nothing and is not retried", () => {
    const r = (status: IngestionReport["status"]) => aflOutcome({ provider: "x", snapshotKey: "k", contentHash: "", rawContentHash: "", status, records: 5, issues: 1 });
    assert.equal(r("applied").status, "ok");
    assert.equal(r("applied-with-quarantine").status, "ok-with-quarantine");
    assert.equal(r("quarantined").status, "quarantined");
  });
});

describe("freshness", () => {
  const facts = (o: Partial<FreshnessFacts> = {}): FreshnessFacts => ({
    now: "2026-06-15T09:00:00.000Z",
    season: 2026,
    lastSuccess: { id: "r1", at: "2026-06-15T06:00:00.000Z", status: "applied", snapshotKey: "milb:...", errorCode: null },
    failuresSinceSuccess: [],
    stuckRunning: [],
    latestGame: { aaa: "2026-06-14", aa: "2026-06-14", "high-a": "2026-06-13", "single-a": "2026-06-14", afl: null },
    ...o,
  });
  test("in season and recent: ok (AFL is off-season in June)", () => {
    const r = assessFreshness(facts());
    assert.equal(r.verdict, "ok");
    assert.deepEqual(r.levels.map((l) => l.verdict), ["fresh", "fresh", "fresh", "fresh", "off-season"]);
    assert.equal(freshnessExitCode(r), 0);
  });
  test("a level behind, or no recent successful capture: stale (exit 1)", () => {
    const behind = assessFreshness(facts({ latestGame: { ...facts().latestGame, aa: "2026-06-08" } }));
    assert.equal(behind.verdict, "stale");
    assert.match(behind.reasons[0], /aa: latest game 2026-06-08 is 7 days old/);
    const noJob = assessFreshness(facts({ lastSuccess: { ...facts().lastSuccess!, at: "2026-06-13T00:00:00.000Z" } }));
    assert.equal(noJob.verdict, "stale");
    assert.match(noJob.reasons[0], /last successful capture 57 h ago/);
    assert.equal(freshnessExitCode(noJob), 1);
    assert.equal(assessFreshness(facts({ lastSuccess: null })).verdict, "stale");
    assert.equal(assessFreshness(facts({ latestGame: { ...facts().latestGame, aaa: null } })).levels[0].verdict, "no-data");
  });
  test("failures since the last success or dead captures: attention", () => {
    const r = assessFreshness(facts({
      failuresSinceSuccess: [{ id: "r2", at: "2026-06-15T07:00:00.000Z", status: "failed", snapshotKey: "k", errorCode: "database-write-failed" }],
      stuckRunning: [{ id: "r3", at: "2026-06-15T01:00:00.000Z", status: "running", snapshotKey: "k", errorCode: null }],
    }));
    assert.equal(r.verdict, "attention");
    assert.deepEqual(r.reasons, [
      "1 failed/quarantined capture(s) since the last success (latest: failed database-write-failed)",
      "1 capture(s) stuck in 'running' (process died; the next job marks them abandoned)",
    ]);
  });
  test("off-season: old data is expected, not stale", () => {
    const r = assessFreshness(facts({ now: "2027-01-20T00:00:00.000Z", lastSuccess: { ...facts().lastSuccess!, at: "2026-11-25T00:00:00.000Z" } }));
    assert.equal(r.verdict, "ok");
    assert.ok(r.levels.every((l) => l.verdict === "off-season"));
  });
});

describe("configuration", () => {
  test("the job lock uses Neon's direct endpoint (a transaction pooler cannot hold session locks)", () => {
    assert.equal(
      directConnectionString("postgresql://u:p%40ss@ep-spring-cake-ak5jqlqp-pooler.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require"),
      "postgresql://u:p%40ss@ep-spring-cake-ak5jqlqp.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require",
    );
    const direct = "postgresql://u:p@ep-x.us-west-2.aws.neon.tech/neondb?sslmode=require";
    assert.equal(directConnectionString(direct), direct);
    assert.equal(directConnectionString("postgres://postgres@localhost:5544/db"), "postgres://postgres@localhost:5544/db");
  });
  test("CLI options are validated; dry run by default", () => {
    const o = parseRefreshArgs([], new Date("2026-05-01T00:00:00Z"));
    assert.deepEqual([o.season, o.sources, o.apply, o.force, o.maxAttempts, o.retryDelaysMs, o.timeoutMs], [2026, ["milb", "afl"], false, false, 3, [60_000, 300_000], 2_700_000]);
    const custom = parseRefreshArgs(["--apply", "--sources=afl", "--retry-delays=5,10", "--max-attempts=2", "--timeout-minutes=10"]);
    assert.deepEqual([custom.apply, custom.sources, custom.retryDelaysMs, custom.maxAttempts, custom.timeoutMs], [true, ["afl"], [5000, 10_000], 2, 600_000]);
    for (const bad of [["--sources=nba"], ["--max-attempts=0"], ["--timeout-minutes=999"], ["--frobnicate"], ["apply"]])
      assert.throws(() => parseRefreshArgs(bad), String(bad));
  });
  test("every manual writer takes the same job lock before applying", () => {
    for (const cli of ["scripts/ingest-milb.ts", "scripts/ingest-afl.ts", "scripts/ops/milb-backfill.ts"]) {
      const src = readFileSync(join(ROOT, cli), "utf8");
      assert.match(src, /requireJobLock\(url!?\)/, cli);
      assert.match(src, /args\.apply/, cli);
    }
  });

  test("the systemd timer ships disabled and runs one job at a time", () => {
    const service = readFileSync(join(ROOT, "deploy/prospect-terminal-refresh.service"), "utf8");
    const timer = readFileSync(join(ROOT, "deploy/prospect-terminal-refresh.timer"), "utf8");
    assert.match(service, /^Type=oneshot$/m);
    assert.match(service, /refresh-data\.ts --apply/);
    assert.match(service, /^EnvironmentFile=\/etc\/prospect-terminal-ingest\/env$/m, "the writer credential lives in its own file, not the web server's");
    assert.match(service, /^User=prospect-ingest$/m);
    assert.match(timer, /^OnCalendar=/m);
    assert.match(timer, /^RandomizedDelaySec=/m);
    assert.match(timer, /^Persistent=true$/m);
    assert.doesNotMatch(readFileSync(join(ROOT, "deploy/deploy.sh"), "utf8"), /refresh\.timer|enable.*refresh/, "deploy never enables the schedule");
  });
});
