/**
 * Loads every competition level through the existing read layer (no new queries): the AFL via
 * loadAflSnapshot and each MiLB level via loadMilbLevelSnapshot. Each level reads in its own
 * READ ONLY, REPEATABLE READ transaction, so one failing level cannot hide the others.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as core from "@/db/schema";
import { loadAflSnapshot, loadMilbLevelSnapshot } from "@/services/afl/queries";
import type { AflSnapshot } from "@/services/afl/types";
import { newTrace, pausesBetween, startPauseMonitor, timePhase, withTrace, type LoadTrace } from "@/db/instrument";
import { LEVEL_IDS, type LevelId } from "@/services/players/levels";
import type {
  CompetitionDataResult,
  LevelLoadStatus,
  LevelSnapshot,
} from "./types";

type Database = NodePgDatabase<typeof core>;
export type LevelLoader = (level: LevelId) => Promise<AflSnapshot | null>;

export const dbLevelLoader =
  (db: Database, season: number): LevelLoader =>
  (level) =>
    level === "afl"
      ? loadAflSnapshot(db, season)
      : loadMilbLevelSnapshot(db, level, season);

/** Pure combination of per-level outcomes; `onError` receives failures (log codes only). */
export async function loadCompetition(
  loader: LevelLoader,
  onError: (level: LevelId, error: unknown) => void = () => {},
): Promise<CompetitionDataResult> {
  const settled = await Promise.allSettled(LEVEL_IDS.map((l) => loader(l)));
  const levelStatus = {} as Record<LevelId, LevelLoadStatus>;
  const levels: LevelSnapshot[] = [];
  settled.forEach((r, i) => {
    const level = LEVEL_IDS[i];
    if (r.status === "rejected") {
      levelStatus[level] = "unavailable";
      onError(level, r.reason);
    } else if (r.value) {
      levelStatus[level] = "ok";
      levels.push({ level, snapshot: r.value });
    } else levelStatus[level] = "empty";
  });
  if (levels.length) return { status: "ok", levels, levelStatus };
  if (Object.values(levelStatus).includes("unavailable"))
    return { status: "unavailable" };
  return { status: "empty", levelStatus };
}

/** True when the watchdog closed one of the trace's connections (stalled or over its deadline). */
export const closedByWatchdog = (trace: LoadTrace) =>
  trace.queries.some((q) => q.outcome === "stalled" || q.outcome === "slow" || q.outcome === "deadline");

/**
 * Wraps a level loader so each load runs inside its own timing trace (src/db/instrument.ts):
 * pool acquire, per-query first-byte / transfer / parse, decode and `prepare` (the warm-up compute)
 * are attributed to that level. `onTrace` receives every finished attempt with its total duration;
 * callers decide what to log.
 *
 * A load that failed because the watchdog closed a stalled connection is retried ONCE on a fresh
 * connection (the pool discards the closed one): a stall is a property of one TCP connection, not
 * of the data. Any other failure (SQL error, authentication, a second stall) is not retried here;
 * the cache's backoff decides when to try again.
 */
export function tracedLevelLoader(
  loader: LevelLoader,
  {
    prepare,
    onTrace,
    retryStalled = 1,
  }: {
    prepare?: (level: LevelId, snapshot: AflSnapshot | null) => void;
    onTrace: (trace: LoadTrace, totalMs: number, ok: boolean) => void;
    retryStalled?: number;
  },
): LevelLoader {
  startPauseMonitor();
  const finish = (trace: LoadTrace) => {
    const totalMs = performance.now() - trace.startedAt;
    trace.pausesMs = pausesBetween(trace.startedAt, trace.startedAt + totalMs);
    return totalMs;
  };
  const attempt = (level: LevelId, n: number): Promise<AflSnapshot | null> => {
    const trace = newTrace(n ? `${level} (retry ${n})` : level);
    return withTrace(trace, async () => {
      try {
        const snapshot = await loader(level);
        if (prepare) timePhase("prepare", () => prepare(level, snapshot));
        onTrace(trace, finish(trace), true);
        return snapshot;
      } catch (error) {
        onTrace(trace, finish(trace), false);
        if (n < retryStalled && closedByWatchdog(trace)) return attempt(level, n + 1);
        throw error;
      }
    });
  };
  return (level) => attempt(level, 0);
}
