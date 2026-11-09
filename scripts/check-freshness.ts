/**
 * Read-only data-freshness check for operators and monitoring (docs/DATA-REFRESH.md).
 *
 *   npm run -s check:freshness                 # JSON report on stdout
 *   npm run -s check:freshness -- --season=2026 --max-success-age-hours=36 --max-game-age-days=4
 *
 * Uses INGESTION_DATABASE_URL or, if unset, DATABASE_URL (the read-only web role is enough): every
 * query runs in a READ ONLY transaction that is rolled back.
 * Exit: 0 ok (fresh, or off-season); 1 stale or needs attention (reasons listed); 2 could not check.
 */
import { Pool } from "pg";
import { z } from "zod";
import { DEFAULT_REFRESH } from "../src/ingestion/refresh/job";
import { assessFreshness, DEFAULT_FRESHNESS, freshnessExitCode, readFreshnessFacts } from "../src/ingestion/refresh/freshness";
import { redact } from "../src/ingestion/progress";

async function main() {
  const values = new Map(
    process.argv.slice(2).map((a) => {
      const m = /^--([a-z-]+)=(.*)$/.exec(a);
      if (!m || !["season", "max-success-age-hours", "max-game-age-days"].includes(m[1])) throw new Error(`Unexpected argument ${a}`);
      return [m[1], m[2]] as const;
    }),
  );
  const url = process.env.INGESTION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("check:freshness needs INGESTION_DATABASE_URL or DATABASE_URL");
  const now = new Date();
  const season = z.coerce.number().int().min(2005).max(2200).parse(values.get("season") ?? String(now.getUTCFullYear()));
  const policy = {
    maxSuccessAgeHours: z.coerce.number().positive().parse(values.get("max-success-age-hours") ?? String(DEFAULT_FRESHNESS.maxSuccessAgeHours)),
    maxGameAgeDays: z.coerce.number().int().min(0).parse(values.get("max-game-age-days") ?? String(DEFAULT_FRESHNESS.maxGameAgeDays)),
  };
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
  try {
    const report = assessFreshness(await readFreshnessFacts(pool, { season, now, abandonedAfterMs: DEFAULT_REFRESH.abandonedAfterMs }), policy);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.reasons.length) process.stderr.write(`[freshness] ${report.verdict}: ${report.reasons.join("; ")}\n`);
    process.exitCode = freshnessExitCode(report);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[freshness] could not check: ${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 2;
});
