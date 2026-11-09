import type { Pool, PoolClient } from "pg";
import { MILB_LEVELS, milbLevelExternalIdPrefix, milbSeasonExternalId, type CompetitionLevelId } from "@/domain/levels";
import { MLB_SOURCE_ID } from "../sources/mlb-config";
import { isActive, type RefreshSource } from "./schedule";

/**
 * Data freshness for operators, from what is actually stored: the latest complete game per level
 * and the outcomes recorded in `ingestion_runs` (every capture writes one row: running → applied /
 * applied-with-quarantine / quarantined / failed). Read-only: every query runs in a READ ONLY
 * transaction that is rolled back.
 */
export interface RunRef {
  id: string;
  at: string;
  status: string;
  snapshotKey: string;
  errorCode: string | null;
}

export interface FreshnessFacts {
  now: string;
  season: number;
  lastSuccess: RunRef | null;
  /** Failed or quarantined captures after the last success (newest first, at most 10). */
  failuresSinceSuccess: RunRef[];
  /** `running` captures older than the abandoned threshold: a process died mid-capture. */
  stuckRunning: RunRef[];
  /** Latest final game with a complete boxscore, per level (null: none stored). */
  latestGame: Partial<Record<CompetitionLevelId, string | null>>;
}

export interface FreshnessPolicy {
  /** Max hours since the last successful capture while any source is in season. */
  maxSuccessAgeHours: number;
  /** Max days between today and a level's latest game while that level is in season. */
  maxGameAgeDays: number;
}

export const DEFAULT_FRESHNESS: FreshnessPolicy = { maxSuccessAgeHours: 36, maxGameAgeDays: 4 };

export type LevelVerdict = "fresh" | "stale" | "off-season" | "no-data";

export interface FreshnessReport extends FreshnessFacts {
  /** ok: nothing to do; stale: data is behind; attention: failures or dead captures to look at. */
  verdict: "ok" | "stale" | "attention";
  reasons: string[];
  levels: { level: CompetitionLevelId; latestGame: string | null; ageDays: number | null; verdict: LevelVerdict }[];
}

const SOURCE_OF: Record<CompetitionLevelId, RefreshSource> = { aaa: "milb", aa: "milb", "high-a": "milb", "single-a": "milb", afl: "afl" };
const LEVELS: CompetitionLevelId[] = ["aaa", "aa", "high-a", "single-a", "afl"];

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Pure: facts + policy → verdict. */
export function assessFreshness(facts: FreshnessFacts, policy: FreshnessPolicy = DEFAULT_FRESHNESS): FreshnessReport {
  const today = facts.now.slice(0, 10);
  const reasons: string[] = [];
  const levels = LEVELS.map((level) => {
    const latest = facts.latestGame[level] ?? null;
    const age = latest ? daysBetween(latest, today) : null;
    const active = isActive(SOURCE_OF[level], today);
    const verdict: LevelVerdict = !active ? "off-season" : latest === null ? "no-data" : age! > policy.maxGameAgeDays ? "stale" : "fresh";
    if (verdict === "stale") reasons.push(`${level}: latest game ${latest} is ${age} days old (max ${policy.maxGameAgeDays} in season)`);
    if (verdict === "no-data") reasons.push(`${level}: in season but no complete game stored`);
    return { level, latestGame: latest, ageDays: age, verdict };
  });
  const anyActive = levels.some((l) => l.verdict !== "off-season");
  if (anyActive) {
    const ageH = facts.lastSuccess ? (Date.parse(facts.now) - Date.parse(facts.lastSuccess.at)) / 3_600_000 : Infinity;
    if (ageH > policy.maxSuccessAgeHours)
      reasons.push(
        facts.lastSuccess
          ? `last successful capture ${Math.round(ageH)} h ago (max ${policy.maxSuccessAgeHours} h in season)`
          : "no successful capture recorded",
      );
  }
  const stale = reasons.length > 0;
  if (facts.failuresSinceSuccess.length)
    reasons.push(`${facts.failuresSinceSuccess.length} failed/quarantined capture(s) since the last success (latest: ${facts.failuresSinceSuccess[0].status}${facts.failuresSinceSuccess[0].errorCode ? ` ${facts.failuresSinceSuccess[0].errorCode}` : ""})`);
  if (facts.stuckRunning.length) reasons.push(`${facts.stuckRunning.length} capture(s) stuck in 'running' (process died; the next job marks them abandoned)`);
  return {
    ...facts,
    verdict: stale ? "stale" : reasons.length ? "attention" : "ok",
    reasons,
    levels,
  };
}

export const freshnessExitCode = (r: FreshnessReport) => (r.verdict === "ok" ? 0 : 1);

async function readOnly<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN READ ONLY");
    await c.query("SET LOCAL statement_timeout = '30s'");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

const RUN_COLUMNS = `r.id::text AS id, coalesce(r.completed_at, r.created_at) AS at, r.status, s.snapshot_key AS "snapshotKey", r.error_code AS "errorCode"`;
const toRef = (r: { id: string; at: Date; status: string; snapshotKey: string; errorCode: string | null }): RunRef => ({
  ...r,
  at: new Date(r.at).toISOString(),
});

export async function readFreshnessFacts(
  pool: Pool,
  o: { season: number; now: Date; abandonedAfterMs: number },
): Promise<FreshnessFacts> {
  return readOnly(pool, async (c) => {
    const success = await c.query(
      `SELECT ${RUN_COLUMNS} FROM ingestion_runs r JOIN source_snapshots s ON s.id = r.snapshot_id
       WHERE r.provider = $1 AND r.status IN ('applied','applied-with-quarantine') AND r.completed_at IS NOT NULL
       ORDER BY r.completed_at DESC LIMIT 1`,
      [MLB_SOURCE_ID],
    );
    const lastSuccess = success.rows[0] ? toRef(success.rows[0]) : null;
    const failures = await c.query(
      `SELECT ${RUN_COLUMNS} FROM ingestion_runs r JOIN source_snapshots s ON s.id = r.snapshot_id
       WHERE r.provider = $1 AND r.status IN ('failed','quarantined')
         AND coalesce(r.completed_at, r.created_at) > coalesce($2::timestamptz, '-infinity')
       ORDER BY coalesce(r.completed_at, r.created_at) DESC LIMIT 10`,
      [MLB_SOURCE_ID, lastSuccess?.at ?? null],
    );
    const stuck = await c.query(
      `SELECT ${RUN_COLUMNS} FROM ingestion_runs r JOIN source_snapshots s ON s.id = r.snapshot_id
       WHERE r.provider = $1 AND r.status = 'running' AND r.created_at < $2::timestamptz
       ORDER BY r.created_at LIMIT 20`,
      [MLB_SOURCE_ID, new Date(o.now.getTime() - o.abandonedAfterMs).toISOString()],
    );
    const latestGame: FreshnessFacts["latestGame"] = {};
    const latest = async (seasonExternalId: string, levelPrefix: string | null) =>
      (
        await c.query<{ latest: string | null }>(
          `SELECT max(coalesce(g.official_date, (g.starts_at AT TIME ZONE 'UTC')::date))::text AS latest
           FROM games g
           JOIN source_identities ss ON ss.internal_id = g.season_id AND ss.provider = $1
            AND ss.entity_kind = 'season' AND ss.external_id = $2
           JOIN teams t ON t.id = g.home_team_id
           LEFT JOIN source_identities sl ON sl.internal_id = t.level_id AND sl.provider = $1 AND sl.entity_kind = 'level'
           WHERE g.status = 'final' AND g.boxscore_complete AND ($3::text IS NULL OR sl.external_id LIKE $3 || '%')`,
          [MLB_SOURCE_ID, seasonExternalId, levelPrefix],
        )
      ).rows[0]?.latest ?? null;
    for (const [level, def] of Object.entries(MILB_LEVELS))
      latestGame[level as CompetitionLevelId] = await latest(milbSeasonExternalId(o.season), milbLevelExternalIdPrefix(def.sportId));
    latestGame.afl = await latest(`afl-${o.season}`, null);
    return {
      now: o.now.toISOString(),
      season: o.season,
      lastSuccess,
      failuresSinceSuccess: failures.rows.map(toRef),
      stuckRunning: stuck.rows.map(toRef),
      latestGame,
    };
  });
}

/** When the latest MiLB structure capture (leagues/teams/rosters/people) was applied. */
export async function lastStructureAppliedAt(pool: Pool, season: number): Promise<Date | null> {
  return readOnly(pool, async (c) => {
    const r = await c.query<{ at: Date | null }>(
      `SELECT max(r.completed_at) AS at FROM ingestion_runs r JOIN source_snapshots s ON s.id = r.snapshot_id
       WHERE r.provider = $1 AND r.status IN ('applied','applied-with-quarantine')
         AND s.snapshot_key LIKE $2`,
      [MLB_SOURCE_ID, `milb:${season}:%:structure:%`],
    );
    return r.rows[0]?.at ? new Date(r.rows[0].at) : null;
  });
}

/**
 * Marks `running` captures older than `olderThanMs` as failed/`abandoned`. A capture inserts its
 * `running` row right before its single apply transaction (bounded by statement and idle timeouts),
 * so a row that old belongs to a process that died; its transaction was already rolled back by the
 * server. Call only while holding the job lock. Returns the number of rows updated.
 */
export async function recoverAbandonedRuns(pool: Pool, olderThanMs: number): Promise<number> {
  const r = await pool.query(
    `UPDATE ingestion_runs SET status = 'failed', error_code = 'abandoned', completed_at = now()
     WHERE provider = $1 AND status = 'running' AND created_at < now() - make_interval(secs => $2)`,
    [MLB_SOURCE_ID, olderThanMs / 1000],
  );
  return r.rowCount ?? 0;
}
