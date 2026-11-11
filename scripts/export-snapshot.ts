/**
 * Build-time data snapshot (docs/VERCEL.md, *Build-time data snapshot*).
 *
 *   npm run -s snapshot:export                     # writes .data-snapshot/, JSON report on stdout
 *   PT_SNAPSHOT_DIR=/tmp/snap npm run -s snapshot:export
 *
 * Reads every competition level ONCE through the site's own read layer, all inside ONE READ ONLY,
 * REPEATABLE READ transaction (one database snapshot for every level and the ingestion version;
 * src/services/competition/consistent-read.ts), and writes the files a `PT_DATA_SOURCE=snapshot`
 * server serves from. Run by `npm run build:vercel` before `next build`, so the deployment never
 * queries the database while serving pages.
 *
 * Uses DATABASE_URL: give it the SELECT-only web role (`pt_web`, deploy/neon-readonly-role.sql),
 * never a writer or owner credential. The connection string is never printed; errors report only
 * a redacted message. Progress goes to stderr, the final JSON report to stdout.
 * Exit: 0 written and verified; 1 failed (nothing written, any earlier snapshot removed).
 */
import { rm } from "node:fs/promises";
import { closeDatabase, getDatabase } from "../src/db/client";
import { AFL } from "../src/ingestion/sources/mlb-config";
import { redact } from "../src/ingestion/progress";
import { snapshotDir } from "../src/services/competition/data-source";
import { databaseConsistentRead } from "../src/services/competition/consistent-read";
import { exportSnapshots } from "../src/services/competition/snapshot-export";

const log = (line: string) => process.stderr.write(`[snapshot] ${line}\n`);

async function main() {
  if (process.argv.length > 2) throw new Error(`Unexpected argument ${process.argv[2]} (configure with PT_SNAPSHOT_DIR)`);
  if (!process.env.DATABASE_URL) throw new Error("snapshot:export needs DATABASE_URL (the read-only pt_web role)");
  const dir = snapshotDir();
  const db = getDatabase();
  try {
    log(`exporting season ${AFL.defaultSeason} to ${dir}`);
    const report = await exportSnapshots({
      dir,
      season: AFL.defaultSeason,
      // One READ ONLY, REPEATABLE READ transaction for the version and every level.
      read: databaseConsistentRead(db, AFL.defaultSeason),
      log,
    });
    log(`done: ${(report.totalBytes / 1e6).toFixed(1)} MB in ${(report.durationMs / 1000).toFixed(1)} s`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    // A build must never ship an old snapshot after a failed export.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await closeDatabase().catch(() => {});
  }
}

main().catch((error: unknown) => {
  log(`failed: ${redact(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
});
