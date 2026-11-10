/**
 * Readiness for a host's health check, from the level cache's in-memory state only: it never waits
 * for or runs a database query itself, so it answers in milliseconds.
 *
 * - "ready" (200): every level has a snapshot (a level that is not ingested counts: its empty
 *   result is cached too). Once ready, a level keeps its snapshot through later refresh failures,
 *   so a database outage after start does not make the server unhealthy (it serves the last data).
 * - "starting" (503): some level has not finished its first load yet.
 * - "degraded" (503): some level's first load failed and is backing off before retrying.
 * - "not-configured" (503): no DATABASE_URL.
 * A new deployment therefore becomes healthy only after the warm-up, and a deployment that cannot
 * load its data never replaces a working one.
 */
import type { LevelId } from "@/services/players/levels";

export interface LevelCacheState {
  loaded: boolean;
  loading: boolean;
  failures: number;
  /** Failed background checks/reloads while a snapshot is served (optional for older callers). */
  refreshFailures?: number;
}

export type HealthStatus = "ready" | "starting" | "degraded" | "not-configured";

export interface HealthReport {
  status: HealthStatus;
  levels: Partial<Record<LevelId, "ready" | "loading" | "failed" | "waiting">>;
  /**
   * Loaded levels whose background check or reload is currently failing (database unreachable,
   * failed reload). They keep serving their last snapshot, so readiness is unchanged (200), but the
   * data may be getting stale: monitoring alerts on this (scripts/ops/monitor.ts). Absent when none.
   */
  refreshFailing?: LevelId[];
}

export function healthReport(configured: boolean, states: [LevelId, LevelCacheState][]): HealthReport {
  if (!configured) return { status: "not-configured", levels: {} };
  const levels: HealthReport["levels"] = {};
  for (const [level, s] of states)
    levels[level] = s.loaded ? "ready" : s.loading ? "loading" : s.failures ? "failed" : "waiting";
  const refreshFailing = states.filter(([, s]) => s.loaded && (s.refreshFailures ?? 0) > 0).map(([level]) => level);
  const values = Object.values(levels);
  const status: HealthStatus = values.every((v) => v === "ready")
    ? "ready"
    : values.includes("failed")
      ? "degraded"
      : "starting";
  return { status, levels, ...(refreshFailing.length ? { refreshFailing } : {}) };
}

export const healthHttpStatus = (r: HealthReport) => (r.status === "ready" ? 200 : 503);
