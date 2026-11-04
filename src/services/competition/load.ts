/**
 * Loads every competition level through the existing read layer (no new queries): the AFL via
 * loadAflSnapshot and each MiLB level via loadMilbLevelSnapshot. Each level reads in its own
 * READ ONLY, REPEATABLE READ transaction, so one failing level cannot hide the others.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as core from "@/db/schema";
import { loadAflSnapshot, loadMilbLevelSnapshot } from "@/services/afl/queries";
import type { AflSnapshot } from "@/services/afl/types";
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
