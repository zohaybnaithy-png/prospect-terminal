import { resolve } from "node:path";
import { AflFixtureAdapter } from "../src/ingestion/sources/afl-fixture";
import { MLBStatsApiSource } from "../src/ingestion/sources/mlb-stats-api";
import { parseIngestionArgs } from "../src/ingestion/cli-options";
import { ingest } from "../src/ingestion/runner";
import { PostgresIngestionSink } from "../src/ingestion/postgres-sink";
import { requireJobLock } from "../src/ingestion/refresh/lock";
import {
  beginStage,
  progress,
  redact,
  setProgressReporter,
  startHeartbeat,
  stderrReporter,
} from "../src/ingestion/progress";
// Diagnostics go to stderr only; stdout carries nothing but the final JSON report.
setProgressReporter(stderrReporter());
const stopHeartbeat = startHeartbeat();
beginStage("cli:start", { pid: process.pid, node: process.version });
const interrupt = new AbortController();
let sink: PostgresIngestionSink | undefined;
async function main() {
  const args = parseIngestionArgs(process.argv.slice(2));
  progress("cli:args", {
    source: args.source,
    season: args.season,
    mode: args.mode,
    apply: args.apply,
    from: args.from,
    to: args.to,
    team: args.team,
    recordDir: args.recordDir !== undefined,
  });
  const url = process.env.INGESTION_DATABASE_URL;
  progress("cli:config", {
    database: url ? "configured" : "not-configured",
    ...(url ? { pooledEndpoint: /-pooler\./.test(url) } : {}),
  });
  if (args.apply && !url)
    throw new Error(
      "--apply requires INGESTION_DATABASE_URL pointing to a migrated PostgreSQL database",
    );
  if (
    args.source === "fixture" &&
    args.apply &&
    process.env.NODE_ENV === "production"
  )
    throw new Error("Fictional fixtures must not be applied in production");
  const adapter =
    args.source === "fixture"
      ? new AflFixtureAdapter(resolve("src/ingestion/fixtures/afl.json"))
      : new MLBStatsApiSource({
          season: args.season,
          from: args.from,
          to: args.to,
          team: args.team,
          mode: args.mode,
          recordDir: args.recordDir,
        });
  sink = url
    ? new PostgresIngestionSink(url, { signal: interrupt.signal })
    : undefined;
  // Writes never overlap the scheduled refresh or another apply (docs/DATA-REFRESH.md).
  const releaseJobLock = args.apply && url ? await requireJobLock(url) : undefined;
  try {
    const report = await ingest(adapter, sink, { dryRun: !args.apply });
    console.log(
      JSON.stringify(
        {
          ...report,
          source: args.source,
          season: args.season,
          ...(!args.apply && !sink
            ? {
                note: "Validated upsert candidates only; database insert/update comparison requires INGESTION_DATABASE_URL. No database writes performed.",
              }
            : {}),
        },
        null,
        2,
      ),
    );
    if (report.issues > 0) process.exitCode = 2;
  } finally {
    if (sink) {
      beginStage("db:close");
      await sink.close();
      progress("db:closed");
    }
    await releaseJobLock?.().catch(() => {});
  }
}
// First Ctrl+C rolls back an in-flight apply (marking its run failed); a second one exits immediately.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (interrupt.signal.aborted || !sink?.applying) {
      progress("cli:exit", { signal, code: 130 });
      process.exit(130);
    }
    progress("cli:interrupt", {
      signal,
      action: "rolling back apply; send again to force exit",
    });
    interrupt.abort();
  });
main()
  .catch((error) => {
    console.error(
      redact(error instanceof Error ? error.message : "AFL ingestion failed"),
    );
    process.exitCode = 1;
  })
  .finally(() => {
    stopHeartbeat();
    progress("cli:exit", { code: Number(process.exitCode ?? 0) });
  });
