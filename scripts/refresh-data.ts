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
 *          --log-dir=<dir> (JSONL job log; default ~/pt-runs/refresh)
 * Env: INGESTION_DATABASE_URL (writer; required), PT_REFRESH_PING_URL (optional https URL pinged on
 *      success, `<url>/fail` on failure: a dead-man's switch such as a healthchecks.io check).
 * Exit: 0 done, nothing due, or another job holds the lock; 1 failed/timed out (see the log).
 * stdout: the job record (JSON); stderr: progress. Never prints credentials.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { DEFAULT_REFRESH, jobExitCode, runRefreshJob, type JobRecord } from "../src/ingestion/refresh/job";
import { PgJobLock } from "../src/ingestion/refresh/lock";
import { lastStructureAppliedAt, recoverAbandonedRuns } from "../src/ingestion/refresh/freshness";
import { pipelineSteps } from "../src/ingestion/refresh/steps";
import { progress, redact, setProgressReporter, stderrReporter } from "../src/ingestion/progress";
import type { RefreshSource } from "../src/ingestion/refresh/schedule";

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
  const known = new Set(["season", "sources", "apply", "force", "max-attempts", "retry-delays", "timeout-minutes", "log-dir"]);
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
    logDir: resolve(values.get("log-dir") ?? join(homedir(), "pt-runs", "refresh")),
  };
}

async function ping(record: JobRecord) {
  const url = process.env.PT_REFRESH_PING_URL;
  if (!url || !/^https:\/\//.test(url) || record.status === "locked" || !record.apply) return;
  const ok = jobExitCode(record) === 0;
  try {
    await fetch(ok ? url : `${url.replace(/\/$/, "")}/fail`, { method: "POST", body: JSON.stringify({ status: record.status }), signal: AbortSignal.timeout(10_000) });
  } catch {
    progress("refresh:ping-failed"); // never fails the job
  }
}

async function main() {
  const o = parseRefreshArgs(process.argv.slice(2));
  const url = process.env.INGESTION_DATABASE_URL;
  if (!url) throw new Error("refresh:data needs INGESTION_DATABASE_URL (the writer role)");
  const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 15_000 });
  const lock = new PgJobLock(url);
  let interrupted = false;
  const interrupt = new AbortController();
  process.on("SIGTERM", () => interrupt.abort(new Error("terminated")));
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    interrupt.abort(new Error("interrupted"));
  });
  try {
    const record = await runRefreshJob(o, {
      // Dry runs never take the writers' lock (they must not block or be blocked by real runs).
      lock: o.apply ? lock : { acquire: async () => true, release: async () => {} },
      steps: pipelineSteps({ url, season: o.season, apply: o.apply }),
      lastStructureAppliedAt: () => lastStructureAppliedAt(pool, o.season),
      recoverAbandoned: (ms) => recoverAbandonedRuns(pool, ms),
      lockLost: AbortSignal.any([lock.lostSignal, interrupt.signal]),
      log: (event, data) => progress(event, data),
    });
    mkdirSync(o.logDir, { recursive: true, mode: 0o700 });
    appendFileSync(join(o.logDir, "jobs.jsonl"), `${JSON.stringify(record)}\n`);
    writeFileSync(join(o.logDir, "last-job.json"), `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    await ping(record);
    process.exitCode = jobExitCode(record);
  } finally {
    await pool.end().catch(() => {});
  }
}

if (process.argv[1] && /refresh-data\.ts$/.test(process.argv[1]))
  main().catch((error: unknown) => {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
