/**
 * Builds precomputed view models for a snapshot directory (`npm run snapshot:views`, run by
 * `npm run build:vercel` after `snapshot:export`). No database: it reads the snapshot files.
 *
 * Every part is computed by the SAME page functions the server calls (on a snapshot that has no
 * views linked, so they compute live), encoded with its reference graph (views-format.ts), and then
 * decoded again and compared before anything is written. The build fails, writing nothing, unless
 * every part decodes to a value that is strictly deep-equal to the live one AND has the same
 * reference graph and key order (re-encoding both gives identical JSON). So a served page can only
 * differ from a live one if the inputs differ, which the manifest checks rule out (views-store.ts).
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { MOMENTUM_WINDOW_IDS } from "@/analytics/config";
import type { AflSnapshot } from "@/services/afl/types";
import { levelDirectoryRows } from "@/services/players/adapter";
import { STAT_WINDOWS } from "@/services/players/directory";
import { LEVEL_IDS, type LevelId } from "@/services/players/levels";
import { levelSpans } from "./moves";
import { homeTopLines, homeTrending, levelCoverageSummary, trendComparable, trendMapPoints, trendRiserListsAll } from "./prepare";
import { packValue, unpackValue } from "./snapshot-format";
import { readSnapshotManifest, snapshotSource } from "./snapshot-store";
import {
  VIEWS_DIR,
  VIEWS_FORMAT,
  VIEWS_FORMAT_VERSION,
  VIEWS_MANIFEST_FILE,
  ViewsEncodeError,
  decodeGraph,
  decodeShared,
  encodeLevelGraph,
  mathProbes,
  partFileName,
  sha256,
  snapshotPaths,
  type ViewsManifest,
  type ViewsPartEntry,
} from "./views-format";

const ROLES = ["hitter", "pitcher"] as const;

/** The parts of one level, in a fixed order, computed live. Names are the runtime lookup keys. */
export function levelViewParts(s: AflSnapshot, level: LevelId): [string, unknown][] {
  return [
    ...STAT_WINDOWS.map((w): [string, unknown] => [`directory-rows|${level}|${w}`, levelDirectoryRows(s, level, w)]),
    ["home-trending", homeTrending(s)],
    ["home-top-lines", homeTopLines(s)],
    ["coverage", levelCoverageSummary(s)],
    ["trend-comparable", trendComparable(s)],
    ["trend-riser-lists", trendRiserListsAll(s)],
    ...ROLES.flatMap((r) => MOMENTUM_WINDOW_IDS.map((w): [string, unknown] => [`trend-map-points|${r}|${w}`, trendMapPoints(s, r, w)])),
    ["level-move-spans", [...levelSpans(s)]],
  ];
}

/** Name of the part holding the level's shared pool (views-format.ts). */
export const SHARED_PART = "shared";

const gzipJson = (v: unknown) => gzipSync(JSON.stringify(packValue(v)), { level: 9 });
const gunzipJson = (b: Buffer) => unpackValue(JSON.parse(gunzipSync(b).toString("utf8")));

/**
 * Encodes a level's parts and proves they decode back exactly, each on its own (as the server
 * decodes them) and all together (one shared pool): strictly deep-equal values, and re-encoding the
 * decoded parts gives byte-identical output, i.e. the same reference graph and key order.
 * Throws `ViewsEncodeError` otherwise.
 */
export function encodeLevelParts(s: AflSnapshot, parts: [string, unknown][]) {
  if (parts.some(([name]) => name === SHARED_PART)) throw new ViewsEncodeError(`part name ${SHARED_PART} is reserved`);
  const paths = snapshotPaths(s);
  const encoded = encodeLevelGraph(parts, paths);
  const sharedFile = gzipJson(encoded.shared);
  const files = encoded.parts.map(([name, v]) => ({ name, file: gzipJson(v) }));
  const pool = decodeShared(gunzipJson(sharedFile), s);
  const decoded = files.map(({ name, file }): [string, unknown] => [name, decodeGraph(gunzipJson(file), s, () => pool)]);
  decoded.forEach(([name, back], i) => {
    if (!isDeepStrictEqual(back, parts[i][1])) throw new ViewsEncodeError(`${name}: does not decode to an equal value`);
  });
  if (JSON.stringify(encodeLevelGraph(decoded, paths)) !== JSON.stringify(encoded))
    throw new ViewsEncodeError("decoded parts do not have the same reference graph and key order");
  return [...files, { name: SHARED_PART, file: sharedFile }];
}

export interface ViewsReport {
  snapshotId: string;
  levels: Record<string, { parts: number; bytes: number; computeMs: number; encodeMs: number }>;
  totalBytes: number;
  durationMs: number;
}

/**
 * Writes `<snapshotDir>/views/` atomically (a temporary sibling replaces it only when complete).
 * On any failure nothing is left behind and the previous views, if any, are removed too: a
 * snapshot is then served with live computation, never with views from other data.
 */
export async function writeSnapshotViews(
  snapshotDir: string,
  o: { season: number; fingerprint: string; now?: Date; log?: (line: string) => void },
): Promise<ViewsReport> {
  const started = performance.now();
  const final = path.join(snapshotDir, VIEWS_DIR);
  const tmp = path.join(snapshotDir, `${VIEWS_DIR}.tmp-${process.pid}-${Date.now()}`);
  await rm(final, { recursive: true, force: true });
  try {
    const manifest = await readSnapshotManifest(snapshotDir, o.season);
    const source = snapshotSource(snapshotDir, o.season); // no views: every part is computed live
    const levels: ViewsManifest["levels"] = {};
    const report: ViewsReport["levels"] = {};
    let totalBytes = 0;
    for (const level of LEVEL_IDS) {
      const s = await source.load(level);
      if (!s) continue;
      let t = performance.now();
      const parts = levelViewParts(s, level);
      const computeMs = Math.round(performance.now() - t);
      t = performance.now();
      const files = encodeLevelParts(s, parts);
      const encodeMs = Math.round(performance.now() - t);
      await mkdir(path.join(tmp, level), { recursive: true });
      const entries: Record<string, ViewsPartEntry> = {};
      let bytes = 0;
      for (const { name, file } of files) {
        const fileName = partFileName(name);
        await writeFile(path.join(tmp, level, fileName), file);
        entries[name] = { file: fileName, sha256: sha256(file), bytes: file.length };
        bytes += file.length;
      }
      levels[level] = entries;
      report[level] = { parts: files.length, bytes, computeMs, encodeMs };
      totalBytes += bytes;
      o.log?.(`${level}: ${files.length} parts, ${(bytes / 1024).toFixed(0)} kB (compute ${computeMs} ms, encode+verify ${encodeMs} ms)`);
    }
    const views: ViewsManifest = {
      format: VIEWS_FORMAT,
      formatVersion: VIEWS_FORMAT_VERSION,
      snapshotId: manifest.snapshotId,
      sourceFingerprint: o.fingerprint,
      node: process.versions.node,
      v8: process.versions.v8,
      mathProbes: mathProbes(),
      createdAt: (o.now ?? new Date()).toISOString(),
      levels,
    };
    await mkdir(tmp, { recursive: true });
    await writeFile(path.join(tmp, VIEWS_MANIFEST_FILE), JSON.stringify(views, null, 2) + "\n");
    await rename(tmp, final);
    return { snapshotId: manifest.snapshotId, levels: report, totalBytes, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}
