import { resolve } from "node:path";
import { AflFixtureAdapter } from "../src/ingestion/sources/afl-fixture";
import { MLBStatsApiSource } from "../src/ingestion/sources/mlb-stats-api";
import { parseIngestionArgs } from "../src/ingestion/cli-options";
import { ingest } from "../src/ingestion/runner";
import { PostgresIngestionSink } from "../src/ingestion/postgres-sink";
async function main() {
  const args = parseIngestionArgs(process.argv.slice(2));
  const url = process.env.INGESTION_DATABASE_URL;
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
  const sink = url ? new PostgresIngestionSink(url) : undefined;
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
    await sink?.close();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "AFL ingestion failed",
  );
  process.exitCode = 1;
});
