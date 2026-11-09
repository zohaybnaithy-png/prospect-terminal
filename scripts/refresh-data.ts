/**
 * Scheduled data refresh (docs/DATA-REFRESH.md): MiLB structure + incremental games and the AFL
 * capture, as one job under a database advisory lock, with bounded retries and a deadline.
 *
 *   npm run -s refresh:data                         # dry run: plan + previews, writes nothing
 *   npm run -s refresh:data -- --apply              # what the timer runs
 *   npm run -s refresh:data -- --apply --sources=milb --force   # outside the season window
 *
 * Options: --season=YYYY (default: this year) --sources=milb,afl --apply --force
 *          --max-attempts=3 --retry-delays=60,300 (seconds) --timeout-minutes=45
 *          --max-lock-hold-minutes=120 (another holder longer than this → locked-stale, exit 1)
 *          --log-dir=<dir> (JSONL job log; default ~/pt-runs/refresh)
 * Env: INGESTION_DATABASE_URL (writer; required), PT_SEASON_WINDOWS (optional, e.g.
 *      milb=03-20..10-05,afl=10-03..11-25), PT_REFRESH_PING_URL (optional https URL pinged on
 *      success, `<url>/fail` on failure: a dead-man's switch such as a healthchecks.io check).
 * Exit: 0 done, nothing due, or normal overlap (another job holds the lock); 1 failed, timed out,
 *       aborted, lock held too long (locked-stale), or a fatal error (status "error"; also pinged).
 * stdout: the job record (JSON); stderr: progress. Never prints credentials.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { DEFAULT_REFRESH, jobExitCode, pingKind, runRefreshJob, type JobRecord } from "../src/ingestion/refresh/job";
import { lockHolderAgeMs, PgJobLock } from "../src/ingestion/refresh/lock";
import { lastStructureAppliedAt, recoverAbandonedRuns } from "../src/ingestion/refresh/freshness";
import { pipelineSteps } from "../src/ingestion/refresh/steps";
import { progress, redact, setProgressReporter, stderrReporter } from "../src/ingestion/progress";
import { seasonWindowsFromEnv, type RefreshSource } from "../src/ingestion/refresh/schedule";

setProgressReporter(stderrReporter());

export function parseRefreshArgs(argv: string[], now = new Date()) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`Unexpected argument ${a}`);
    if (m[2] === undefined) flags.add(m[1]);
    else values.set(m[1], m[2]);
  }
  const known = new Set(["season", "sources", "apply", "force", "max-attempts", "retry-delays", "timeout-minutes", "max-lock-hold-minutes", "log-dir"]);
  for (const k of [...values.keys(), ...flags]) if (!known.has(k)) throw new Error(`Unknown option --${k}`);
  const sources = z
    .array(z.enum(["milb", "afl"]))
    .min(1)
    .parse((values.get("sources") ?? "milb,afl").split(",")) as RefreshSource[];
  return {
    season: z.coerce.number().int().min(2005).max(2200).parse(values.get("season") ?? String(now.getUTCFullYear())),
    sources: [...new Set(sources)],
    apply: flags.has("apply"),
    force: flags.has("force"),
    maxAttempts: z.coerce.number().int().min(1).max(10).parse(values.get("max-attempts") ?? String(DEFAULT_REFRESH.maxAttempts)),
    retryDelaysMs: values.has("retry-delays")
      ? z.array(z.coerce.number().min(0).max(3600)).min(1).parse(values.get("retry-delays")!.split(",")).map((s) => s * 1000)
      : DEFAULT_REFRESH.retryDelaysMs,
    timeoutMs: z.coerce.number().min(1).max(240).parse(values.get("timeout-minutes") ?? String(DEFAULT_REFRESH.timeoutMs / 60_000)) * 60_000,
    structureMaxAgeHours: DEFAULT_REFRESH.structureMaxAgeHours,
    abandonedAfterMs: DEFAULT_REFRESH.abandonedAfterMs,
    maxLockHoldMs: z.coerce.number().min(1).max(24 * 60).parse(values.get("max-lock-hold-minutes") ?? String(DEFAULT_REFRESH.maxLockHoldMs / 60_000)) * 60_000,
    logDir: resolve(values.get("log-dir") ?? join(homedir(), "pt-runs", "refresh")),
  };
}

/** Credential-free error description: an error code or class name, never the message's details. */
function coarseError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const name = error instanceof Error ? error.name : "Error";
  const known = error instanceof Error && /^refresh:data needs|Unknown option|Unexpected argument/.test(error.message) ? error.message.slice(0, 120) : "";
  return [name, code, known].filter(Boolean).join(": ").slice(0, 160);
}

async function ping(record: Pick<JobRecord, "status" | "apply"> & { error?: string }, env: Record<string, string | undefined>, fetcher: typeof fetch) {
  const url = env.PT_REFRESH_PING_URL;
  const kind = pingKind(record);
  if (!url || !/^https:\/\//.test(url) || !kind) return;
  try {
    await fetcher(kind === "success" ? url : `${url.replace(/\/$/, "")}/fail`, {
      method: "POST",
      body: JSON.stringify({ status: record.status, ...(record.error ? { error: record.error } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    progress("refresh:ping-failed"); // never fails the job
  }
}

function writeLog(logDir: string, record: object, quiet: boolean) {
  try {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    appendFileSync(join(logDir, "jobs.jsonl"), `${JSON.stringify(record)}\n`);
    writeFileSync(join(logDir, "last-job.json"), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    progress("refresh:log-write-failed");
  }
  if (!quiet) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

/**
 * The whole CLI as a function (tests call it directly). EVERY outcome is recorded and, when a ping
 * URL is configured, notified: job outcomes as before, and fatal errors (bad arguments, missing
 * configuration, database unreachable, lock connection failure, unexpected orchestration errors)
 * as status "error" with a `/fail` ping. Returns the exit code.
 */
export async function runRefreshCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  deps: { fetch?: typeof fetch; quiet?: boolean; interrupt?: AbortSignal } = {},
): Promise<number> {
  const fetcher = deps.fetch ?? fetch;
  const startedAt = new Date().toISOString();
  // The log directory is needed even when the other arguments are invalid.
  const logDirArg = argv.find((a) => a.startsWith("--log-dir="))?.slice("--log-dir=".length);
  let logDir = resolve(logDirArg ?? join(homedir(), "pt-runs", "refresh"));
  let apply = argv.includes("--apply");
  let pool: Pool | undefined;
  try {
    const o = { ...parseRefreshArgs(argv), windows: seasonWindowsFromEnv(env) };
    logDir = o.logDir;
    apply = o.apply;
    const url = env.INGESTION_DATABASE_URL;
    if (!url) throw new Error("refresh:data needs INGESTION_DATABASE_URL (the writer role)");
    pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 15_000 });
    pool.on("error", () => {}); // an idle client's error must not crash the process
    const lock = new PgJobLock(url);
    const record = await runRefreshJob(o, {
      // Dry runs never take the writers' lock (they must not block or be blocked by real runs).
      lock: o.apply ? lock : { acquire: async () => true, release: async () => {} },
      steps: pipelineSteps({ url, season: o.season, apply: o.apply }),
      lastStructureAppliedAt: () => lastStructureAppliedAt(pool!, o.season),
      recoverAbandoned: (ms) => recoverAbandonedRuns(pool!, ms),
      lockHolderAgeMs: () => lockHolderAgeMs((sql) => pool!.query(sql)),
      lockLost: lock.lostSignal,
      ...(deps.interrupt ? { interrupt: deps.interrupt } : {}),
      log: (event, data) => progress(event, data),
    });
    writeLog(logDir, record, !!deps.quiet);
    await ping(record, env, fetcher);
    return jobExitCode(record);
  } catch (error) {
    const record = {
      jobId: `${startedAt}-error`,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "error" as const,
      apply,
      error: coarseError(error),
    };
    progress("refresh:fatal", { error: record.error });
    if (!deps.quiet) process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    writeLog(logDir, record, !!deps.quiet);
    await ping(record, env, fetcher);
    return 1;
  } finally {
    await pool?.end().catch(() => {});
  }
}

if (process.argv[1] && /refresh-data\.ts$/.test(process.argv[1])) {
  let interrupted = false;
  const interrupt = new AbortController();
  process.on("SIGTERM", () => interrupt.abort(new Error("terminated")));
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    interrupt.abort(new Error("interrupted"));
  });
  runRefreshCli(process.argv.slice(2), process.env, { interrupt: interrupt.signal }).then((code) => {
    process.exitCode = code;
  });
}
