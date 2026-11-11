/**
 * Build-time data snapshots on disk (docs/VERCEL.md, *Build-time data snapshot*).
 *
 * `npm run snapshot:export` (scripts/export-snapshot.ts) reads every competition level from the
 * database ONCE, at build time, through the same read layer the site uses, and writes them here.
 * With `PT_DATA_SOURCE=snapshot` the server then loads levels from these files instead of the
 * database, so serving pages never opens a database connection: no Neon egress, no compute
 * wake-ups and no connection-limit exposure per cold serverless instance.
 *
 * Layout of the directory (default `.data-snapshot/`, git-ignored, never committed):
 *   manifest.json        format version, season, ingestion version, one entry per level
 *   <level>.json.gz      gzip of the packed level snapshot (snapshot-format.ts)
 *
 * Integrity: every level file's SHA-256 and size are in the manifest and are checked before the
 * file is parsed; the manifest must list every level of the site; the season must match the
 * season the site shows. Any mismatch fails that level's load (the page shows the level as
 * unavailable), never serves different data.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { AflSnapshot } from "@/services/afl/types";
import { LEVEL_IDS, type LevelId } from "@/services/players/levels";
import { SnapshotFormatError, packSnapshot, unpackSnapshot } from "./snapshot-format";

export const SNAPSHOT_FORMAT = "prospect-terminal/level-snapshots";
export const SNAPSHOT_FORMAT_VERSION = 1;
export const DEFAULT_SNAPSHOT_DIR = ".data-snapshot";
export const MANIFEST_FILE = "manifest.json";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const levelEntry = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    file: z.string().regex(/^[a-z-]+\.json\.gz$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().positive(),
    counts: z.object({
      players: z.number().int().nonnegative(),
      games: z.number().int().nonnegative(),
      batting: z.number().int().nonnegative(),
      pitching: z.number().int().nonnegative(),
    }),
  }),
  /** The level has no data in the database (not ingested yet): the site shows it as empty. */
  z.object({ status: z.literal("empty") }),
]);

export const manifestSchema = z
  .object({
    format: z.literal(SNAPSHOT_FORMAT),
    formatVersion: z.literal(SNAPSHOT_FORMAT_VERSION),
    season: z.number().int(),
    createdAt: z.iso.datetime(),
    /** The database's applied-ingestion version at export (same probe as the live cache). */
    ingestionVersion: z.string().min(1),
    /** Identifies this exact data set: hash of the season, ingestion version and level entries. */
    snapshotId: z.string().regex(/^[0-9a-f]{64}$/),
    levels: z.record(z.string(), levelEntry),
  })
  .strict();

export type SnapshotManifest = z.infer<typeof manifestSchema>;
export type LevelEntry = z.infer<typeof levelEntry>;

export class SnapshotIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotIntegrityError";
  }
}

/** Deterministic id of a data set (does not include createdAt, so re-exports of identical data match). */
export function snapshotId(season: number, ingestionVersion: string, levels: Record<string, LevelEntry>) {
  const ordered = Object.keys(levels)
    .sort()
    .map((k) => [k, levels[k]]);
  return sha256(JSON.stringify([SNAPSHOT_FORMAT_VERSION, season, ingestionVersion, ordered]));
}

/** Validates a parsed manifest: schema, the expected season, every site level present, the id. */
export function validateManifest(raw: unknown, season: number): SnapshotManifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new SnapshotIntegrityError("snapshot manifest is malformed");
  const m = parsed.data;
  if (m.season !== season) throw new SnapshotIntegrityError(`snapshot is for season ${m.season}, the site shows ${season}`);
  const listed = Object.keys(m.levels).sort();
  const expected = [...LEVEL_IDS].sort();
  if (listed.join() !== expected.join()) throw new SnapshotIntegrityError("snapshot manifest does not list exactly the site's levels");
  for (const [level, e] of Object.entries(m.levels))
    if (e.status === "ok" && e.file !== `${level}.json.gz`) throw new SnapshotIntegrityError(`snapshot file name for ${level} is unexpected`);
  if (snapshotId(m.season, m.ingestionVersion, m.levels) !== m.snapshotId)
    throw new SnapshotIntegrityError("snapshot manifest id does not match its contents");
  return m;
}

/** Encodes one level (null = not ingested). Pure apart from hashing; used by the writer and tests. */
export function encodeLevel(level: LevelId, snapshot: AflSnapshot | null): { entry: LevelEntry; file?: Buffer } {
  if (!snapshot) return { entry: { status: "empty" } };
  const file = gzipSync(JSON.stringify(packSnapshot(snapshot)), { level: 9 });
  return {
    entry: {
      status: "ok",
      file: `${level}.json.gz`,
      sha256: sha256(file),
      bytes: file.length,
      counts: {
        players: snapshot.players.length,
        games: snapshot.games.length,
        batting: snapshot.batting.length,
        pitching: snapshot.pitching.length,
      },
    },
    file,
  };
}

/** Decodes one level file after checking its size and hash against the manifest entry. */
export function decodeLevel(entry: LevelEntry, file: Buffer | null, season: number): AflSnapshot | null {
  if (entry.status === "empty") return null;
  if (!file) throw new SnapshotIntegrityError(`snapshot file ${entry.file} is missing`);
  if (file.length !== entry.bytes || sha256(file) !== entry.sha256)
    throw new SnapshotIntegrityError(`snapshot file ${entry.file} does not match the manifest`);
  try {
    return unpackSnapshot(JSON.parse(gunzipSync(file).toString("utf8")), season);
  } catch (error) {
    if (error instanceof SnapshotFormatError) throw error;
    throw new SnapshotIntegrityError(`snapshot file ${entry.file} cannot be decoded`);
  }
}

/**
 * Writes a complete snapshot directory atomically: files go to a sibling temporary directory,
 * which replaces `dir` only once everything is written. A failed export leaves no partial snapshot.
 */
export async function writeSnapshotDir(
  dir: string,
  input: { season: number; ingestionVersion: string; levels: ReadonlyMap<LevelId, AflSnapshot | null>; now?: Date },
): Promise<SnapshotManifest> {
  for (const level of LEVEL_IDS)
    if (!input.levels.has(level)) throw new SnapshotIntegrityError(`level ${level} was not exported`);
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    const levels: Record<string, LevelEntry> = {};
    for (const level of LEVEL_IDS) {
      const { entry, file } = encodeLevel(level, input.levels.get(level) ?? null);
      levels[level] = entry;
      if (file) await writeFile(path.join(tmp, `${level}.json.gz`), file);
    }
    const manifest: SnapshotManifest = {
      format: SNAPSHOT_FORMAT,
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      season: input.season,
      createdAt: (input.now ?? new Date()).toISOString(),
      ingestionVersion: input.ingestionVersion,
      snapshotId: snapshotId(input.season, input.ingestionVersion, levels),
      levels,
    };
    await writeFile(path.join(tmp, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    return manifest;
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}

export async function readSnapshotManifest(dir: string, season: number): Promise<SnapshotManifest> {
  let text: string;
  try {
    text = await readFile(path.join(dir, MANIFEST_FILE), "utf8");
  } catch {
    throw new SnapshotIntegrityError("snapshot manifest is missing (run npm run snapshot:export before the build)");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotIntegrityError("snapshot manifest is not JSON");
  }
  return validateManifest(raw, season);
}

/**
 * A snapshot source for the level cache: `version` is the manifest's snapshot id (constant for a
 * deployment, so the cache never reloads), `load` reads and verifies one level file. The manifest
 * is read once per process; a failed read is retried on the next call (the cache's backoff paces
 * that).
 */
export function snapshotSource(dir: string, season: number) {
  let manifest: Promise<SnapshotManifest> | undefined;
  const getManifest = () => {
    manifest ??= readSnapshotManifest(dir, season);
    manifest.catch(() => (manifest = undefined));
    return manifest;
  };
  return {
    manifest: getManifest,
    version: async () => (await getManifest()).snapshotId,
    load: async (level: LevelId): Promise<AflSnapshot | null> => {
      const entry = (await getManifest()).levels[level];
      if (!entry) throw new SnapshotIntegrityError(`snapshot has no entry for ${level}`);
      if (entry.status === "empty") return null;
      let file: Buffer | null = null;
      try {
        file = await readFile(path.join(dir, entry.file));
      } catch {
        file = null;
      }
      return decodeLevel(entry, file, season);
    },
  };
}
