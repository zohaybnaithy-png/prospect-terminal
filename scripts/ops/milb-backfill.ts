/**
 * Guarded full-season MiLB backfill against the Neon TEST branch only.
 * See docs/MILB-BACKFILL.md. Orchestration lives in src/ingestion/milb-backfill.ts.
 *
 *   npm run -s backfill:milb -- --season=2026                       # plan: read-only checks + chunk plan
 *   npm run -s backfill:milb -- --season=2026 --level=aaa --apply --confirm=ep-spring-cake-ak5jqlqp
 *
 * Without --apply nothing is written anywhere (not even the local state file). With --apply the
 * run writes only through PostgresIngestionSink, and only after: the connection string names the
 * approved endpoint and database with a verifying sslmode and no other parameters, the server
 * confirms database/schema/migrations/tables and the branch evidence, and --confirm repeats the
 * endpoint. DATABASE_URL and PG* variables are removed so nothing can fall back to them.
 *
 * stdout: the final JSON report. stderr: progress. Files: --run-dir (default ~/pt-runs/milb-backfill-<season>).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { MILB_LEVEL_IDS, type MilbLevelId } from "../../src/domain/levels";
import {
  checkWriteTarget,
  expectedMigrations,
  expectedTables,
  TargetGuardError,
} from "../../src/ingestion/db-target";
import {
  discoverCoverage,
  runBackfill,
  type BackfillConfig,
  type BackfillState,
  type IngestRequest,
} from "../../src/ingestion/milb-backfill";
import { planDateChunks, runMilbIngestion } from "../../src/ingestion/milb-runner";
import { PostgresIngestionSink } from "../../src/ingestion/postgres-sink";
import { progress, redact, setProgressReporter, startHeartbeat, stderrReporter } from "../../src/ingestion/progress";
import { MILB_GAME_TYPES, type MilbGameType } from "../../src/ingestion/sources/milb-config";
import { milbSnapshotKey } from "../../src/ingestion/sources/milb-stats-api";
import { MlbClient } from "../../src/ingestion/sources/mlb-client";

/** The only database this script may write to (replacement Neon test branch). */
const APPROVED_ENDPOINT = "ep-spring-cake-ak5jqlqp";
const APPROVED_DATABASE = "neondb";
/** Only the approved test branch holds the guarded one-week Triple-A import. */
const EVIDENCE_SNAPSHOT_KEY = milbSnapshotKey({
  season: 2026,
  levels: ["aaa"],
  mode: "games",
  from: "2026-09-15",
  to: "2026-09-21",
});

const ROOT = resolve(import.meta.dirname, "../..");
const HELPER = join(ROOT, "scripts/ops/pg-readonly.mjs");

// Nothing may fall back to the web app's URL or libpq environment defaults.
for (const key of Object.keys(process.env))
  if (key === "DATABASE_URL" || key.startsWith("PG")) delete process.env[key];

const verbose = process.argv.includes("--verbose");
const base = stderrReporter();
setProgressReporter((event, fields) => {
  if (!verbose && (event === "http:get" || event === "heartbeat" || event.startsWith("db:client"))) return;
  base(event, fields);
});
const stopHeartbeat = startHeartbeat(30_000);

function parse(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      season: { type: "string", default: "2026" },
      level: { type: "string", default: "all" },
      apply: { type: "boolean", default: false },
      confirm: { type: "string" },
      "run-dir": { type: "string" },
      "continue-on-quarantine": { type: "boolean", default: false },
      recheck: { type: "boolean", default: false },
      retries: { type: "string", default: "3" },
      "retry-base-ms": { type: "string", default: "30000" },
      "chunk-pause-ms": { type: "string", default: "1000" },
      concurrency: { type: "string", default: "4" },
      "idempotency-samples": { type: "string", default: "3" },
      "game-types": { type: "string", default: "R" },
      verbose: { type: "boolean", default: false },
    },
  });
  const int = (v: string, min: number, max: number) => z.coerce.number().int().min(min).max(max).parse(v);
  const season = int(values.season, 2005, 2200);
  const requested =
    values.level === "all" ? [...MILB_LEVEL_IDS] : z.array(z.enum(MILB_LEVEL_IDS as [MilbLevelId, ...MilbLevelId[]])).min(1).parse(values.level.split(","));
  if (new Set(requested).size !== requested.length) throw new Error("Repeated --level");
  // Always Triple-A → Single-A, one level at a time.
  const levels = MILB_LEVEL_IDS.filter((l) => requested.includes(l));
  const gameTypes = z.array(z.enum(MILB_GAME_TYPES)).min(1).parse(values["game-types"].split(",")) as MilbGameType[];
  if (values.apply && values.confirm !== APPROVED_ENDPOINT)
    throw new Error(`--apply requires --confirm=${APPROVED_ENDPOINT} (the approved test endpoint)`);
  if (!values.apply && values.confirm) throw new Error("--confirm is only meaningful with --apply");
  const runDir = resolve(values["run-dir"] ?? join(homedir(), "pt-runs", `milb-backfill-${season}`));
  const rel = relative(ROOT, runDir);
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/")))
    throw new Error("--run-dir must be outside the repository");
  return {
    season,
    levels,
    gameTypes,
    apply: values.apply,
    runDir,
    continueOnQuarantine: values["continue-on-quarantine"],
    recheck: values.recheck,
    retries: int(values.retries, 0, 10),
    retryBaseMs: int(values["retry-base-ms"], 0, 600_000),
    chunkPauseMs: int(values["chunk-pause-ms"], 0, 60_000),
    concurrency: int(values.concurrency, 1, 6),
    idempotencySamples: int(values["idempotency-samples"], 0, 10),
  };
}

/** Runs one statement through the read-only helper; returns the parsed JSON value. */
function readOnly(url: string) {
  // Minimal environment for the helper: no DATABASE_URL or PG* defaults can reach it.
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    INGESTION_DATABASE_URL: url,
    PT_EXPECTED_ENDPOINT: APPROVED_ENDPOINT,
  } as unknown as NodeJS.ProcessEnv;
  const run = (args: string[]) =>
    new Promise<string>((resolvePromise, reject) =>
      execFile(process.execPath, [HELPER, ...args], { env, cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 }, (error, stdout, stderr) => {
        if (error) {
          // Report the helper's own error line, not the leading (cosmetic) pg SSL warning.
          const text = String(stderr || "");
          const detail = error.killed
            ? `timed out after 300s (${error.signal ?? "killed"})`
            : (text.match(/pg-readonly [^\n]*/)?.[0] ?? (text || error.message).trim().slice(-400));
          reject(new Error(`read-only query failed: ${redact(detail).trim().slice(0, 400)}`));
        }
        else resolvePromise(stdout);
      }),
    );
  return {
    query: async (sql: string) => {
      const out = (await run(["query", sql])).trim();
      return out === "" ? null : (JSON.parse(out) as unknown);
    },
    file: (path: string) => run(["file", path]),
  };
}

async function acquireLock(runDir: string) {
  const lock = join(runDir, "backfill.lock");
  try {
    await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch {
    const pid = Number(await readFile(lock, "utf8").catch(() => "0"));
    let alive = false;
    try {
      if (pid > 0) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`another backfill (pid ${pid}) holds ${lock}`);
    progress("backfill:stale-lock", { pid });
    await writeFile(lock, String(process.pid), { mode: 0o600 });
  }
  return () => rm(lock, { force: true });
}

const interrupt = new AbortController();
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  progress("backfill:interrupt", { note: "finishing or rolling back the current capture; press Ctrl-C again to force" });
  interrupt.abort();
});

async function main() {
  const args = parse(process.argv.slice(2));
  const url = process.env.INGESTION_DATABASE_URL;
  if (!url && !args.apply) {
    // Offline plan: real API coverage and the chunk plan only; no database is contacted.
    progress("backfill:offline-plan", { note: "INGESTION_DATABASE_URL not set: target and chunk state are NOT verified" });
    const plan = [];
    for (const level of args.levels) {
      const client = new MlbClient({ concurrency: 1, retainBodies: false });
      const coverage = await discoverCoverage((p, q) => client.get(p, q), args.season, level, args.gameTypes);
      plan.push({ level, coverage, chunks: planDateChunks(coverage.first, coverage.last, 7) });
    }
    process.stdout.write(`${JSON.stringify({ status: "planned-offline", season: args.season, gameTypes: args.gameTypes, plan }, null, 2)}\n`);
    return;
  }
  const target = checkWriteTarget(url, { endpoint: APPROVED_ENDPOINT, database: APPROVED_DATABASE });
  progress("backfill:start", {
    mode: args.apply ? "APPLY" : "plan (read-only)",
    endpoint: target.endpoint,
    pooled: target.pooled,
    sslmode: target.sslmode,
    season: args.season,
    levels: args.levels.join(","),
    runDir: args.runDir,
  });
  await mkdir(args.runDir, { recursive: true, mode: 0o700 });
  await chmod(args.runDir, 0o700);
  const release = args.apply ? await acquireLock(args.runDir) : async () => {};
  const db = readOnly(url!);
  let sink: PostgresIngestionSink | undefined;
  const statePath = join(args.runDir, "state.json");
  const config: BackfillConfig = {
    season: args.season,
    levels: args.levels,
    gameTypes: args.gameTypes,
    chunkDays: 7,
    apply: args.apply,
    continueOnQuarantine: args.continueOnQuarantine,
    recheck: args.recheck,
    retries: args.retries,
    retryBaseMs: args.retryBaseMs,
    chunkPauseMs: args.chunkPauseMs,
    idempotencySamples: args.idempotencySamples,
    target: { endpoint: target.endpoint, database: target.database },
    expected: { migrations: expectedMigrations(join(ROOT, "drizzle")), tables: expectedTables(join(ROOT, "drizzle")) },
    evidenceSnapshotKey: EVIDENCE_SNAPSHOT_KEY,
  };
  const writeJson = async (path: string, body: unknown) => {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  };
  try {
    const report = await runBackfill(config, {
      coverage: (level) => {
        const client = new MlbClient({ concurrency: 1, retainBodies: false });
        return discoverCoverage((p, q) => client.get(p, q), args.season, level, args.gameTypes);
      },
      ingest: (r: IngestRequest) => {
        if (r.apply && !args.apply) throw new Error("refusing to write without --apply");
        sink ??= new PostgresIngestionSink(url!, { signal: interrupt.signal });
        return runMilbIngestion(
          {
            season: args.season,
            levels: [r.level],
            mode: r.mode,
            ...(r.from && r.to ? { from: r.from, to: r.to } : {}),
            apply: r.apply,
            incremental: false,
            refetchComplete: r.refetchComplete ?? false,
            chunkDays: 7,
            concurrency: args.concurrency,
            lookbackDays: 3,
            refetchWindowDays: 3,
            rosterType: "fullSeason",
            gameTypes: args.gameTypes,
          },
          { sink },
        );
      },
      query: db.query,
      loadState: async () =>
        existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as BackfillState) : null,
      saveState: (state) => writeJson(statePath, state),
      writeReport: (name, body) => writeJson(join(args.runDir, name), body),
      integrityReport: async (name) =>
        writeFile(join(args.runDir, name), await db.file(join(ROOT, "scripts/sql/milb-integrity-checks.sql")), { mode: 0o600 }),
      log: (event, fields) => progress(event, fields),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => new Date(),
      interrupted: () => interrupted,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === "refused" ? 2 : report.status === "stopped" ? 1 : 0;
  } finally {
    await sink?.close();
    await release();
  }
}

main()
  .catch((error: unknown) => {
    const message = redact(error instanceof Error ? error.message : String(error));
    progress("backfill:error", { message, guard: error instanceof TargetGuardError });
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  })
  .finally(() => stopHeartbeat());
