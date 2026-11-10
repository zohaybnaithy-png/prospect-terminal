/**
 * MiLB ingestion CLI (Triple-A, Double-A, High-A, Single-A) over the MLB Stats API.
 * Diagnostics go to stderr; stdout carries only the final JSON summary.
 *
 *   npm run ingest:milb -- --season=2026 --level=aaa --dry-run            # live, read-only
 *   npm run ingest:milb -- --source=fixture                               # offline synthetic dry run
 *   npm run ingest:milb -- --season=2026 --apply                          # backfill (structure + 7-day game chunks)
 *   npm run ingest:milb -- --season=2026 --incremental --apply            # daily update
 *
 * See docs/MILB-INGESTION.md.
 */
import { parseMilbArgs } from "../src/ingestion/cli-options";
import { runMilbIngestion } from "../src/ingestion/milb-runner";
import { PostgresIngestionSink } from "../src/ingestion/postgres-sink";
import { requireJobLock } from "../src/ingestion/refresh/lock";
import { milbFixtureFetch } from "../src/ingestion/fixtures/milb-synthetic";
import {
  beginStage,
  progress,
  redact,
  setProgressReporter,
  startHeartbeat,
  stderrReporter,
} from "../src/ingestion/progress";

setProgressReporter(stderrReporter());
const stopHeartbeat = startHeartbeat();
const interrupt = new AbortController();
let sink: PostgresIngestionSink | undefined;
let releaseJobLock: (() => Promise<void>) | undefined;

async function main() {
  const args = parseMilbArgs(process.argv.slice(2));
  beginStage("cli:start", { pid: process.pid, node: process.version });
  progress("cli:args", {
    source: args.source,
    season: args.season,
    levels: args.levels.join(","),
    mode: args.mode,
    apply: args.apply,
    incremental: args.incremental,
    from: args.from,
    to: args.to,
    chunkDays: args.chunkDays,
  });
  const url = process.env.INGESTION_DATABASE_URL;
  progress("cli:config", { database: url ? "configured" : "not-configured" });
  if ((args.apply || args.incremental) && !url)
    throw new Error("--apply/--incremental require INGESTION_DATABASE_URL pointing to a migrated PostgreSQL database");
  // The synthetic fixture never touches a database, even for a read-only preview.
  sink = url && args.source === "live" ? new PostgresIngestionSink(url, { signal: interrupt.signal }) : undefined;
  // Writes never overlap the scheduled refresh or another apply (docs/DATA-REFRESH.md).
  releaseJobLock = args.apply && url && args.source === "live" ? await requireJobLock(url) : undefined;
  const summary = await runMilbIngestion(args, {
    sink,
    ...(args.source === "fixture"
      ? { fetcher: milbFixtureFetch().fetcher, sleep: async () => {}, clock: () => new Date(`${args.season}-06-01T12:00:00Z`) }
      : {}),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status === "failed") process.exitCode = 1;
}

let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  progress("cli:interrupt", { applying: sink?.applying ?? false });
  interrupt.abort();
});

main()
  .catch((error: unknown) => {
    progress("cli:error", { message: redact(error instanceof Error ? error.message : String(error)) });
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    stopHeartbeat();
    await sink?.close();
    await releaseJobLock?.().catch(() => {});
  });
