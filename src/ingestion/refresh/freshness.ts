import type { Pool, PoolClient } from "pg";
import { MILB_LEVELS, milbLevelExternalIdPrefix, milbSeasonExternalId, type CompetitionLevelId } from "@/domain/levels";
import { MLB_SOURCE_ID } from "../sources/mlb-config";
import { ACTIVE_WINDOWS, isActive, type RefreshSource, type SeasonWindow } from "./schedule";

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
  /**
   * Per level: the latest SUCCESSFUL GAMES capture of that level's own source and season
   * (MiLB: a `milb:{season}:…:games|all:` capture whose level list includes the level; AFL:
   * `afl:{season}:all|games:`). An AFL or previous-season success never counts for a MiLB level.
   */
  lastSuccessByLevel: Partial<Record<CompetitionLevelId, RunRef | null>>;
  /** Failed or quarantined captures of the season after their source's last success (newest first). */
  failuresSinceSuccess: (RunRef & { source: RefreshSource })[];
  /** `running` captures older than the abandoned threshold: a process died mid-capture. */
  stuckRunning: RunRef[];
  /**
   * Minutes the current holder of the ingestion job lock has held it (null: no holder visible;
   * another role's sessions may be hidden, so run this check with the writer role to see it).
   */
  lockHeldForMinutes?: number | null;
  /** Latest final game with a complete boxscore, per level (null: none stored). */
  latestGame: Partial<Record<CompetitionLevelId, string | null>>;
}

export interface FreshnessPolicy {
  /** Max hours since a level's last successful capture while that level is in season. */
  maxSuccessAgeHours: number;
  /** A job lock held longer than this needs attention (a job normally finishes within 45 min). */
  maxLockHoldMinutes?: number;
  /** Max days between today and a level's latest game while that level is in season. */
  maxGameAgeDays: number;
}

export const DEFAULT_FRESHNESS: FreshnessPolicy = { maxSuccessAgeHours: 36, maxGameAgeDays: 4, maxLockHoldMinutes: 120 };

export type LevelVerdict = "fresh" | "stale" | "off-season" | "no-data";

export interface FreshnessReport extends FreshnessFacts {
  /** ok: nothing to do; stale: data is behind; attention: failures or dead captures to look at. */
  verdict: "ok" | "stale" | "attention";
  reasons: string[];
  levels: {
    level: CompetitionLevelId;
    latestGame: string | null;
    ageDays: number | null;
    lastSuccessAt: string | null;
    successAgeHours: number | null;
    verdict: LevelVerdict;
  }[];
}

const SOURCE_OF: Record<CompetitionLevelId, RefreshSource> = { aaa: "milb", aa: "milb", "high-a": "milb", "single-a": "milb", afl: "afl" };
const LEVELS: CompetitionLevelId[] = ["aaa", "aa", "high-a", "single-a", "afl"];

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Pure: facts + policy → verdict. */
export function assessFreshness(
  facts: FreshnessFacts,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS,
  windows: Record<RefreshSource, SeasonWindow> = ACTIVE_WINDOWS,
): FreshnessReport {
  const today = facts.now.slice(0, 10);
  const reasons: string[] = [];
  const levels = LEVELS.map((level) => {
    const latest = facts.latestGame[level] ?? null;
    const age = latest ? daysBetween(latest, today) : null;
    const success = facts.lastSuccessByLevel[level] ?? null;
    const successAgeH = success ? (Date.parse(facts.now) - Date.parse(success.at)) / 3_600_000 : null;
    const active = isActive(SOURCE_OF[level], today, windows);
    let verdict: LevelVerdict = "fresh";
    if (!active) verdict = "off-season";
    else if (latest === null) {
      verdict = "no-data";
      reasons.push(`${level}: in season but no complete game stored`);
    } else {
      if (age! > policy.maxGameAgeDays) {
        verdict = "stale";
        reasons.push(`${level}: latest game ${latest} is ${age} days old (max ${policy.maxGameAgeDays} in season)`);
      }
      if (successAgeH === null || successAgeH > policy.maxSuccessAgeHours) {
        verdict = "stale";
        reasons.push(
          success
            ? `${level}: its last successful capture was ${Math.round(successAgeH!)} h ago (max ${policy.maxSuccessAgeHours} h in season)`
            : `${level}: no successful ${facts.season} capture of this level recorded`,
        );
      }
    }
    return { level, latestGame: latest, ageDays: age, lastSuccessAt: success?.at ?? null, successAgeHours: successAgeH === null ? null : Math.round(successAgeH), verdict };
  });
  const stale = reasons.length > 0;
  if (facts.failuresSinceSuccess.length)
    reasons.push(`${facts.failuresSinceSuccess.length} failed/quarantined ${facts.season} capture(s) since their source's last success (latest: ${facts.failuresSinceSuccess[0].source} ${facts.failuresSinceSuccess[0].status}${facts.failuresSinceSuccess[0].errorCode ? ` ${facts.failuresSinceSuccess[0].errorCode}` : ""})`);
  const maxHold = policy.maxLockHoldMinutes ?? 120;
  if (facts.lockHeldForMinutes != null && facts.lockHeldForMinutes > maxHold)
    reasons.push(`the ingestion job lock has been held for ${facts.lockHeldForMinutes} min (max ${maxHold}): a job or manual apply may be stuck`);
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
    // Latest successful games capture per level, of the level's own source and season.
    const levelKeyPattern = (level: CompetitionLevelId) =>
      level === "afl"
        ? `^afl:${o.season}:(all|games):`
        : `^milb:${o.season}:([a-z-]+\\+)*${level}(\\+[a-z-]+)*:(all|games):`;
    const lastSuccessByLevel: FreshnessFacts["lastSuccessByLevel"] = {};
    for (const level of LEVELS) {
      const r = await c.query(
        `SELECT ${RUN_COLUMNS} FROM ingestion_runs r JOIN source_snapshots s ON s.id = r.snapshot_id
         WHERE r.provider = $1 AND r.status IN ('applied','applied-with-quarantine') AND r.completed_at IS NOT NULL
           AND s.snapshot_key ~ $2
         ORDER BY r.completed_at DESC LIMIT 1`,
        [MLB_SOURCE_ID, levelKeyPattern(level)],
      );
      lastSuccessByLevel[level] = r.rows[0] ? toRef(r.rows[0]) : null;
    }
    // Failures of this season per source, after that source's latest success.
    const failuresSinceSuccess: FreshnessFacts["failuresSinceSuccess"] = [];
    for (const source of ["milb", "afl"] as const) {
      const since = Object.entries(lastSuccessByLevel)
        .filter(([l, r]) => SOURCE_OF[l as CompetitionLevelId] === source && r)
        .map(([, r]) => r!.at)
        .sort()
        .at(-1);
      const f = await c.query(
        `SELECT ${RUN_COLUMNS} FROM ingestion_runs r JOIN source_snapshots s ON s.id = r.snapshot_id
         WHERE r.provider = $1 AND r.status IN ('failed','quarantined') AND s.snapshot_key LIKE $2
           AND coalesce(r.completed_at, r.created_at) > coalesce($3::timestamptz, '-infinity')
         ORDER BY coalesce(r.completed_at, r.created_at) DESC LIMIT 10`,
        [MLB_SOURCE_ID, `${source}:${o.season}:%`, since ?? null],
      );
      failuresSinceSuccess.push(...f.rows.map((row) => ({ ...toRef(row), source })));
    }
    failuresSinceSuccess.sort((a, b) => b.at.localeCompare(a.at));
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
    const holder = await c.query<{ age_ms: string | null }>(
      `SELECT (extract(epoch FROM now() - min(backend_start)) * 1000)::bigint AS age_ms
       FROM pg_stat_activity WHERE application_name = 'pt-ingestion-job-lock'`,
    );
    const heldMs = holder.rows[0]?.age_ms;
    return {
      now: o.now.toISOString(),
      season: o.season,
      lockHeldForMinutes: heldMs == null ? null : Math.round(Number(heldMs) / 60_000),
      lastSuccessByLevel,
      failuresSinceSuccess,
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
