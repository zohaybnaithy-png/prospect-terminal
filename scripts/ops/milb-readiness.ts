/**
 * Read-only analytics readiness check for every level (AFL + Triple-A … Single-A) on the Neon
 * TEST branch. Loads levels through the site's own loader (READ ONLY, REPEATABLE READ
 * transactions) on a pool whose sessions are also forced read-only, then runs the page view
 * models (directory, Momentum 7/14/30-day windows, trending, profiles). See
 * src/services/competition/readiness.ts.
 *
 *   npm run -s check:milb:readiness > ~/pt-runs/readiness.json
 *
 * Exit code 1 when a level reports a problem. Credentials are never printed.
 */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../src/db/schema";
import { checkWriteTarget } from "../../src/ingestion/db-target";
import { redact } from "../../src/ingestion/progress";
import { dbLevelLoader, loadCompetition } from "../../src/services/competition/load";
import { readinessReport } from "../../src/services/competition/readiness";

const APPROVED_ENDPOINT = "ep-spring-cake-ak5jqlqp";
const SEASON = 2026;

for (const key of Object.keys(process.env))
  if (key === "DATABASE_URL" || key.startsWith("PG")) delete process.env[key];

async function main() {
  const url = process.env.INGESTION_DATABASE_URL;
  // Same strict target rules as the writer, even though this only reads.
  checkWriteTarget(url, { endpoint: APPROVED_ENDPOINT, database: "neondb" });
  const pool = new Pool({
    connectionString: url,
    max: 5,
    // Every session is read-only at the server, in addition to the loader's READ ONLY transactions.
    options: "-c default_transaction_read_only=on",
    connectionTimeoutMillis: 30_000,
  });
  try {
    const started = Date.now();
    const result = await loadCompetition(dbLevelLoader(drizzle(pool, { schema }), SEASON), (level, error) =>
      process.stderr.write(`[readiness] ${level} failed to load (${(error as { code?: string })?.code ?? "error"})\n`),
    );
    process.stderr.write(`[readiness] loaded in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    const report = readinessReport(result);
    process.stdout.write(`${JSON.stringify({ season: SEASON, loadSeconds: (Date.now() - started) / 1000, ...report }, null, 2)}\n`);
    if (report.problems.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[readiness] ${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 2;
});
