/**
 * Read-only performance profile of the site's data layer on the Neon TEST branch: per-level load
 * time (sequential, then all levels in parallel as the site does) and the compute time of each
 * page's view models, cold (first call on a fresh snapshot) and warm (memoized).
 *
 *   npm run -s profile:site > ~/pt-runs/site-profile.json
 *
 * Sessions are forced read-only at the server; credentials are never printed.
 */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../src/db/schema";
import { checkWriteTarget } from "../../src/ingestion/db-target";
import { redact } from "../../src/ingestion/progress";
import { dbLevelLoader, loadCompetition } from "../../src/services/competition/load";
import { LEVEL_IDS } from "../../src/services/players/levels";
import { profilePages } from "../../src/services/competition/profile";

const APPROVED_ENDPOINT = "ep-spring-cake-ak5jqlqp";
const SEASON = 2026;

for (const key of Object.keys(process.env))
  if (key === "DATABASE_URL" || key.startsWith("PG")) delete process.env[key];

const secs = (ms: number) => Math.round(ms) / 1000;

async function main() {
  const url = process.env.INGESTION_DATABASE_URL;
  checkWriteTarget(url, { endpoint: APPROVED_ENDPOINT, database: "neondb" });
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.PROFILE_POOL_MAX ?? 5),
    options: "-c default_transaction_read_only=on",
    connectionTimeoutMillis: 30_000,
  });
  try {
    const db = drizzle(pool, { schema });
    const loader = dbLevelLoader(db, SEASON);
    await pool.query("select 1"); // connection warm-up is not part of any page
    const sequential: Record<string, number> = {};
    if (!process.env.PROFILE_SKIP_SEQUENTIAL)
      for (const level of LEVEL_IDS) {
        const t = performance.now();
        await loader(level);
        sequential[level] = secs(performance.now() - t);
        process.stderr.write(`[profile] ${level} loaded alone in ${sequential[level]}s\n`);
      }
    const t = performance.now();
    const result = await loadCompetition(loader);
    const parallel = secs(performance.now() - t);
    process.stderr.write(`[profile] all levels in parallel: ${parallel}s\n`);
    const pages = profilePages(result);
    process.stdout.write(`${JSON.stringify({ season: SEASON, load: { sequential, parallel }, pages }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[profile] ${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 2;
});
