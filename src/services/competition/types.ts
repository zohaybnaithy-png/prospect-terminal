import type { AflSnapshot } from "@/services/afl/types";
import type { LevelId } from "@/services/players/levels";

/**
 * One competition level's season snapshot. AFL and every MiLB level share the AflSnapshot shape
 * (loaded by loadAflSnapshot / loadMilbLevelSnapshot) and the shared player identity: a player's
 * internal UUID is the same in every level snapshot that contains them.
 */
export interface LevelSnapshot {
  level: LevelId;
  snapshot: AflSnapshot;
}

/** Per-level load outcome: "empty" = not ingested for this season; "unavailable" = read failed. */
export type LevelLoadStatus = "ok" | "empty" | "unavailable";

export type CompetitionDataResult =
  | {
      status: "ok";
      /** Levels with an ingested season, in ladder order (AAA … Single-A, then AFL). */
      levels: LevelSnapshot[];
      levelStatus: Record<LevelId, LevelLoadStatus>;
    }
  /** No DATABASE_URL in the server environment. */
  | { status: "not-configured" }
  /** Database reachable but no level has been ingested for the season. */
  | { status: "empty"; levelStatus: Record<LevelId, LevelLoadStatus> }
  /** Every level read failed (connection or query failure). Details are logged server-side only. */
  | { status: "unavailable" };
