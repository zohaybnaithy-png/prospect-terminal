/**
 * Build-time export of every competition level to snapshot files (snapshot-store.ts). The CLI is
 * scripts/export-snapshot.ts; this module takes the loader and version probe as arguments so the
 * whole procedure is tested against in-memory loaders and against PostgreSQL.
 *
 * Guarantees:
 * - Read-only: the level loader is the site's own (`dbLevelLoader`: each level in a READ ONLY,
 *   REPEATABLE READ transaction). The export never writes to the database.
 * - Consistent: the applied-ingestion version is read before and after the levels. If an
 *   ingestion run was applied in between, the export fails instead of mixing two data states.
 * - Exact: every level is written, read back through the same path the server uses (size, hash,
 *   gunzip, unpack, shape) and compared with what the database returned. Any difference fails the
 *   export, so a snapshot can only ever contain exactly the database's data.
 * - Fail-closed: files are written to a temporary directory and swapped in only once every level
 *   was read and written; a snapshot that then fails verification is deleted. A failed export
 *   therefore leaves no snapshot, and the build that depends on it fails (next.config.ts).
 */
import { rm } from "node:fs/promises";
import type { AflSnapshot } from "@/services/afl/types";
import { LEVEL_IDS, type LevelId } from "@/services/players/levels";
import { snapshotsEqual } from "./snapshot-format";
import { SnapshotIntegrityError, snapshotSource, writeSnapshotDir, type SnapshotManifest } from "./snapshot-store";

export interface ExportOptions {
  dir: string;
  season: number;
  load: (level: LevelId) => Promise<AflSnapshot | null>;
  version: () => Promise<string>;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface ExportReport {
  status: "ok";
  season: number;
  snapshotId: string;
  ingestionVersion: string;
  levels: Record<string, { status: "ok"; bytes: number; players: number; games: number; batting: number; pitching: number } | { status: "empty" }>;
  totalBytes: number;
  durationMs: number;
}

export async function exportSnapshots(o: ExportOptions): Promise<ExportReport> {
  const log = o.log ?? (() => {});
  const started = Date.now();
  const before = await o.version();
  const levels = new Map<LevelId, AflSnapshot | null>();
  for (const level of LEVEL_IDS) {
    const t = Date.now();
    const snapshot = await o.load(level);
    levels.set(level, snapshot);
    log(
      snapshot
        ? `${level}: ${snapshot.players.length} players, ${snapshot.games.length} games, ${snapshot.batting.length} batting and ${snapshot.pitching.length} pitching lines (${Date.now() - t} ms)`
        : `${level}: no data (not ingested)`,
    );
  }
  const after = await o.version();
  if (after !== before)
    throw new SnapshotIntegrityError("an ingestion run was applied during the export; run it again");

  const manifest = await writeSnapshotDir(o.dir, { season: o.season, ingestionVersion: before, levels, now: o.now?.() });
  try {
    await verifyRoundTrip(o.dir, o.season, manifest, levels);
  } catch (error) {
    // Never leave a snapshot behind that failed verification.
    await rm(o.dir, { recursive: true, force: true });
    throw error;
  }
  log(`verified ${LEVEL_IDS.length} levels against the database read (snapshot ${manifest.snapshotId.slice(0, 12)})`);

  const report: ExportReport["levels"] = {};
  let totalBytes = 0;
  for (const [level, e] of Object.entries(manifest.levels)) {
    if (e.status === "empty") report[level] = { status: "empty" };
    else {
      totalBytes += e.bytes;
      report[level] = { status: "ok", bytes: e.bytes, ...e.counts };
    }
  }
  return {
    status: "ok",
    season: o.season,
    snapshotId: manifest.snapshotId,
    ingestionVersion: before,
    levels: report,
    totalBytes,
    durationMs: Date.now() - started,
  };
}

async function verifyRoundTrip(dir: string, season: number, manifest: SnapshotManifest, levels: ReadonlyMap<LevelId, AflSnapshot | null>) {
  const files = snapshotSource(dir, season);
  if ((await files.version()) !== manifest.snapshotId) throw new SnapshotIntegrityError("written manifest does not read back");
  for (const level of LEVEL_IDS) {
    const back = await files.load(level);
    if (!snapshotsEqual(back, levels.get(level) ?? null))
      throw new SnapshotIntegrityError(`${level}: the snapshot file does not reproduce the database read exactly`);
  }
}
