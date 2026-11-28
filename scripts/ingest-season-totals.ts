/**
 * Season-totals ingestion CLI (D-030, T-503): MiLB history and MLB outcomes for the Prospect Grade.
 * Diagnostics go to stderr; stdout carries only the final JSON summary.
 *
 *   node --import tsx scripts/ingest-season-totals.ts --scope=milb --seasons=2014           # offline: no database, normalize only
 *   INGESTION_DATABASE_URL=… node --import tsx scripts/ingest-season-totals.ts --scope=milb --seasons=2012-2019,2021   # read-only preview
 *   INGESTION_DATABASE_URL=… node --import tsx scripts/ingest-season-totals.ts --scope=mlb --seasons=2013-2026 --apply # writes (owner approval only)
 *
 * One capture and one transaction per season. --apply first previews each season read-only and refuses to write a
 * season whose preview has issues, unless --accept-quarantine (quarantined rows are skipped, the rest applied).
 * Shared-database applies need explicit owner approval in the conversation (CLAUDE.md).
 */
import { ingest, type IngestionReport } from "../src/ingestion/runner";
import { PostgresIngestionSink } from "../src/ingestion/postgres-sink";
import { requireJobLock } from "../src/ingestion/refresh/lock";
import { MLB_SOURCE_ID } from "../src/ingestion/sources/mlb-config";
import { SeasonTotalsStatsApiSource, type SeasonTotalsScope } from "../src/ingestion/sources/season-totals-stats-api";
import { beginStage, progress, redact, setProgressReporter, startHeartbeat, stderrReporter } from "../src/ingestion/progress";

let stopHeartbeat: (() => void) | undefined;
let sink: PostgresIngestionSink | undefined;
let releaseJobLock: (() => Promise<void>) | undefined;

export function parseSeasons(value: string): number[] {
  const out = new Set<number>();
  for (const part of value.split(",")) {
    const m = /^(\d{4})(?:-(\d{4}))?$/.exec(part.trim());
    if (!m) throw new Error(`--seasons: "${part}" is not a year or a year range`);
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    if (b < a || b - a > 30) throw new Error(`--seasons: bad range ${part}`);
    for (let y = a; y <= b; y++) out.add(y);
  }
  return [...out].sort((x, y) => x - y);
}

function parseArgs(argv: string[]) {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const known = new Set(["scope", "seasons", "apply", "accept-quarantine"]);
  for (const a of argv) {
    const name = a.replace(/^--/, "").split("=")[0];
    if (!a.startsWith("--") || !known.has(name)) throw new Error(`Unknown argument ${a}`);
  }
  const scope = get("scope");
  if (scope !== "milb" && scope !== "mlb") throw new Error("--scope=milb or --scope=mlb is required");
  const seasons = get("seasons");
  if (!seasons) throw new Error("--seasons=YYYY[,YYYY-YYYY] is required");
  return {
    scope: scope as SeasonTotalsScope,
    // 2020 had no MiLB season; it is skipped rather than failing a range.
    seasons: parseSeasons(seasons).filter((y) => !(scope === "milb" && y === 2020)),
    apply: argv.includes("--apply"),
    acceptQuarantine: argv.includes("--accept-quarantine"),
  };
}

const brief = (r: IngestionReport) => ({
  status: r.status,
  records: r.records,
  issues: r.issues,
  ...(r.operations ? { operations: r.operations } : {}),
  ...(r.databaseComparison ? { databaseComparison: r.databaseComparison } : {}),
  ...(r.changed !== undefined ? { changed: r.changed, unchanged: r.unchanged } : {}),
  ...(r.runId ? { runId: r.runId } : {}),
  ...(r.diagnostics?.length ? { diagnostics: r.diagnostics.slice(0, 20) } : {}),
  contentHash: r.contentHash,
  rawContentHash: r.rawContentHash,
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  beginStage("cli:start", { pid: process.pid, node: process.version });
  const url = process.env.INGESTION_DATABASE_URL;
  progress("cli:args", { scope: args.scope, seasons: args.seasons.join(","), apply: args.apply, database: url ? "configured" : "not-configured" });
  if (args.apply && !url) throw new Error("--apply requires INGESTION_DATABASE_URL pointing to a migrated PostgreSQL database");
  sink = url ? new PostgresIngestionSink(url) : undefined;
  releaseJobLock = args.apply && url ? await requireJobLock(url) : undefined;
  const results: Record<string, unknown>[] = [];
  let failed = false;
  for (const season of args.seasons) {
    beginStage("season-totals:season", { scope: args.scope, season });
    try {
      const knownPlayers = sink ? new Set([...(await sink.knownExternalIds(MLB_SOURCE_ID, "player"))].map(Number)) : undefined;
      const source = () => new SeasonTotalsStatsApiSource({ season, scope: args.scope }, { knownPlayers });
      const preview = await ingest(source(), sink, { dryRun: true });
      if (!args.apply) {
        results.push({ season, mode: sink ? "preview" : "offline", ...brief(preview) });
        continue;
      }
      if (preview.issues && !args.acceptQuarantine) {
        results.push({ season, mode: "apply-refused", reason: "preview has issues; review them or pass --accept-quarantine", ...brief(preview) });
        failed = true;
        break;
      }
      const applied = await ingest(source(), sink);
      results.push({ season, mode: "apply", ...brief(applied) });
      if (applied.status === "quarantined") {
        failed = true;
        break;
      }
    } catch (error) {
      results.push({ season, mode: "failed", error: redact(error instanceof Error ? error.message : String(error)) });
      failed = true;
      break;
    }
  }
  process.stdout.write(`${JSON.stringify({ scope: args.scope, status: failed ? "failed" : "complete", seasons: results }, null, 2)}\n`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("ingest-season-totals.ts")) {
  setProgressReporter(stderrReporter());
  stopHeartbeat = startHeartbeat();
  main()
    .catch((error: unknown) => {
      process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      stopHeartbeat?.();
      await releaseJobLock?.().catch(() => {});
      await sink?.close();
    });
}
