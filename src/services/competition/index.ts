import "server-only";
import { connection } from "next/server";
import { getDatabase } from "@/db/client";
import { AFL } from "@/ingestion/sources/mlb-config";
import { loadIngestionVersion } from "@/services/afl/queries";
import { LEVEL_IDS } from "@/services/players/levels";
import type { LevelCache } from "./cache";
import { dbLevelLoader, loadCompetition } from "./load";
import { DATA_SOURCE_ENV, dataConfigured, dataSource, type DataSource } from "./data-source";
import { snapshotSource } from "./snapshot-store";
import { summarizeTrace, type LoadTrace } from "@/db/instrument";
import { competitionLevelCache, preparesOnLoad } from "./source-cache";
import type { CompetitionDataResult } from "./types";
import { healthReport, type HealthReport } from "./health";

export type { CompetitionDataResult, LevelSnapshot } from "./types";

/**
 * Season shown on the site. The AFL (`afl-{year}`) and MiLB (`milb-{year}`) seasons are separate
 * seasons in the database; both are read for this year.
 */
export const DATA_SEASON: number = AFL.defaultSeason;

/** Only a coarse, credential-free code is ever logged. */
export function safeErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error)
    return String((error as { code: unknown }).code).slice(0, 16);
  return error instanceof Error ? error.name : "unknown";
}

/**
 * How often a loaded level checks (one tiny query) whether a new ingestion run was applied. Data
 * never expires on a timer: an unchanged database keeps being served from memory, and a changed
 * one is reloaded in the background while the previous snapshot is still served. See cache.ts.
 */
const CHECK_MS = 60_000;

/**
 * One cache per server process. Next.js bundles src/instrumentation.ts (which starts the warm-up)
 * separately from the route handlers, so a module-level variable would give each bundle its own
 * cache and every level would load twice; the process-global slot is shared by both.
 */
const CACHE_KEY = Symbol.for("prospect-terminal.competition-level-cache");
const processGlobal = globalThis as typeof globalThis & { [CACHE_KEY]?: LevelCache };

/** A level load slower than this is logged with its timing breakdown (credential-free). */
const SLOW_LOAD_MS = 15_000;
const timingLogs = () => process.env.PT_DATA_TIMING === "1";

function levelCache(): LevelCache {
  return (processGlobal[CACHE_KEY] ??= createSourceCache(dataSource()));
}

function createSourceCache(source: DataSource): LevelCache {
  const common = {
    checkMs: CHECK_MS,
    // Database mode prepares every level's analytics on load (warm-up off the request path);
    // snapshot mode prepares on first use, only the levels a request needs (source-cache.ts).
    prepareOnLoad: preparesOnLoad(source),
    onTrace: (trace: LoadTrace, totalMs: number, ok: boolean) => {
      if (!ok || totalMs > SLOW_LOAD_MS || timingLogs())
        console.error(`[competition-data] ${ok ? "loaded" : "load failed:"} ${summarizeTrace(trace, totalMs)}`);
    },
    onBackgroundError: (level: string, error: unknown) =>
      console.error(`[competition-data] ${level} refresh failed (${safeErrorCode(error)}); serving the previous snapshot`),
  };
  if (source.kind === "snapshot") {
    // Build-time snapshot (docs/VERCEL.md): no database connection is ever opened. The version is
    // the snapshot's id, constant for the deployment, so a loaded level is never reloaded.
    const files = snapshotSource(source.dir, DATA_SEASON);
    return competitionLevelCache({ ...common, load: files.load, version: files.version });
  }
  return competitionLevelCache({
    ...common,
    load: dbLevelLoader(getDatabase(), DATA_SEASON),
    version: () => loadIngestionVersion(getDatabase()),
  });
}

// A level that keeps failing is reported at most once a minute, not once per request.
const lastFailureLog = new Map<string, number>();
function logReadFailure(level: string, error: unknown) {
  const t = Date.now();
  if (t - (lastFailureLog.get(level) ?? 0) < 60_000) return;
  lastFailureLog.set(level, t);
  console.error(`[competition-data] ${level} read failed (${safeErrorCode(error)})`);
}

let invalidSourceLogged = false;

async function read(): Promise<CompetitionDataResult> {
  const source = dataSource();
  if (source.kind === "invalid") {
    if (!invalidSourceLogged) console.error(`[competition-data] ${DATA_SOURCE_ENV} must be "database" or "snapshot"; serving no data`);
    invalidSourceLogged = true;
    return { status: "unavailable" };
  }
  if (!dataConfigured(source)) return { status: "not-configured" };
  try {
    const c = levelCache();
    return await loadCompetition(
      (level) => c.get(level),
      logReadFailure,
    );
  } catch (error) {
    console.error(`[competition-data] read failed (${safeErrorCode(error)})`);
    return { status: "unavailable" };
  }
}

/**
 * Server-side entry point for real data at every level (AFL + Triple-A … Single-A), from the
 * database or the build-time snapshot (data-source.ts). Never import
 * from a Client Component: the database client stays on the server ("server-only" enforces this).
 */
export async function getCompetitionData(): Promise<CompetitionDataResult> {
  await connection(); // request-time data; never prerendered into the build output
  return read();
}

/**
 * Starts loading every level in the background (called once at server start from
 * src/instrumentation.ts), so the first visitor does not wait for the initial load. Never throws.
 */
export function warmCompetitionData() {
  if (!dataConfigured(dataSource())) return;
  try {
    levelCache().warm(LEVEL_IDS);
  } catch (error) {
    console.error(`[competition-data] warm-up failed (${safeErrorCode(error)})`);
  }
}

/**
 * Health-check readiness (see health.ts). Reads only in-memory cache state; also restarts the
 * warm-up for levels whose backoff has expired, so a failed start keeps retrying without visitors.
 */
export function competitionHealth(): HealthReport {
  if (!dataConfigured(dataSource())) return healthReport(false, []);
  const c = levelCache();
  c.warm(LEVEL_IDS);
  return healthReport(
    true,
    LEVEL_IDS.map((level) => [level, c.state(level)]),
  );
}
