/**
 * Offline similarity validation (docs/SIMILARITY-METHOD.md §6, approved D-024, T-406). Reads the build-time snapshot
 * files only: no database connection, no network, nothing written except the report on stdout.
 *
 *   node --import tsx scripts/similarity-validate.ts > report.md            # reads .data-snapshot/ (PT_SNAPSHOT_DIR)
 *   node --import tsx scripts/similarity-validate.ts --appendix > lists.md  # face-validity lists for the review
 *   node --import tsx scripts/similarity-validate.ts --synthetic [--null]   # fictional data, exercises the pipeline
 *
 * Options: --level aa (one level). Owner-option comparisons only (the approved defaults are used without them):
 * --min-sample N, --no-age, --mahalanobis. Choosing among them after seeing real-data results is not allowed.
 * Progress goes to stderr.
 */
import path from "node:path";
import { SIMILARITY_SETTINGS, type SimilarityRole, type SimilaritySettings } from "../src/analytics/similarity/config";
import { renderFaceValidityAppendix, renderValidationReport, validateRole, type RoleValidation } from "../src/analytics/similarity/validate";
import { COMPETITION_LEVEL_LABELS, MILB_LEVEL_IDS, type MilbLevelId } from "../src/domain/levels";
import { AFL } from "../src/ingestion/sources/mlb-config";
import { snapshotDir } from "../src/services/competition/data-source";
import { snapshotSource } from "../src/services/competition/snapshot-store";
import type { AflSnapshot } from "../src/services/afl/types";
import { syntheticSeason } from "./similarity-synthetic";

const log = (line: string) => process.stderr.write(`[similarity] ${line}\n`);
const has = (name: string) => process.argv.includes(`--${name}`);
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const synthetic = has("synthetic");
  const only = arg("level");
  if (only && !MILB_LEVEL_IDS.includes(only as MilbLevelId)) throw new Error(`--level must be one of ${MILB_LEVEL_IDS.join(", ")}`);
  const minRaw = arg("min-sample");
  const minSample = minRaw === undefined ? SIMILARITY_SETTINGS.minSample : Number(minRaw);
  if (!Number.isInteger(minSample) || minSample < 1) throw new Error("--min-sample must be a positive integer");
  const settings: SimilaritySettings = {
    ...SIMILARITY_SETTINGS,
    minSample,
    useAge: !has("no-age"),
    distance: has("mahalanobis") ? "mahalanobis" : "euclidean",
  };
  if (JSON.stringify(settings) !== JSON.stringify(SIMILARITY_SETTINGS)) log("NOTE: non-default settings; not the approved configuration");

  const levels = new Map<MilbLevelId, AflSnapshot>();
  let source: string;
  let snapshotId: string | undefined;
  if (synthetic) {
    const mode = has("null") ? "null" : "types";
    source = `SYNTHETIC fictional data, ${mode === "null" ? "no real similarity (null)" : "planted archetypes"} (not real players)`;
    MILB_LEVEL_IDS.forEach((id, i) => levels.set(id, syntheticSeason({ seed: 31 + i, mode })));
  } else {
    const dir = snapshotDir();
    const files = snapshotSource(dir, AFL.defaultSeason);
    snapshotId = await files.version();
    source = `build-time snapshot ${path.basename(dir)}/ (season ${AFL.defaultSeason})`;
    for (const id of MILB_LEVEL_IDS) {
      const s = await files.load(id);
      if (s) levels.set(id, s);
      else log(`${id}: no data in the snapshot`);
    }
  }
  const results: RoleValidation[] = [];
  const byLabel = new Map<string, AflSnapshot>();
  for (const [id, s] of levels) {
    if (only && id !== only) continue;
    byLabel.set(COMPETITION_LEVEL_LABELS[id], s);
    for (const role of ["hitter", "pitcher"] as SimilarityRole[]) {
      const t = Date.now();
      log(`${id} ${role}s…`);
      results.push(validateRole(COMPETITION_LEVEL_LABELS[id], s, role, { settings }));
      log(`${id} ${role}s done in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    }
  }
  const ctx = { source, snapshotId, settings };
  process.stdout.write(has("appendix") ? renderFaceValidityAppendix(results, byLabel, ctx) : renderValidationReport(results, ctx));
}

main().catch((error) => {
  log(`ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
