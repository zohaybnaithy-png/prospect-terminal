/**
 * Precomputed view models for the build-time snapshot (docs/VERCEL.md, *Precomputed view models*).
 *
 *   npm run -s snapshot:views                      # after snapshot:export; JSON report on stdout
 *   PT_SNAPSHOT_DIR=/tmp/snap npm run -s snapshot:views
 *
 * Reads the snapshot files only (no database, no network) and writes `<snapshot>/views/`. Run by
 * `npm run build:vercel` between `snapshot:export` and `next build`; `next build` then refuses
 * views computed from different source code. Progress goes to stderr, the JSON report to stdout.
 * Exit: 0 written and verified; 1 failed (no views left: the site computes live).
 */
import path from "node:path";
import { AFL } from "../src/ingestion/sources/mlb-config";
import { snapshotDir } from "../src/services/competition/data-source";
import { writeSnapshotViews } from "../src/services/competition/views-build";
import { sourceFingerprint } from "../src/services/competition/views-fingerprint";

const log = (line: string) => process.stderr.write(`[snapshot-views] ${line}\n`);

async function main() {
  if (process.argv.length > 2) throw new Error(`Unexpected argument ${process.argv[2]} (configure with PT_SNAPSHOT_DIR)`);
  const dir = snapshotDir();
  log(`computing view models for ${dir}`);
  const report = await writeSnapshotViews(dir, {
    season: AFL.defaultSeason,
    fingerprint: sourceFingerprint(path.resolve(import.meta.dirname, "..")),
    log,
  });
  log(`done: ${(report.totalBytes / 1e6).toFixed(2)} MB in ${(report.durationMs / 1000).toFixed(1)} s`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  log(`failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`);
  process.exitCode = 1;
});
