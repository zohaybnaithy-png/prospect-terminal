/**
 * Precomputed view models at runtime (docs/VERCEL.md, *Precomputed view models*).
 *
 * Snapshot mode only. When a level is loaded from a snapshot that has views (views-build.ts), the
 * level snapshot object is linked to its parts. A page function that misses its per-snapshot memo
 * (prepare.ts, players/adapter.ts, moves.ts) first asks `precomputedPart` for that part, which
 * reads and decodes that ONE file; nothing is decoded until a page needs it.
 *
 * Every check fails SAFE: the value is then computed live, exactly as without views, and the reason
 * is logged once (credential-free). Views are used only when all of these hold:
 * - `PT_PRECOMPUTED_VIEWS` is unset or `on` (`off` is the rollback switch; any other value counts
 *   as off);
 * - the views manifest is valid and was computed from THIS data snapshot (`snapshotId`);
 * - it was computed by THIS source tree (fingerprint carried by the built server);
 * - this runtime computes what the build computed (V8 major.minor and `Math` probes);
 * - each part file matches its manifest size and SHA-256, and decodes cleanly.
 * Database mode never links views (only `snapshotSource` does).
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { AflSnapshot } from "@/services/afl/types";
import { processWeakMap } from "@/lib/process-memo";
import type { LevelId } from "@/services/players/levels";
import { unpackValue } from "./snapshot-format";
import {
  VIEWS_DIR,
  VIEWS_MANIFEST_FILE,
  ViewsFormatError,
  decodeGraph,
  decodeShared,
  runtimeCompatible,
  sha256,
  validLevelKeys,
  viewsManifestSchema,
  type ViewsManifest,
  type ViewsPartEntry,
} from "./views-format";

export const PRECOMPUTED_VIEWS_ENV = "PT_PRECOMPUTED_VIEWS";

export type ViewsOffReason =
  | "disabled"
  | "absent"
  | "malformed"
  | "snapshot-mismatch"
  | "no-build-fingerprint"
  | "fingerprint-mismatch"
  | "v8-mismatch"
  | "math-mismatch";

export type ViewsStatus = { on: true; manifest: ViewsManifest; dir: string } | { on: false; reason: ViewsOffReason };

const REASON_TEXT: Record<ViewsOffReason, string> = {
  disabled: `${PRECOMPUTED_VIEWS_ENV} is not on`,
  absent: "the snapshot has no precomputed views",
  malformed: "the views manifest is malformed",
  "snapshot-mismatch": "the views were computed from a different data snapshot",
  "no-build-fingerprint": "the server carries no build fingerprint",
  "fingerprint-mismatch": "the views were computed by different source code",
  "v8-mismatch": "this runtime's V8 differs from the build's",
  "math-mismatch": "this runtime's Math results differ from the build's",
};

const once = new Set<string>();
const logOnce = (key: string, line: string) => {
  if (once.has(key)) return;
  once.add(key);
  console.error(`[competition-views] ${line}`);
};

/** `on` unless the switch says otherwise; anything but unset/`on`/`off` is treated as off. */
export function viewsSwitch(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[PRECOMPUTED_VIEWS_ENV]?.trim().toLowerCase();
  if (!v || v === "on") return true;
  if (v !== "off") logOnce(`switch:${v}`, `${PRECOMPUTED_VIEWS_ENV} has an unknown value; treating it as off`);
  return false;
}

export interface ViewsCheckOptions {
  /** The data snapshot's id (snapshot manifest). */
  snapshotId: string;
  /** Fingerprint the running server was built from (undefined: views are not used). */
  fingerprint: string | undefined;
  env?: Record<string, string | undefined>;
  /** Injectable for tests. */
  v8?: string;
  probes?: number[][];
}

/** Reads and checks the views manifest of a snapshot directory. Never throws. */
export async function checkViews(snapshotDir: string, o: ViewsCheckOptions): Promise<ViewsStatus> {
  if (!viewsSwitch(o.env)) return { on: false, reason: "disabled" };
  const dir = path.join(snapshotDir, VIEWS_DIR);
  let text: string;
  try {
    text = await readFile(path.join(dir, VIEWS_MANIFEST_FILE), "utf8");
  } catch {
    return { on: false, reason: "absent" };
  }
  let manifest: ViewsManifest;
  try {
    const parsed = viewsManifestSchema.safeParse(JSON.parse(text));
    if (!parsed.success || !validLevelKeys(parsed.data)) return { on: false, reason: "malformed" };
    manifest = parsed.data;
  } catch {
    return { on: false, reason: "malformed" };
  }
  if (manifest.snapshotId !== o.snapshotId) return { on: false, reason: "snapshot-mismatch" };
  if (!o.fingerprint) return { on: false, reason: "no-build-fingerprint" };
  if (manifest.sourceFingerprint !== o.fingerprint) return { on: false, reason: "fingerprint-mismatch" };
  const compat = runtimeCompatible(manifest, o.v8, o.probes);
  if (!compat.ok) return { on: false, reason: compat.reason };
  return { on: true, manifest, dir };
}

export function logViewsStatus(status: ViewsStatus) {
  if (status.on)
    logOnce("status", `precomputed views on (snapshot ${status.manifest.snapshotId.slice(0, 12)}, ${Object.keys(status.manifest.levels).length} levels)`);
  else logOnce("status", `precomputed views off: ${REASON_TEXT[status.reason]}; computing live`);
}

interface LevelLink {
  dir: string;
  level: LevelId;
  parts: Record<string, ViewsPartEntry>;
}

const links = processWeakMap<AflSnapshot, LevelLink>("precomputed-views");

/** Links a freshly decoded level snapshot to its parts (status must be on). */
export function linkLevelViews(s: AflSnapshot, level: LevelId, status: ViewsStatus) {
  if (!status.on) return;
  const parts = status.manifest.levels[level];
  if (parts) links.set(s, { dir: path.join(status.dir, level), level, parts });
}

/** Parts decoded and parts that fell back to live computation, this process (tests, diagnostics). */
export const viewsCounters = { decoded: 0, fallbacks: 0 };

/** Reads one part file and checks it against its manifest entry. */
function readPart(link: LevelLink, entry: ViewsPartEntry): unknown {
  let file: Buffer;
  try {
    file = readFileSync(path.join(link.dir, entry.file));
  } catch {
    throw new PartError("missing file");
  }
  if (file.length !== entry.bytes || sha256(file) !== entry.sha256) throw new PartError("integrity check failed");
  try {
    return unpackValue(JSON.parse(gunzipSync(file).toString("utf8")));
  } catch {
    throw new PartError("cannot be decoded");
  }
}

class PartError extends Error {}

/** The level's shared pool (views-format.ts), decoded at most once per loaded level. */
const pools = processWeakMap<AflSnapshot, { get: (id: number) => object }>("precomputed-views-shared");
function sharedPool(s: AflSnapshot, link: LevelLink) {
  let pool = pools.get(s);
  if (!pool) {
    const entry = link.parts.shared;
    if (!entry) throw new PartError("has no shared pool");
    pool = decodeShared(readPart(link, entry), s);
    pools.set(s, pool);
  }
  return pool;
}

/**
 * The precomputed value of one part of this snapshot's level, or undefined: no views, the part is
 * not listed, or it failed a check (logged once). Callers then compute live.
 */
export function precomputedPart<T>(s: AflSnapshot, part: string): T | undefined {
  const link = links.get(s);
  if (!link) return undefined;
  const entry = link.parts[part];
  if (!entry || part === "shared") {
    viewsCounters.fallbacks++;
    logOnce(`missing:${link.level}:${part}`, `${link.level} has no precomputed ${part}; computing live`);
    return undefined;
  }
  try {
    const started = performance.now();
    const value = decodeGraph(readPart(link, entry), s, () => sharedPool(s, link)) as T;
    viewsCounters.decoded++;
    // Diagnostics (same switch as the level-load timings in index.ts): one line per decoded part.
    if (process.env.PT_DATA_TIMING === "1")
      console.error(`[competition-views] ${link.level} ${part}: ${entry.bytes} B in ${(performance.now() - started).toFixed(1)} ms`);
    return value;
  } catch (error) {
    viewsCounters.fallbacks++;
    const why = error instanceof PartError ? error.message : error instanceof ViewsFormatError ? "cannot be decoded" : "failed";
    logOnce(`bad:${link.level}:${part}`, `${link.level} precomputed ${part}: ${why}; computing live`);
    return undefined;
  }
}

/** Test hook: forget logged messages. */
export const resetViewsLog = () => once.clear();
