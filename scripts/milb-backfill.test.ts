import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertVerifyingTls,
  checkWriteTarget,
  expectedMigrations,
  expectedTables,
  schemaProblems,
  TargetGuardError,
} from "../src/ingestion/db-target";
import {
  checksSql,
  COUNTS_SQL,
  discoverCoverage,
  fingerprintSql,
  globalChecksSql,
  idempotencyResult,
  PRIOR_GAMES_SQL,
  runBackfill,
  runIssuesSql,
  sampleChunks,
  targetFactsSql,
  verifySql,
  type BackfillConfig,
  type BackfillDeps,
  type BackfillState,
  type Fingerprint,
  type IngestRequest,
  type LevelCoverage,
} from "../src/ingestion/milb-backfill";
import type { ChunkSummary, MilbRunSummary } from "../src/ingestion/milb-runner";
// The helper is ESM with top-level await; load it dynamically from this CommonJS test.
const helper = import("./ops/pg-readonly.mjs");

const EP = "ep-spring-cake-ak5jqlqp";
const SECRET = "s3cr3t-Pa55";
const OK_URL = `postgresql://neondb_owner:${SECRET}@${EP}-pooler.c-0.example-region.aws.neon.tech/neondb?sslmode=require&channel_binding=require`;
const TARGET = { endpoint: EP, database: "neondb" };
const DRIZZLE = join(import.meta.dirname, "..", "drizzle");

describe("write target guard", () => {
  test("accepts the approved endpoint, pooled or direct", () => {
    assert.deepEqual(checkWriteTarget(OK_URL, TARGET), { endpoint: EP, database: "neondb", pooled: true, sslmode: "require" });
    const direct = checkWriteTarget(OK_URL.replace("-pooler", "").replace("require&channel_binding=require", "verify-full"), TARGET);
    assert.equal(direct.pooled, false);
    assert.equal(direct.sslmode, "verify-full");
  });

  const refused: [string, string][] = [
    ["other endpoint (production)", OK_URL.replace("spring-cake-ak5jqlqp", "proud-river-a1b2c3d4")],
    ["endpoint with extra suffix", OK_URL.replace("ak5jqlqp", "ak5jqlqpx")],
    ["retired test endpoint", OK_URL.replace("spring-cake-ak5jqlqp", "lucky-sea-akc835g5")],
    ["non-Neon host", OK_URL.replace("c-0.example-region.aws.neon.tech", "example.com")],
    ["host lookalike", OK_URL.replace(".neon.tech", ".neon.tech.evil.io")],
    ["host override parameter", `${OK_URL}&host=10.0.0.1`],
    ["options parameter", `${OK_URL}&options=-c%20search_path%3Dother`],
    ["custom root certificate", `${OK_URL}&sslrootcert=/tmp/ca.pem`],
    ["libpq compat", `${OK_URL}&uselibpqcompat=true`],
    ["ssl=false", `${OK_URL}&ssl=false`],
    ["sslmode disable", OK_URL.replace("sslmode=require", "sslmode=disable")],
    ["sslmode prefer", OK_URL.replace("sslmode=require", "sslmode=prefer")],
    ["sslmode verify-ca", OK_URL.replace("sslmode=require", "sslmode=verify-ca")],
    ["no sslmode", OK_URL.replace("sslmode=require&", "")],
    ["repeated sslmode", `${OK_URL}&sslmode=require`],
    ["other database", OK_URL.replace("/neondb?", "/postgres?")],
    ["unexpected port", OK_URL.replace(".tech/", ".tech:6543/")],
    ["no password", OK_URL.replace(`:${SECRET}`, "")],
    ["not postgres", OK_URL.replace("postgresql:", "mysql:")],
    ["not a URL", "neondb_owner s3cr3t-Pa55 host"],
    ["empty", ""],
  ];
  for (const [name, url] of refused)
    test(`refuses ${name} without leaking credentials`, () => {
      assert.throws(
        () => checkWriteTarget(url, TARGET),
        (e: unknown) => e instanceof TargetGuardError && !e.message.includes(SECRET) && !e.message.includes("neondb_owner"),
      );
    });

  test("refuses when no approved target is configured", () => {
    assert.throws(() => checkWriteTarget(OK_URL, { endpoint: "", database: "neondb" }), TargetGuardError);
  });
});

describe("schema expectations", () => {
  test("derive the 4 migrations and 26 tables from the checked-in files", () => {
    const migrations = expectedMigrations(DRIZZLE);
    assert.equal(migrations.length, 4);
    const first = migrations[0];
    assert.equal(first.hash, createHash("sha256").update(readFileSync(join(DRIZZLE, `${first.tag}.sql`), "utf8")).digest("hex"));
    assert.equal(expectedTables(DRIZZLE).length, 26);
  });

  test("schemaProblems reports database, migration and table mismatches", () => {
    const migrations = expectedMigrations(DRIZZLE);
    const tables = expectedTables(DRIZZLE);
    const expected = { database: "neondb", migrations, tables };
    const facts = { database: "neondb", schema: "public", migrations: migrations.map((m) => ({ hash: m.hash, createdAt: m.createdAt })), tables };
    assert.deepEqual(schemaProblems(facts, expected), []);
    assert.match(schemaProblems({ ...facts, database: "prod" }, expected).join(), /prod/);
    assert.match(schemaProblems({ ...facts, migrations: facts.migrations.slice(0, 3) }, expected).join(), /expected 4 migrations, found 3/);
    const tampered = facts.migrations.map((m, i) => (i === 2 ? { ...m, hash: "0".repeat(64) } : m));
    assert.match(schemaProblems({ ...facts, migrations: tampered }, expected).join(), /does not match/);
    assert.match(schemaProblems({ ...facts, tables: [...tables, "scratch"] }, expected).join(), /unexpected tables: scratch/);
    assert.match(schemaProblems({ ...facts, tables: tables.slice(1) }, expected).join(), /missing tables/);
  });
});

describe("read-only SQL", () => {
  const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const statements = {
    checks: checksSql(11, 2026, "2026-04-01", "2026-04-07"),
    checksSeason: checksSql(14, 2026),
    global: globalChecksSql(),
    counts: COUNTS_SQL,
    fingerprint: fingerprintSql([uuid]),
    fingerprintEmpty: fingerprintSql([]),
    prior: PRIOR_GAMES_SQL,
    facts: targetFactsSql("milb:2026:aaa:games:2026-09-15:2026-09-21:all-leagues:all-teams"),
    verify: verifySql(uuid, "milb:2026:aa:games:2026-04-02:2026-04-08:all-leagues:all-teams", 12, 2026, "2026-04-02", "2026-04-08"),
    verifyStructure: verifySql(uuid, "milb:2026:aa:structure:season:end:all-leagues:all-teams", 12, 2026),
    issues: runIssuesSql(uuid),
  };
  for (const [name, sql] of Object.entries(statements))
    test(`${name} is a single statement the read-only helper accepts`, async () => {
      const { classify, parseScript } = await helper;
      const items = parseScript(sql);
      assert.equal(items.length, 1);
      assert.equal(items[0].kind, "sql");
      assert.equal(classify(items[0].text), "run");
    });

  test("runs scored without a plate appearance are not impossible (pinch/automatic runners)", () => {
    assert.doesNotMatch(checksSql(11, 2026), /runs, 0\) > b\.plate_appearances/);
  });

  test("values are validated before they are inlined", () => {
    assert.throws(() => verifySql("x' or '1'='1", "k", 11, 2026));
    assert.throws(() => verifySql(uuid, "k'; select 1", 11, 2026));
    assert.throws(() => checksSql(11, 2026, "2026-04-01' or true --", "2026-04-07"));
    assert.throws(() => fingerprintSql(["not-a-uuid"]));
  });
});

describe("coverage discovery", () => {
  const schedule = (dates: Record<string, [number, string][]>) => ({
    dates: Object.entries(dates).map(([date, games]) => ({
      date,
      games: games.map(([gamePk, s]) => ({ gamePk, status: { detailedState: s } })),
    })),
  });
  const fake =
    (body: unknown, season = { regularSeasonStartDate: "2026-04-02", regularSeasonEndDate: "2026-09-06" }) =>
    async (path: string) =>
      path.startsWith("seasons/") ? { seasons: [season] } : body;

  test("reads the real first/last dates and counts distinct and final gamePks", async () => {
    const cov = await discoverCoverage(
      fake(schedule({ "2026-04-02": [[1, "Postponed"], [2, "Final"]], "2026-04-03": [[1, "Final"], [3, "Completed Early"]], "2026-09-06": [[4, "Scheduled"]] })),
      2026,
      "high-a",
      ["R"],
    );
    assert.equal(cov.sportId, 13);
    assert.deepEqual([cov.first, cov.last, cov.dates, cov.rows, cov.gamePks, cov.finalGamePks], ["2026-04-02", "2026-09-06", 3, 5, 4, 3]);
    assert.deepEqual(cov.warnings, ["non-terminal schedule rows (Scheduled: 1)"]);
  });

  test("warns when the schedule extends beyond the regular season", async () => {
    const cov = await discoverCoverage(fake(schedule({ "2026-03-30": [[1, "Final"]], "2026-09-06": [[2, "Final"]] })), 2026, "aa", ["R"]);
    assert.match(cov.warnings.join(), /extends beyond regular season/);
  });

  test("refuses an empty schedule or dates outside the season", async () => {
    await assert.rejects(discoverCoverage(fake(schedule({})), 2026, "aaa", ["R"]), /No aaa 2026 schedule/);
    await assert.rejects(discoverCoverage(fake(schedule({ "2027-01-02": [[1, "Final"]] })), 2026, "aaa", ["R"]), /outside season/);
  });
});

describe("idempotency judgement", () => {
  const chunk = (c: Partial<ChunkSummary>): ChunkSummary => ({ phase: "games", status: "dry-run", issues: 0, ...c });
  const s = { from: "2026-04-02", to: "2026-04-08", issues: 0 };
  test("passes when nothing would change", () => {
    assert.ok(idempotencyResult(s, chunk({ databaseComparison: { insert: 0, update: 0, unchanged: 900, byKind: {} } }), true).passed);
  });
  test("allows game-row differences only up to the reconciled cross-chunk games", () => {
    const c = (n: number) =>
      chunk({ databaseComparison: { insert: 0, update: n, unchanged: 900, byKind: { game: { insert: 0, update: n } } }, noticeReasons: { "reconciled-reschedule": 1 } });
    assert.ok(idempotencyResult(s, c(1), true).passed);
    assert.ok(!idempotencyResult(s, c(2), true).passed);
  });
  test("fails on any line change, insert, issue drift or count change", () => {
    const lines = chunk({ databaseComparison: { insert: 0, update: 1, unchanged: 900, byKind: { battingGame: { insert: 0, update: 1 } } }, noticeReasons: { "reconciled-reschedule": 5 } });
    assert.ok(!idempotencyResult(s, lines, true).passed);
    assert.ok(!idempotencyResult(s, chunk({ databaseComparison: { insert: 1, update: 0, unchanged: 900, byKind: { player: { insert: 1, update: 0 } } } }), true).passed);
    assert.ok(!idempotencyResult(s, chunk({ issues: 1, databaseComparison: { insert: 0, update: 0, unchanged: 900, byKind: {} } }), true).passed);
    assert.ok(!idempotencyResult(s, chunk({ databaseComparison: { insert: 0, update: 0, unchanged: 900, byKind: {} } }), false).passed);
    assert.ok(!idempotencyResult(s, chunk({ databaseComparison: { insert: 0, update: 3, unchanged: 900 } }), true).passed, "no breakdown");
    assert.ok(!idempotencyResult(s, undefined, true).passed);
  });
  test("samples first, middle and last chunks with games", () => {
    const cs = Array.from({ length: 9 }, (_, i) => ({ i, checks: { completeGames: i === 4 ? 0 : 5 } as never }));
    assert.deepEqual(sampleChunks(cs, 3).map((c) => c.i), [0, 5, 8]);
    assert.deepEqual(sampleChunks(cs, 0), []);
  });
});

// ---------------------------------------------------------------------------------------------
// Orchestration with an in-memory database and ingestion
// ---------------------------------------------------------------------------------------------

const migrations = expectedMigrations(DRIZZLE);
const tables = expectedTables(DRIZZLE);
const coverage = (level: "aaa" | "aa"): LevelCoverage => ({
  level,
  sportId: level === "aaa" ? 11 : 12,
  regularSeason: { start: "2026-04-01", end: "2026-04-17" },
  first: "2026-04-01",
  last: "2026-04-17",
  dates: 17,
  rows: 12,
  gamePks: 12,
  finalGamePks: 12,
  statuses: { Final: 12 },
  warnings: [],
});
const FP: Fingerprint = {
  aflGames: 120,
  aflGamesHash: "a",
  aflBatting: 2000,
  aflBattingHash: "b",
  aflPitching: 900,
  aflPitchingHash: "c",
  aflPlayersHash: "d",
  priorLines: 2434,
  priorLinesHash: "e",
};

function world() {
  const runs = new Map<string, string>();
  const calls: IngestRequest[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const db = {
    facts: {
      database: "neondb",
      schema: "public",
      timeline: "tl-1",
      migrations: migrations.map((m) => ({ hash: m.hash, createdAt: m.createdAt })),
      tables,
      aflLeague: 1,
      evidenceRuns: 1,
      recentRunning: 0,
    },
    fingerprint: { ...FP },
    hard: {} as Record<string, number>,
    review: {} as Record<string, number>,
    countsSeq: 0,
  };
  let state: BackfillState | null = null;
  let failures: { match: (r: IngestRequest) => boolean; times: number; status?: ChunkSummary["status"] }[] = [];
  let interrupted = false;
  const deps: BackfillDeps = {
    coverage: async (level) => coverage(level as "aaa" | "aa"),
    ingest: async (r) => {
      calls.push(r);
      const f = failures.find((x) => x.match(r) && x.times > 0);
      if (f) {
        f.times--;
        if (!f.status) return { status: "failed", chunks: [{ phase: r.mode, status: "failed", error: "Source HTTP 503" }] } as unknown as MilbRunSummary;
        const runId = randomUUID();
        runs.set(runId, f.status);
        return { status: "ok-with-quarantine", chunks: [{ phase: r.mode, status: f.status, runId, records: 10, issues: 2, changed: 8, unchanged: 0, notices: 0 }] } as unknown as MilbRunSummary;
      }
      if (!r.apply)
        return {
          status: "ok",
          chunks: [{ phase: r.mode, status: "dry-run", records: 50, issues: 0, notices: 0, databaseComparison: { insert: 0, update: 0, unchanged: 50, byKind: {} } }],
        } as unknown as MilbRunSummary;
      const runId = randomUUID();
      runs.set(runId, "applied");
      return {
        status: "ok",
        chunks: [{ phase: r.mode, status: "applied", runId, records: 50, issues: 0, changed: 50, unchanged: 0, notices: 1, noticeReasons: { "reconciled-reschedule": 1 } }],
      } as unknown as MilbRunSummary;
    },
    query: async (sql) => {
      if (sql.includes("current_database()")) return db.facts;
      if (sql.includes("'rosterObs'")) return { games: 100, batting: 1000 };
      if (sql.startsWith("select coalesce(json_agg(g.id")) return ["0f8fad5b-d9cb-469f-a165-70867728950e"];
      if (sql.includes("'aflGamesHash'")) return db.fingerprint;
      if (sql.includes("json_object_agg(x.code")) return {};
      if (sql.includes("'runStatus'")) {
        const id = /r\.id = '([0-9a-f-]{36})'/.exec(sql)?.[1] ?? "";
        return { runStatus: runs.get(id) ?? null, games: sql.includes("between") ? 12 : null, finalIncomplete: 0 };
      }
      if (sql.includes("'completeGames'"))
        return {
          games: 12,
          completeGames: 12,
          battingLines: 300,
          pitchingLines: 100,
          hard: { finalMissingLines: 0, finalIncomplete: 0, ...db.hard },
          review: { runsVsScoreMismatch: 0, pendingGames: 0, ...db.review },
          samples: { runsVsScoreMismatch: [] },
        };
      if (sql.includes("'dupIdentities'")) return { dupIdentities: 0, dupBatting: 0, dupPitching: 0, orphanIdentities: 0 };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
    loadState: async () => (state ? (JSON.parse(JSON.stringify(state)) as BackfillState) : null),
    saveState: async (s) => {
      state = JSON.parse(JSON.stringify(s)) as BackfillState;
    },
    writeReport: async () => {},
    log: (e) => logs.push(e),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date("2026-11-07T00:00:00Z"),
    interrupted: () => interrupted,
  };
  return {
    deps,
    db,
    runs,
    calls,
    logs,
    sleeps,
    getState: () => state,
    setState: (s: BackfillState | null) => (state = s),
    fail: (match: (r: IngestRequest) => boolean, times: number, status?: ChunkSummary["status"]) => failures.push({ match, times, status }),
    clearFailures: () => (failures = []),
    interrupt: () => (interrupted = true),
  };
}

const config = (o: Partial<BackfillConfig> = {}): BackfillConfig => ({
  season: 2026,
  levels: ["aaa", "aa"],
  gameTypes: ["R"],
  chunkDays: 7,
  apply: true,
  continueOnQuarantine: false,
  recheck: false,
  retries: 2,
  retryBaseMs: 1000,
  chunkPauseMs: 0,
  idempotencySamples: 2,
  target: TARGET,
  expected: { migrations, tables },
  evidenceSnapshotKey: "milb:2026:aaa:games:2026-09-15:2026-09-21:all-leagues:all-teams",
  ...o,
});
const applies = (w: ReturnType<typeof world>) => w.calls.filter((c) => c.apply);

describe("backfill orchestration", () => {
  test("plan mode verifies the target and writes nothing", async () => {
    const w = world();
    const r = await runBackfill(config({ apply: false }), w.deps);
    assert.equal(r.status, "planned");
    assert.equal(w.calls.length, 0);
    assert.equal(r.plan![0].current.games, 12, "plan reports what the database holds today");
    assert.equal(r.baselinePreview!.priorGames, 1);
    assert.equal(w.getState(), null);
    assert.deepEqual(r.plan!.map((p) => p.chunks.length), [3, 3]);
    assert.deepEqual(r.plan![0].chunks.map((c) => `${c.from}..${c.to}`), ["2026-04-01..2026-04-07", "2026-04-08..2026-04-14", "2026-04-15..2026-04-17"]);
  });

  for (const [name, patch, pattern] of [
    ["other database", { database: "postgres" }, /connected database is postgres/],
    ["missing migration", { migrations: migrations.slice(0, 3).map((m) => ({ hash: m.hash, createdAt: m.createdAt })) }, /expected 4 migrations/],
    ["missing branch evidence", { evidenceRuns: 0 }, /not the expected test branch/],
    ["missing AFL data", { aflLeague: 0 }, /AFL league identity/],
  ] as const)
    test(`refuses before any write: ${name}`, async () => {
      const w = world();
      Object.assign(w.db.facts, patch);
      const r = await runBackfill(config(), w.deps);
      assert.equal(r.status, "refused");
      assert.match(r.stop!.reason, pattern);
      assert.equal(w.calls.length, 0);
      assert.equal(w.getState(), null);
    });

  test("applies structure then every chunk per level, then previews samples read-only", async () => {
    const w = world();
    const r = await runBackfill(config(), w.deps);
    assert.equal(r.status, "complete");
    const order = applies(w).map((c) => `${c.level}:${c.mode}:${c.from ?? ""}`);
    assert.deepEqual(order, [
      "aaa:structure:",
      "aaa:games:2026-04-01",
      "aaa:games:2026-04-08",
      "aaa:games:2026-04-15",
      "aa:structure:",
      "aa:games:2026-04-01",
      "aa:games:2026-04-08",
      "aa:games:2026-04-15",
    ]);
    const previews = w.calls.filter((c) => !c.apply);
    assert.equal(previews.length, 4);
    assert.ok(previews.every((c) => c.refetchComplete && c.mode === "games"));
    assert.equal(r.levelReports[0].chunks.applied, 3);
    assert.equal(r.levelReports[0].totals.notices, 4);
    assert.ok(r.preserved?.passed);
    const state = w.getState()!;
    assert.equal(state.target.timeline, "tl-1");
    assert.equal(Object.values(state.levels.aaa!.chunks).filter((c) => c.checksPassed).length, 3);
  });

  test("a restart skips only chunks the database verifies, and re-runs the rest", async () => {
    const w = world();
    await runBackfill(config(), w.deps);
    const first = w.getState()!;
    // Simulate a chunk whose recorded run is no longer applied in the database.
    const forged = first.levels.aa!.chunks["2026-04-08..2026-04-14"];
    w.runs.set(forged.runId!, "failed");
    w.calls.length = 0;
    const r = await runBackfill(config(), w.deps);
    assert.equal(r.status, "complete");
    assert.deepEqual(applies(w).map((c) => `${c.level}:${c.mode}:${c.from ?? ""}`), ["aa:games:2026-04-08"]);
    assert.equal(r.levelReports[0].chunks.skippedVerified, 3);
    assert.equal(r.levelReports[1].chunks.skippedVerified, 2);
  });

  test("--recheck re-runs verified chunks", async () => {
    const w = world();
    await runBackfill(config({ levels: ["aaa"] }), w.deps);
    w.calls.length = 0;
    await runBackfill(config({ levels: ["aaa"], recheck: true }), w.deps);
    assert.equal(applies(w).length, 4);
  });

  test("retries a failed capture with backoff, then continues", async () => {
    const w = world();
    w.fail((r) => r.from === "2026-04-08" && r.level === "aaa", 2);
    const r = await runBackfill(config({ levels: ["aaa"] }), w.deps);
    assert.equal(r.status, "complete");
    assert.deepEqual(w.sleeps, [1000, 3000]);
    assert.equal(w.getState()!.levels.aaa!.chunks["2026-04-08..2026-04-14"].attempts, 3);
  });

  test("stops with the failing chunk after the retry budget, and resumes there", async () => {
    const w = world();
    w.fail((r) => r.from === "2026-04-08" && r.level === "aaa", 5);
    const r = await runBackfill(config({ levels: ["aaa"] }), w.deps);
    assert.equal(r.status, "stopped");
    assert.deepEqual(r.stop, { reason: "capture failed after 3 attempts: Source HTTP 503", level: "aaa", from: "2026-04-08", to: "2026-04-14" });
    w.clearFailures();
    w.calls.length = 0;
    const again = await runBackfill(config({ levels: ["aaa"] }), w.deps);
    assert.equal(again.status, "complete");
    assert.deepEqual(applies(w).map((c) => c.from), ["2026-04-08", "2026-04-15"]);
  });

  test("an interrupt stops without retrying", async () => {
    const w = world();
    w.fail((r) => r.from === "2026-04-01" && r.mode === "games", 1);
    w.interrupt();
    const r = await runBackfill(config({ levels: ["aaa"] }), w.deps);
    assert.equal(r.status, "stopped");
    assert.equal(r.stop!.reason, "interrupted");
    assert.deepEqual(w.sleeps, []);
  });

  test("quarantined records stop the run unless --continue-on-quarantine", async () => {
    const w = world();
    w.fail((r) => r.from === "2026-04-08" && r.mode === "games", 1, "applied-with-quarantine");
    const r = await runBackfill(config({ levels: ["aaa"] }), w.deps);
    assert.equal(r.status, "stopped");
    assert.match(r.stop!.reason, /2 record\(s\) quarantined/);
    // Not skipped on restart: it is re-run (idempotent) and must be accepted explicitly.
    w.fail((r) => r.from === "2026-04-08" && r.mode === "games", 1, "applied-with-quarantine");
    const accepted = await runBackfill(config({ levels: ["aaa"], continueOnQuarantine: true }), w.deps);
    assert.equal(accepted.status, "complete");
    assert.equal(accepted.levelReports[0].chunks.withQuarantine, 1);
  });

  test("after a quarantine stop, a clean re-apply without the flag resumes at that chunk and completes", async () => {
    const w = world();
    w.fail((r) => r.from === "2026-04-08" && r.mode === "games", 1, "applied-with-quarantine");
    const r = await runBackfill(config({ levels: ["aaa"] }), w.deps);
    assert.equal(r.status, "stopped");
    // The cause is fixed upstream/in the adapter: the same chunk now applies cleanly.
    w.calls.length = 0;
    const again = await runBackfill(config({ levels: ["aaa"] }), w.deps);
    assert.equal(again.status, "complete");
    assert.deepEqual(applies(w).map((c) => c.from), ["2026-04-08", "2026-04-15"]);
    assert.equal(again.levelReports[0].chunks.withQuarantine, 0);
    assert.equal(again.levelReports[0].chunks.skippedVerified, 1);
  });

  test("a whole-capture quarantine always stops", async () => {
    const w = world();
    w.fail((r) => r.mode === "structure", 1, "quarantined");
    const r = await runBackfill(config({ levels: ["aaa"], continueOnQuarantine: true }), w.deps);
    assert.equal(r.status, "stopped");
    assert.match(r.stop!.reason, /quarantined as a whole/);
  });

  test("a failed integrity check stops and the chunk is re-checked on restart", async () => {
    const w = world();
    w.db.hard = { lineTeamNotInGame: 2 };
    const r = await runBackfill(config({ levels: ["aaa"] }), w.deps);
    assert.equal(r.status, "stopped");
    assert.match(r.stop!.reason, /lineTeamNotInGame=2/);
    assert.equal(w.getState()!.levels.aaa!.chunks["2026-04-01..2026-04-07"].checksPassed, false);
    w.db.hard = {};
    w.calls.length = 0;
    await runBackfill(config({ levels: ["aaa"] }), w.deps);
    assert.equal(applies(w)[0].from, "2026-04-01");
  });

  test("score mismatches are recorded for review, not hidden", async () => {
    const w = world();
    w.db.review = { runsVsScoreMismatch: 1 };
    const r = await runBackfill(config({ levels: ["aaa"] }), w.deps);
    assert.equal(r.status, "complete-with-review");
    assert.match(r.levelReports[0].review.join(), /runsVsScoreMismatch: 1/);
  });

  test("a change to previously imported AFL or Triple-A lines stops the run", async () => {
    const w = world();
    await runBackfill(config({ levels: ["aaa"] }), w.deps);
    w.db.fingerprint = { ...FP, aflBattingHash: "changed", aflPlayersHash: "enriched" };
    const r = await runBackfill(config({ levels: ["aaa"] }), w.deps);
    assert.equal(r.status, "stopped");
    assert.match(r.stop!.reason, /aflBattingHash/);
    assert.deepEqual(r.preserved, { passed: false, changed: ["aflBattingHash"], informational: ["aflPlayersHash"] });
  });

  test("a state file from another target or branch is refused", async () => {
    const w = world();
    await runBackfill(config({ levels: ["aaa"] }), w.deps);
    w.db.facts.timeline = "tl-other";
    const r = await runBackfill(config({ levels: ["aaa"] }), w.deps);
    assert.equal(r.status, "refused");
    assert.match(r.stop!.reason, /different target/);
  });

  test("refuses when database invariants already fail before any write", async () => {
    const w = world();
    const query = w.deps.query;
    w.deps.query = async (sql) => (sql.includes("'dupIdentities'") ? { dupIdentities: 0, orphanIdentities: 2 } : query(sql));
    const r = await runBackfill(config(), w.deps);
    assert.equal(r.status, "refused");
    assert.match(r.stop!.reason, /orphanIdentities=2/);
    assert.equal(w.calls.length, 0);
  });

  test("refuses to start while another ingestion run is active", async () => {
    const w = world();
    w.db.facts.recentRunning = 1;
    const r = await runBackfill(config(), w.deps);
    assert.equal(r.status, "stopped");
    assert.equal(w.calls.length, 0);
  });
});

test("writer TLS: sslmode=require is accepted only on pg 8 (where it verifies the certificate)", () => {
  assert.doesNotThrow(() => assertVerifyingTls("8.23.1", "require"));
  assert.doesNotThrow(() => assertVerifyingTls("9.0.0", "verify-full"));
  assert.throws(() => assertVerifyingTls("9.0.0", "require"), /verify-full/);
  assert.throws(() => assertVerifyingTls("garbage", "require"), /verify-full/);
  // The installed pg must still accept the test branch's sslmode=require.
  const installed = JSON.parse(readFileSync(join(process.cwd(), "node_modules/pg/package.json"), "utf8")).version;
  assert.doesNotThrow(() => assertVerifyingTls(installed, "require"));
});
