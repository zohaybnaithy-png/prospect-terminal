/**
 * Guarded, resumable full-season MiLB backfill on top of the existing pipeline.
 *
 * It adds orchestration only; every write still goes through runMilbIngestion →
 * MilbStatsApiSource → buildPlan → PostgresIngestionSink (one transaction per chunk). Per level:
 *
 *   1. coverage  — the season's real schedule dates for the level, read from the Stats API
 *   2. structure — one structure capture (teams, organizations, rosters, people)
 *   3. chunks    — consecutive 7-day games captures, each followed by read-only integrity checks
 *   4. level     — level-wide checks, read-only idempotency previews of sample chunks, report
 *
 * Progress lives in a local state file. A chunk is skipped on restart only when the database
 * confirms it: its recorded ingestion run exists with the same snapshot key and status, and no
 * final game in its range lacks a complete box score. Anything else is re-run (idempotent).
 * Failures are retried with backoff and then stop the run; nothing is skipped silently.
 *
 * Framework-free and dependency-injected so it is testable offline (scripts/milb-backfill.test.ts).
 * Database reads are plain SQL strings executed by a read-only helper (scripts/ops/pg-readonly.mjs).
 */
import { z } from "zod";
import {
  MILB_LEVELS,
  milbLevelExternalIdPrefix,
  milbSeasonExternalId,
  type MilbLevelId,
} from "@/domain/levels";
import { planDateChunks, type ChunkSummary, type MilbRunSummary } from "./milb-runner";
import type { MilbGameType } from "./sources/milb-config";
import { milbSnapshotKey } from "./sources/milb-stats-api";
import { MLB_SOURCE_ID } from "./sources/mlb-config";
import { schemaProblems, type ExpectedMigration, type ServerFacts } from "./db-target";

export const BACKFILL_STATE_VERSION = 1;
/** Notice reasons that are informational for affiliated levels (docs/MILB-INGESTION.md). */
export const HARMLESS_NOTICES = new Set([
  "reconciled-reschedule",
  "outside-scope",
  "discovery-fallback",
  "reused-boxscores",
]);

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export interface LevelCoverage {
  level: MilbLevelId;
  sportId: number;
  /** Regular-season dates from `seasons/{year}?sportId=` (null when the API has none). */
  regularSeason: { start: string; end: string } | null;
  /** First and last schedule date of the selected game types. */
  first: string;
  last: string;
  dates: number;
  rows: number;
  gamePks: number;
  /** Distinct gamePks with at least one Final / Completed Early representation. */
  finalGamePks: number;
  statuses: Record<string, number>;
  warnings: string[];
}

export interface IngestRequest {
  level: MilbLevelId;
  mode: "structure" | "games";
  from?: string;
  to?: string;
  apply: boolean;
  refetchComplete?: boolean;
}

export interface CheckResult {
  /** Must be 0; any other value stops the backfill. */
  hard: Record<string, number>;
  /** Informational; recorded for review. */
  review: Record<string, number>;
  samples: Record<string, string[]>;
  games: number;
  completeGames: number;
  battingLines: number;
  pitchingLines: number;
}

export interface ChunkState {
  from: string;
  to: string;
  key: string;
  status: ChunkSummary["status"];
  runId?: string;
  attempts: number;
  records?: number;
  changed?: number;
  unchanged?: number;
  issues?: number;
  notices?: number;
  noticeReasons?: Record<string, number>;
  issueCodes?: Record<string, number>;
  checks?: CheckResult;
  checksPassed: boolean;
  error?: string;
  at: string;
}

export interface Fingerprint {
  aflGames: number;
  aflGamesHash: string;
  aflBatting: number;
  aflBattingHash: string;
  aflPitching: number;
  aflPitchingHash: string;
  aflPlayersHash: string;
  priorLines: number;
  priorLinesHash: string;
}

export interface LevelState {
  coverage?: LevelCoverage;
  structure?: ChunkState;
  chunks: Record<string, ChunkState>;
  completedAt?: string;
  report?: LevelReport;
}

export interface BackfillState {
  version: number;
  season: number;
  gameTypes: MilbGameType[];
  chunkDays: number;
  target: { endpoint: string; database: string; timeline: string | null };
  createdAt: string;
  baseline: { at: string; priorGameIds: string[]; fingerprint: Fingerprint };
  levels: Partial<Record<MilbLevelId, LevelState>>;
}

export interface IdempotencyResult {
  from: string;
  to: string;
  status: string;
  insert: number;
  update: number;
  unchanged: number;
  /** Updates per record kind; only `game` rows of reconciled cross-chunk games may differ. */
  updatesByKind: Record<string, number>;
  allowedGameUpdates: number;
  issues: number;
  expectedIssues: number;
  countsUnchanged: boolean;
  passed: boolean;
}

export interface LevelReport {
  level: MilbLevelId;
  status: "complete" | "complete-with-review" | "stopped";
  coverage: LevelCoverage;
  chunks: { planned: number; applied: number; skippedVerified: number; withQuarantine: number };
  totals: { records: number; changed: number; unchanged: number; issues: number; notices: number };
  noticeReasons: Record<string, number>;
  checks?: CheckResult & { global: Record<string, number> };
  completeness?: {
    storedGames: number;
    apiGamePks: number;
    storedComplete: number;
    apiFinalGamePks: number;
  };
  idempotency: IdempotencyResult[];
  review: string[];
}

export interface BackfillReport {
  status: "planned" | "complete" | "complete-with-review" | "stopped" | "refused";
  apply: boolean;
  target: { endpoint: string; database: string; timeline: string | null };
  season: number;
  levels: MilbLevelId[];
  plan?: {
    level: MilbLevelId;
    coverage: LevelCoverage;
    chunks: { from: string; to: string; verified: boolean }[];
    /** What the database holds for the level today (read-only checks over the season range). */
    current: CheckResult;
  }[];
  /** Plan mode: the baseline an apply would record. */
  baselinePreview?: { priorGames: number; fingerprint: Fingerprint };
  globalBefore?: Record<string, number>;
  levelReports: LevelReport[];
  preserved?: { passed: boolean; changed: string[]; informational: string[] };
  countsBefore?: Record<string, number>;
  countsAfter?: Record<string, number>;
  stop?: { reason: string; level?: MilbLevelId; from?: string; to?: string };
  next?: string;
}

export interface BackfillConfig {
  season: number;
  levels: MilbLevelId[];
  gameTypes: MilbGameType[];
  chunkDays: number;
  apply: boolean;
  /** Keep going after a chunk with quarantined records (they stay listed for review). */
  continueOnQuarantine: boolean;
  /** Re-run chunks even when the database verifies them complete. */
  recheck: boolean;
  retries: number;
  retryBaseMs: number;
  chunkPauseMs: number;
  idempotencySamples: number;
  target: { endpoint: string; database: string };
  expected: { migrations: ExpectedMigration[]; tables: string[] };
  /** Snapshot key that only the approved test branch has (the guarded AAA week import). */
  evidenceSnapshotKey?: string;
}

export interface BackfillDeps {
  coverage(level: MilbLevelId): Promise<LevelCoverage>;
  ingest(request: IngestRequest): Promise<MilbRunSummary>;
  /** Runs one read-only SELECT returning a single JSON value; resolves to the parsed value. */
  query(sql: string): Promise<unknown>;
  loadState(): Promise<BackfillState | null>;
  saveState(state: BackfillState): Promise<void>;
  writeReport(name: string, body: unknown): Promise<void>;
  /** Saves the human-readable integrity report (scripts/sql/milb-integrity-checks.sql). */
  integrityReport?(name: string): Promise<void>;
  log(event: string, fields?: Record<string, string | number | boolean | undefined>): void;
  sleep(ms: number): Promise<void>;
  now(): Date;
  interrupted(): boolean;
}

// ---------------------------------------------------------------------------------------------
// Coverage discovery (Stats API, read-only)
// ---------------------------------------------------------------------------------------------

type Get = (path: string, params?: Record<string, string | number | undefined>) => Promise<unknown>;

const isoDate = z.iso.date();
const seasonsBody = z.object({
  seasons: z
    .array(
      z.object({
        regularSeasonStartDate: isoDate.optional(),
        regularSeasonEndDate: isoDate.optional(),
      }),
    )
    .max(5),
});
const scheduleBody = z.object({
  dates: z
    .array(
      z.object({
        date: isoDate,
        games: z
          .array(
            z.object({
              gamePk: z.number().int().positive(),
              status: z.object({ detailedState: z.string().optional() }).optional(),
            }),
          )
          .max(500),
      }),
    )
    .max(400),
});

/** Real schedule coverage of one level and season, from the Stats API (no assumptions). */
export async function discoverCoverage(
  get: Get,
  season: number,
  level: MilbLevelId,
  gameTypes: MilbGameType[],
): Promise<LevelCoverage> {
  const sportId = MILB_LEVELS[level].sportId;
  const seasons = seasonsBody.parse(await get(`seasons/${season}`, { sportId }));
  const s = seasons.seasons[0];
  const regularSeason =
    s?.regularSeasonStartDate && s.regularSeasonEndDate
      ? { start: s.regularSeasonStartDate, end: s.regularSeasonEndDate }
      : null;
  const dates = new Set<string>();
  const pks = new Set<number>();
  const finals = new Set<number>();
  const statuses: Record<string, number> = {};
  let rows = 0;
  for (const gameType of gameTypes) {
    const body = scheduleBody.parse(
      await get("schedule", {
        sportId,
        season,
        gameType,
        fields: "dates,date,games,gamePk,status,detailedState",
      }),
    );
    for (const d of body.dates)
      for (const g of d.games) {
        rows++;
        dates.add(d.date);
        pks.add(g.gamePk);
        const state = g.status?.detailedState ?? "unknown";
        statuses[state] = (statuses[state] ?? 0) + 1;
        if (state === "Final" || state === "Completed Early") finals.add(g.gamePk);
      }
  }
  const sorted = [...dates].sort();
  if (!sorted.length) throw new Error(`No ${level} ${season} schedule dates for game types ${gameTypes.join(",")}`);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  for (const d of [first, last])
    if (d.slice(0, 4) !== String(season)) throw new Error(`${level} schedule date ${d} is outside season ${season}`);
  const warnings: string[] = [];
  if (!regularSeason) warnings.push("seasons endpoint has no regular-season dates");
  else if (gameTypes.length === 1 && gameTypes[0] === "R" && (first < regularSeason.start || last > regularSeason.end))
    warnings.push(`schedule ${first}..${last} extends beyond regular season ${regularSeason.start}..${regularSeason.end}`);
  const pending = Object.entries(statuses)
    .filter(([k]) => !["Final", "Completed Early", "Postponed", "Cancelled"].includes(k))
    .map(([k, v]) => `${k}: ${v}`);
  if (pending.length) warnings.push(`non-terminal schedule rows (${pending.join(", ")})`);
  return {
    level,
    sportId,
    regularSeason,
    first,
    last,
    dates: sorted.length,
    rows,
    gamePks: pks.size,
    finalGamePks: finals.size,
    statuses,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// SQL (read-only; values are validated before they are inlined)
// ---------------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[a-z0-9:+-]+$/;
const lit = (value: string, pattern: RegExp) => {
  if (!pattern.test(value)) throw new Error("refusing to inline an unexpected SQL value");
  return `'${value}'`;
};
const P = `'${MLB_SOURCE_ID}'`;

/** Level ids (rows of `levels`) for a sport: one per (sport, league). */
const levelIdsOf = (sportId: number) =>
  `(select si.internal_id from source_identities si where si.provider = ${P} and si.entity_kind = 'level' and si.external_id like '${milbLevelExternalIdPrefix(Math.trunc(sportId))}%')`;
const leagueIdsOf = (sportId: number) => `(select lv.league_id from levels lv where lv.id in ${levelIdsOf(sportId)})`;
const seasonIdOf = (season: number) =>
  `(select si.internal_id from source_identities si where si.provider = ${P} and si.entity_kind = 'season' and si.external_id = '${milbSeasonExternalId(Math.trunc(season))}')`;

/** Games of one level and season, optionally within an official-date range. */
export function levelGames(sportId: number, season: number, from?: string, to?: string) {
  const range =
    from && to
      ? ` and coalesce(g.official_date, (g.starts_at at time zone 'UTC')::date) between ${lit(from, DATE)} and ${lit(to, DATE)}`
      : "";
  return `g.league_id in ${leagueIdsOf(sportId)} and g.season_id in ${seasonIdOf(season)}${range}`;
}

const gamePkOf = (alias: string) =>
  `(select si.external_id from source_identities si where si.internal_id = ${alias}.id and si.provider = ${P} and si.entity_kind = 'game' limit 1)`;

/**
 * Integrity checks for a level's games in a range (or the whole season), as one JSON object.
 * Lines are aggregated once per (game, team) in CTEs and joined back, so the cost is a few scans
 * of each table (the line tables have no game_id index; correlated per-game subqueries would
 * scan them once per game).
 */
export function checksSql(sportId: number, season: number, from?: string, to?: string) {
  const final = `g.status = 'final' and g.boxscore_complete`;
  const runsMismatch = `${final} and (g.bat_home <> g.home_score or g.bat_away <> g.away_score)`;
  const allowedMismatch = `${final} and (g.pit_home <> g.away_score or g.pit_away <> g.home_score)`;
  const missingSide = `${final} and (g.bat_home_n = 0 or g.bat_away_n = 0 or g.pit_home_n = 0 or g.pit_away_n = 0)`;
  const pending = `g.status in ('scheduled', 'in-progress')`;
  const finalIncomplete = `g.status = 'final' and not g.boxscore_complete`;
  const linesOnIncomplete = `not g.boxscore_complete and g.lines_n > 0`;
  const sample = (where: string) =>
    `(select coalesce(json_agg(s.pk), '[]'::json) from (select ${gamePkOf("g")} as pk from gs g where ${where} order by g.starts_at limit 20) s)`;
  const side = (table: string, team: string, alias: string) =>
    `left join ${table} ${alias} on ${alias}.game_id = g.id and ${alias}.team_id = g.${team}`;
  return `with lg as (select g.* from games g where ${levelGames(sportId, season, from, to)}),
lb as (select b.* from player_batting_games b where b.game_id in (select id from lg)),
lp as (select p.* from player_pitching_games p where p.game_id in (select id from lg)),
bs as (select game_id, team_id, sum(runs) as runs, count(*) as n from lb group by game_id, team_id),
ps as (select game_id, team_id, sum(runs) as runs, count(*) as n from lp group by game_id, team_id),
la as (select game_id, sum(n) as n from (select game_id, n from bs union all select game_id, n from ps) x group by game_id),
gs as (select g.id, g.starts_at, g.status, g.boxscore_complete, g.home_score, g.away_score, g.home_team_id, g.away_team_id,
    bh.runs as bat_home, ba.runs as bat_away, ph.runs as pit_home, pa.runs as pit_away,
    coalesce(bh.n, 0) as bat_home_n, coalesce(ba.n, 0) as bat_away_n, coalesce(ph.n, 0) as pit_home_n, coalesce(pa.n, 0) as pit_away_n,
    coalesce(la.n, 0) as lines_n
  from lg g ${side("bs", "home_team_id", "bh")} ${side("bs", "away_team_id", "ba")}
    ${side("ps", "home_team_id", "ph")} ${side("ps", "away_team_id", "pa")} left join la on la.game_id = g.id)
select json_build_object(
  'games', (select count(*) from gs),
  'completeGames', (select count(*) from gs g where ${final}),
  'battingLines', (select count(*) from lb),
  'pitchingLines', (select count(*) from lp),
  'hard', json_build_object(
    'finalMissingLines', (select count(*) from gs g where ${missingSide}),
    'finalWithoutScore', (select count(*) from gs g where g.status = 'final' and (g.home_score is null or g.away_score is null)),
    'teamOutsideLevel', (select count(*) from lg g join teams th on th.id = g.home_team_id join teams ta on ta.id = g.away_team_id
        where th.level_id not in ${levelIdsOf(sportId)} or ta.level_id not in ${levelIdsOf(sportId)} or g.home_team_id = g.away_team_id),
    'lineTeamNotInGame', (select count(*) from lb b join lg g on g.id = b.game_id where b.team_id not in (g.home_team_id, g.away_team_id))
       + (select count(*) from lp p join lg g on g.id = p.game_id where p.team_id not in (g.home_team_id, g.away_team_id)),
    'impossibleBatting', (select count(*) from lb b where b.plate_appearances < 0 or b.at_bats < 0 or b.hits < 0 or b.doubles < 0
        or b.triples < 0 or b.home_runs < 0 or b.walks < 0 or b.strikeouts < 0 or b.hit_by_pitch < 0 or b.sacrifice_flies < 0
        or b.stolen_bases < 0 or coalesce(b.runs, 0) < 0 or coalesce(b.rbi, 0) < 0
        or b.at_bats > b.plate_appearances or b.hits > b.at_bats or b.doubles + b.triples + b.home_runs > b.hits
        or b.strikeouts > b.plate_appearances or b.walks > b.plate_appearances),
        -- No runs-vs-PA rule: pinch runners and extra-inning automatic runners score without a PA.
    'impossiblePitching', (select count(*) from lp p where p.outs_recorded < 0 or p.batters_faced < 0 or p.hits_allowed < 0
        or p.earned_runs < 0 or p.walks < 0 or p.strikeouts < 0 or p.home_runs_allowed < 0 or coalesce(p.runs, 0) < 0
        or p.earned_runs > coalesce(p.runs, p.earned_runs) or p.home_runs_allowed > p.hits_allowed
        or p.hits_allowed > p.batters_faced or p.strikeouts > p.batters_faced or p.walks > p.batters_faced),
    'finalIncomplete', (select count(*) from gs g where ${finalIncomplete})
  ),
  'review', json_build_object(
    'runsVsScoreMismatch', (select count(*) from gs g where ${runsMismatch}),
    'runsAllowedVsScoreMismatch', (select count(*) from gs g where ${allowedMismatch}),
    'pendingGames', (select count(*) from gs g where ${pending}),
    'linesOnIncompleteGame', (select count(*) from gs g where ${linesOnIncomplete})
  ),
  'samples', json_build_object(
    'runsVsScoreMismatch', ${sample(runsMismatch)},
    'runsAllowedVsScoreMismatch', ${sample(allowedMismatch)},
    'pendingGames', ${sample(pending)},
    'finalIncomplete', ${sample(finalIncomplete)},
    'finalMissingLines', ${sample(missingSide)}
  )
)`;
}

/** Whole-database invariants: duplicate identities/lines and identities without their row. */
export function globalChecksSql() {
  const orphan = (kind: string, table: string) =>
    `(select count(*) from source_identities si where si.provider = ${P} and si.entity_kind = '${kind}' and not exists (select 1 from ${table} t where t.id = si.internal_id))`;
  return `select json_build_object(
  'dupIdentities', (select count(*) from (select 1 from source_identities group by provider, entity_kind, external_id having count(*) > 1) x),
  'dupInternalIdentities', (select count(*) from (select 1 from source_identities where provider = ${P} group by entity_kind, internal_id having count(*) > 1) x),
  'dupBatting', (select count(*) from (select 1 from player_batting_games group by player_id, game_id having count(*) > 1) x),
  'dupPitching', (select count(*) from (select 1 from player_pitching_games group by player_id, game_id having count(*) > 1) x),
  'orphanIdentities', ${[
    ["league", "leagues"],
    ["level", "levels"],
    ["season", "seasons"],
    ["organization", "organizations"],
    ["team", "teams"],
    ["player", "players"],
    ["game", "games"],
  ]
    .map(([k, t]) => orphan(k, t))
    .join(" + ")},
  'orphanLines', (select count(*) from player_batting_games b where not exists (select 1 from games g where g.id = b.game_id) or not exists (select 1 from players p where p.id = b.player_id))
     + (select count(*) from player_pitching_games b where not exists (select 1 from games g where g.id = b.game_id) or not exists (select 1 from players p where p.id = b.player_id)),
  'gamesWithoutIdentity', (select count(*) from games g where not exists (select 1 from source_identities si where si.internal_id = g.id and si.entity_kind = 'game'))
)`;
}

/** Row counts of the ingested tables (no data values). */
export const COUNTS_SQL = `select json_build_object(
  'games', (select count(*) from games), 'players', (select count(*) from players),
  'teams', (select count(*) from teams), 'organizations', (select count(*) from organizations),
  'batting', (select count(*) from player_batting_games), 'pitching', (select count(*) from player_pitching_games),
  'identities', (select count(*) from source_identities), 'rosterObs', (select count(*) from source_roster_observations),
  'issues', (select count(*) from ingestion_issues), 'runs', (select count(*) from ingestion_runs))`;

const hashOf = (alias: string, from: string, order: string) =>
  `(select md5(coalesce(string_agg((to_jsonb(${alias}) - 'created_at' - 'updated_at')::text, ',' order by ${order}), '')) from ${from})`;

/** Fingerprints of data that must not change: AFL games/lines and lines of previously complete games. */
export function fingerprintSql(priorGameIds: string[]) {
  const AFL = `(select g.id from games g where g.league_id in (select si.internal_id from source_identities si where si.provider = ${P} and si.entity_kind = 'league' and si.external_id = '119'))`;
  const prior = priorGameIds.length ? `(${priorGameIds.map((id) => lit(id, UUID)).join(",")})` : `(null::uuid)`;
  return `select json_build_object(
  'aflGames', (select count(*) from games g where g.id in ${AFL}),
  'aflGamesHash', ${hashOf("g", `games g where g.id in ${AFL}`, "g.id")},
  'aflBatting', (select count(*) from player_batting_games b where b.game_id in ${AFL}),
  'aflBattingHash', ${hashOf("b", `player_batting_games b where b.game_id in ${AFL}`, "b.player_id, b.game_id")},
  'aflPitching', (select count(*) from player_pitching_games b where b.game_id in ${AFL}),
  'aflPitchingHash', ${hashOf("b", `player_pitching_games b where b.game_id in ${AFL}`, "b.player_id, b.game_id")},
  'aflPlayersHash', ${hashOf("p", `players p where p.id in (select b.player_id from player_batting_games b where b.game_id in ${AFL} union select b.player_id from player_pitching_games b where b.game_id in ${AFL})`, "p.id")},
  'priorLines', (select count(*) from player_batting_games b where b.game_id in ${prior}) + (select count(*) from player_pitching_games b where b.game_id in ${prior}),
  'priorLinesHash', md5(${hashOf("b", `player_batting_games b where b.game_id in ${prior}`, "b.player_id, b.game_id")} || ${hashOf("b", `player_pitching_games b where b.game_id in ${prior}`, "b.player_id, b.game_id")})
)`;
}

/** Complete MiLB games stored before the backfill (their lines must stay byte-identical). */
export const PRIOR_GAMES_SQL = `select coalesce(json_agg(g.id order by g.id), '[]'::json) from games g
  where g.boxscore_complete and g.league_id not in (select si.internal_id from source_identities si where si.provider = ${P} and si.entity_kind = 'league' and si.external_id = '119')`;

/** Target identity, schema and branch evidence. */
export function targetFactsSql(evidenceSnapshotKey?: string) {
  return `select json_build_object(
  'database', current_database(),
  'schema', current_schema(),
  'timeline', current_setting('neon.timeline_id', true),
  'migrations', (select json_agg(json_build_object('hash', m.hash, 'createdAt', m.created_at) order by m.created_at, m.id) from drizzle.__drizzle_migrations m),
  'tables', (select json_agg(t.table_name order by t.table_name) from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE'),
  'aflLeague', (select count(*) from source_identities si where si.provider = ${P} and si.entity_kind = 'league' and si.external_id = '119'),
  'evidenceRuns', ${
    evidenceSnapshotKey
      ? `(select count(*) from ingestion_runs r join source_snapshots s on s.id = r.snapshot_id where s.snapshot_key = ${lit(evidenceSnapshotKey, KEY)} and r.status = 'applied')`
      : "null"
  },
  'recentRunning', (select count(*) from ingestion_runs r where r.status = 'running' and r.created_at > now() - interval '30 minutes')
)`;
}

/** Database confirmation that a recorded chunk is complete. */
export function verifySql(runId: string, key: string, sportId: number, season: number, from?: string, to?: string) {
  const games = from && to ? `(select g.* from games g where ${levelGames(sportId, season, from, to)})` : null;
  return `select json_build_object(
  'runStatus', (select r.status from ingestion_runs r join source_snapshots s on s.id = r.snapshot_id where r.id = ${lit(runId, UUID)} and s.snapshot_key = ${lit(key, KEY)}),
  'games', ${games ? `(select count(*) from ${games} g)` : "null"},
  'finalIncomplete', ${games ? `(select count(*) from ${games} g where g.status = 'final' and not g.boxscore_complete)` : "0"}
)`;
}

export function runIssuesSql(runId: string) {
  return `select coalesce(json_object_agg(x.code, x.n), '{}'::json) from (select i.code, count(*) as n from ingestion_issues i where i.run_id = ${lit(runId, UUID)} group by i.code) x`;
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

const targetFacts = z.object({
  database: z.string(),
  schema: z.string(),
  timeline: z.string().nullable(),
  migrations: z.array(z.object({ hash: z.string(), createdAt: z.union([z.number(), z.string()]) })).nullable(),
  tables: z.array(z.string()).nullable(),
  aflLeague: z.number(),
  evidenceRuns: z.number().nullable(),
  recentRunning: z.number(),
});
const checkResult = z.object({
  games: z.number(),
  completeGames: z.number(),
  battingLines: z.number(),
  pitchingLines: z.number(),
  hard: z.record(z.string(), z.number()),
  review: z.record(z.string(), z.number()),
  samples: z.record(z.string(), z.array(z.string().nullable()).transform((a) => a.filter((x): x is string => !!x))),
});
const verifyResult = z.object({
  runStatus: z.string().nullable(),
  games: z.number().nullable(),
  finalIncomplete: z.number(),
});
const fingerprintResult = z.object({
  aflGames: z.number(),
  aflGamesHash: z.string(),
  aflBatting: z.number(),
  aflBattingHash: z.string(),
  aflPitching: z.number(),
  aflPitchingHash: z.string(),
  aflPlayersHash: z.string(),
  priorLines: z.number(),
  priorLinesHash: z.string(),
});
const counts = z.record(z.string(), z.number());

class Stop extends Error {
  constructor(
    readonly reason: string,
    readonly where: { level?: MilbLevelId; from?: string; to?: string } = {},
  ) {
    super(reason);
  }
}

const chunkKeyOf = (from: string, to: string) => `${from}..${to}`;
const snapshotKeyFor = (season: number, level: MilbLevelId, mode: "structure" | "games", from?: string, to?: string) =>
  milbSnapshotKey({ season, levels: [level], mode, ...(from && to ? { from, to } : {}) });

/** Compares fingerprints; AFL players may legitimately gain MiLB enrichment (informational). */
export function compareFingerprints(before: Fingerprint, after: Fingerprint) {
  const changed: string[] = [];
  const informational: string[] = [];
  for (const key of Object.keys(before) as (keyof Fingerprint)[]) {
    if (before[key] === after[key]) continue;
    (key === "aflPlayersHash" ? informational : changed).push(key);
  }
  return { passed: changed.length === 0, changed, informational };
}

/** Evenly spaced sample of chunks that contain games (first, middle, last …). */
export function sampleChunks<T extends { checks?: CheckResult }>(chunks: T[], n: number): T[] {
  const withGames = chunks.filter((c) => (c.checks?.completeGames ?? 0) > 0);
  if (n <= 0 || !withGames.length) return [];
  if (withGames.length <= n) return withGames;
  const picks = new Set<number>();
  for (let i = 0; i < n; i++) picks.add(Math.round((i * (withGames.length - 1)) / Math.max(1, n - 1)));
  return [...picks].sort((a, b) => a - b).map((i) => withGames[i]);
}

/**
 * Judges a read-only preview of an applied chunk. Nothing may be inserted, and nothing but `game`
 * rows may be updated: a suspended game resumed in a neighbouring chunk is represented
 * differently by each window (origin vs. resumption row), so a re-preview may differ on that
 * game row only, bounded by the preview's reconciled-reschedule notices. Lines never may.
 */
export function idempotencyResult(
  s: Pick<ChunkState, "from" | "to" | "issues">,
  c: ChunkSummary | undefined,
  countsUnchanged: boolean,
): IdempotencyResult {
  const cmp = c?.databaseComparison ?? { insert: -1, update: -1, unchanged: 0 };
  const updatesByKind = Object.fromEntries(
    Object.entries(cmp.byKind ?? {})
      .filter(([, v]) => v.update)
      .map(([k, v]) => [k, v.update]),
  );
  const allowedGameUpdates = c?.noticeReasons?.["reconciled-reschedule"] ?? 0;
  const otherUpdates = Object.entries(updatesByKind).filter(([k]) => k !== "game").reduce((a, [, n]) => a + n, 0);
  const result: IdempotencyResult = {
    from: s.from,
    to: s.to,
    status: c?.status ?? "missing",
    insert: cmp.insert,
    update: cmp.update,
    unchanged: cmp.unchanged,
    updatesByKind,
    allowedGameUpdates,
    issues: c?.issues ?? -1,
    expectedIssues: s.issues ?? 0,
    countsUnchanged,
    passed: false,
  };
  const byKindKnown = cmp.byKind !== undefined || cmp.update === 0;
  result.passed =
    c?.status !== "failed" &&
    cmp.insert === 0 &&
    byKindKnown &&
    otherUpdates === 0 &&
    (updatesByKind.game ?? 0) <= allowedGameUpdates &&
    (updatesByKind.game ?? 0) + otherUpdates === cmp.update &&
    result.issues === result.expectedIssues &&
    countsUnchanged;
  return result;
}

const hardFailures = (c: CheckResult, allowFinalIncomplete: boolean) =>
  Object.entries(c.hard).filter(([k, v]) => v !== 0 && !(allowFinalIncomplete && k === "finalIncomplete"));

export async function runBackfill(config: BackfillConfig, deps: BackfillDeps): Promise<BackfillReport> {
  const report: BackfillReport = {
    status: config.apply ? "complete" : "planned",
    apply: config.apply,
    target: { ...config.target, timeline: null },
    season: config.season,
    levels: config.levels,
    levelReports: [],
  };
  const q = async <T>(schema: z.ZodType<T>, sql: string): Promise<T> => schema.parse(await deps.query(sql));
  let state: BackfillState | null = null;
  const save = async () => {
    if (state && config.apply) await deps.saveState(state);
  };
  try {
    // 1. Target identity, schema and branch evidence (read-only).
    deps.log("backfill:preflight", { endpoint: config.target.endpoint });
    const facts = await q(targetFacts, targetFactsSql(config.evidenceSnapshotKey));
    report.target.timeline = facts.timeline;
    const problems = schemaProblems(facts as ServerFacts, {
      database: config.target.database,
      migrations: config.expected.migrations,
      tables: config.expected.tables,
    });
    if (facts.aflLeague !== 1) problems.push("AFL league identity (119) not found: not the expected test branch");
    if (config.evidenceSnapshotKey && !facts.evidenceRuns)
      problems.push("the guarded Triple-A week import is not on this branch: not the expected test branch");
    if (problems.length) {
      report.status = "refused";
      report.stop = { reason: problems.join("; ") };
      return report;
    }
    if (config.apply && facts.recentRunning > 0)
      throw new Stop("another ingestion run is in progress (status running in the last 30 minutes)");
    deps.log("backfill:target-verified", { database: facts.database, migrations: facts.migrations?.length ?? 0 });

    // 2. State: bound to this target and configuration.
    state = await deps.loadState();
    if (state) {
      const mismatch =
        state.version !== BACKFILL_STATE_VERSION ||
        state.season !== config.season ||
        state.chunkDays !== config.chunkDays ||
        state.gameTypes.join(",") !== config.gameTypes.join(",") ||
        state.target.endpoint !== config.target.endpoint ||
        state.target.database !== config.target.database ||
        (state.target.timeline && facts.timeline && state.target.timeline !== facts.timeline);
      if (mismatch) {
        report.status = "refused";
        report.stop = { reason: "state file belongs to a different target, season or configuration; use a new --run-dir" };
        return report;
      }
    }
    report.countsBefore = await q(counts, COUNTS_SQL);
    // Whole-database invariants must already hold, so a later failure is attributable to this run.
    report.globalBefore = await q(counts, globalChecksSql());
    const preexisting = Object.entries(report.globalBefore).filter(([, v]) => v !== 0);
    if (preexisting.length) {
      report.status = "refused";
      report.stop = { reason: `database invariants already fail before any write: ${preexisting.map(([k, v]) => `${k}=${v}`).join(", ")}` };
      return report;
    }

    // 3. Preserved-data baseline (first apply) and check (every run).
    if (state) {
      const now = await q(fingerprintResult, fingerprintSql(state.baseline.priorGameIds));
      report.preserved = compareFingerprints(state.baseline.fingerprint, now);
      if (!report.preserved.passed)
        throw new Stop(`previously imported data changed since the baseline: ${report.preserved.changed.join(", ")}`);
    } else if (config.apply) {
      const priorGameIds = z.array(z.string()).parse(await deps.query(PRIOR_GAMES_SQL));
      const fingerprint = await q(fingerprintResult, fingerprintSql(priorGameIds));
      state = {
        version: BACKFILL_STATE_VERSION,
        season: config.season,
        gameTypes: config.gameTypes,
        chunkDays: config.chunkDays,
        target: { ...config.target, timeline: facts.timeline },
        createdAt: deps.now().toISOString(),
        baseline: { at: deps.now().toISOString(), priorGameIds, fingerprint },
        levels: {},
      };
      await save();
      await deps.integrityReport?.("integrity-00-baseline.txt");
      deps.log("backfill:baseline", { priorGames: priorGameIds.length, aflGames: fingerprint.aflGames });
    }

    // 4. Coverage and plan.
    const coverages = new Map<MilbLevelId, LevelCoverage>();
    for (const level of config.levels) {
      const cov = await deps.coverage(level);
      coverages.set(level, cov);
      deps.log("backfill:coverage", { level, first: cov.first, last: cov.last, gamePks: cov.gamePks });
    }
    if (!config.apply) {
      // Read-only rehearsal of every query the apply uses: current data per level and baselines.
      const priorGameIds = z.array(z.string()).parse(await deps.query(PRIOR_GAMES_SQL));
      report.baselinePreview = { priorGames: priorGameIds.length, fingerprint: await q(fingerprintResult, fingerprintSql(priorGameIds)) };
      report.plan = [];
      for (const level of config.levels) {
        const cov = coverages.get(level)!;
        const known = state?.levels[level]?.chunks ?? {};
        const chunks = [];
        for (const c of planDateChunks(cov.first, cov.last, config.chunkDays))
          chunks.push({ ...c, verified: await verifiedChunk(config, deps, level, known[chunkKeyOf(c.from, c.to)]) });
        const current = checkResult.parse(await deps.query(checksSql(MILB_LEVELS[level].sportId, config.season, cov.first, cov.last)));
        report.plan.push({ level, coverage: cov, chunks, current });
      }
      await deps.writeReport("plan.json", report);
      return report;
    }

    // 5. Levels, one at a time.
    for (const level of config.levels) {
      const lr = await runLevel(config, deps, state!, level, coverages.get(level)!, save);
      report.levelReports.push(lr);
      if (lr.status === "complete-with-review") report.status = "complete-with-review";
    }

    // 6. Final preserved-data check and summary.
    const after = await q(fingerprintResult, fingerprintSql(state!.baseline.priorGameIds));
    report.preserved = compareFingerprints(state!.baseline.fingerprint, after);
    if (!report.preserved.passed)
      throw new Stop(`previously imported data changed: ${report.preserved.changed.join(", ")}`);
    report.countsAfter = await q(counts, COUNTS_SQL);
    await deps.integrityReport?.("integrity-99-final.txt");
    await deps.writeReport("summary.json", report);
    return report;
  } catch (error) {
    report.status = "stopped";
    if (error instanceof Stop) report.stop = { reason: error.reason, ...error.where };
    else report.stop = { reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    report.next = "Fix the cause, then re-run the same command: verified chunks are skipped and the rest resume.";
    deps.log("backfill:stopped", { reason: report.stop.reason.slice(0, 200), level: report.stop.level, from: report.stop.from });
    await save().catch(() => {});
    try {
      report.countsAfter = await q(counts, COUNTS_SQL);
    } catch {
      /* best effort */
    }
    await deps.writeReport("summary.json", report).catch(() => {});
    return report;
  }
}

async function verifiedChunk(
  config: BackfillConfig,
  deps: BackfillDeps,
  level: MilbLevelId,
  prev: ChunkState | undefined,
): Promise<boolean> {
  if (!prev || !prev.runId || !prev.checksPassed || config.recheck) return false;
  const acceptable = prev.status === "applied" || (prev.status === "applied-with-quarantine" && config.continueOnQuarantine);
  if (!acceptable) return false;
  const v = verifyResult.parse(
    await deps.query(verifySql(prev.runId, prev.key, MILB_LEVELS[level].sportId, config.season, prev.from || undefined, prev.to || undefined)),
  );
  if (v.runStatus !== prev.status) return false;
  if (prev.from && prev.to) {
    if (v.games === null || v.games < (prev.checks?.games ?? 0)) return false;
    if (v.finalIncomplete > 0 && !config.continueOnQuarantine) return false;
  }
  return true;
}

/** Runs one capture with bounded retries; a failed chunk is rolled back, so a retry is safe. */
async function withRetries(config: BackfillConfig, deps: BackfillDeps, request: IngestRequest) {
  let attempts = 0;
  for (;;) {
    attempts++;
    let summary: MilbRunSummary;
    try {
      summary = await deps.ingest(request);
    } catch (error) {
      summary = {
        status: "failed",
        chunks: [{ phase: request.mode, status: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 500) }],
      } as unknown as MilbRunSummary;
    }
    const chunk = summary.chunks.at(-1);
    if (summary.status !== "failed" && chunk) return { summary, chunk, attempts };
    if (deps.interrupted()) throw new Stop("interrupted", { level: request.level, from: request.from, to: request.to });
    if (attempts > config.retries)
      throw new Stop(`capture failed after ${attempts} attempts: ${chunk?.error ?? "unknown error"}`, {
        level: request.level,
        from: request.from,
        to: request.to,
      });
    const wait = Math.min(config.retryBaseMs * 3 ** (attempts - 1), 10 * 60_000);
    deps.log("backfill:retry", { level: request.level, from: request.from, attempt: attempts, waitMs: wait, error: chunk?.error?.slice(0, 160) });
    await deps.sleep(wait);
  }
}

function toState(
  chunk: ChunkSummary,
  key: string,
  attempts: number,
  at: string,
  range?: { from: string; to: string },
): ChunkState {
  return {
    from: range?.from ?? "",
    to: range?.to ?? "",
    key,
    status: chunk.status,
    ...(chunk.runId ? { runId: chunk.runId } : {}),
    attempts,
    records: chunk.records,
    changed: chunk.changed,
    unchanged: chunk.unchanged,
    issues: chunk.issues,
    notices: chunk.notices,
    ...(chunk.noticeReasons ? { noticeReasons: chunk.noticeReasons } : {}),
    checksPassed: false,
    at,
  };
}

/** Applies the status rules shared by structure and games captures. */
function assertApplied(config: BackfillConfig, s: ChunkState, where: { level: MilbLevelId; from?: string; to?: string }) {
  if (s.status === "quarantined") throw new Stop("capture was quarantined as a whole (nothing written)", where);
  if (s.status !== "applied" && s.status !== "applied-with-quarantine")
    throw new Stop(`unexpected capture status ${s.status}`, where);
  if (!s.runId) throw new Stop("applied capture did not report its ingestion run", where);
  if (s.status === "applied-with-quarantine" && !config.continueOnQuarantine)
    throw new Stop(
      `${s.issues} record(s) quarantined (see ingestion_issues for run ${s.runId}); review them, then re-run with --continue-on-quarantine to proceed`,
      where,
    );
}

async function runLevel(
  config: BackfillConfig,
  deps: BackfillDeps,
  state: BackfillState,
  level: MilbLevelId,
  coverage: LevelCoverage,
  save: () => Promise<void>,
): Promise<LevelReport> {
  const sportId = MILB_LEVELS[level].sportId;
  const ls: LevelState = (state.levels[level] ??= { chunks: {} });
  ls.coverage = coverage;
  const plan = planDateChunks(coverage.first, coverage.last, config.chunkDays);
  const lr: LevelReport = {
    level,
    status: "complete",
    coverage,
    chunks: { planned: plan.length, applied: 0, skippedVerified: 0, withQuarantine: 0 },
    totals: { records: 0, changed: 0, unchanged: 0, issues: 0, notices: 0 },
    noticeReasons: {},
    idempotency: [],
    review: [...coverage.warnings],
  };
  deps.log("backfill:level", { level, chunks: plan.length, first: coverage.first, last: coverage.last });

  // Structure pass (once per backfill state; verified against the database before skipping).
  const structureKey = snapshotKeyFor(config.season, level, "structure");
  if (!(await verifiedChunk(config, deps, level, ls.structure))) {
    const { chunk, attempts } = await withRetries(config, deps, { level, mode: "structure", apply: true });
    ls.structure = toState(chunk, structureKey, attempts, deps.now().toISOString());
    if (ls.structure.runId)
      ls.structure.issueCodes = z.record(z.string(), z.number()).parse(await deps.query(runIssuesSql(ls.structure.runId)));
    await save();
    assertApplied(config, ls.structure, { level });
    ls.structure.checksPassed = true;
    await save();
    deps.log("backfill:structure", { level, records: chunk.records, changed: chunk.changed, issues: chunk.issues });
  } else deps.log("backfill:structure-verified", { level });

  // Games chunks.
  for (const [i, range] of plan.entries()) {
    const key = chunkKeyOf(range.from, range.to);
    const where = { level, ...range };
    if (await verifiedChunk(config, deps, level, ls.chunks[key])) {
      lr.chunks.skippedVerified++;
      deps.log("backfill:chunk-verified", { level, ...range, n: i + 1, of: plan.length });
      continue;
    }
    if (deps.interrupted()) throw new Stop("interrupted", where);
    deps.log("backfill:chunk", { level, ...range, n: i + 1, of: plan.length });
    const { chunk, attempts } = await withRetries(config, deps, { level, mode: "games", ...range, apply: true });
    const s = toState(chunk, snapshotKeyFor(config.season, level, "games", range.from, range.to), attempts, deps.now().toISOString(), range);
    ls.chunks[key] = s;
    if (s.runId) s.issueCodes = z.record(z.string(), z.number()).parse(await deps.query(runIssuesSql(s.runId)));
    await save();
    assertApplied(config, s, where);
    s.checks = checkResult.parse(await deps.query(checksSql(sportId, config.season, range.from, range.to)));
    const failures = hardFailures(s.checks, config.continueOnQuarantine);
    await save();
    if (failures.length)
      throw new Stop(`integrity checks failed: ${failures.map(([k, v]) => `${k}=${v}`).join(", ")}`, where);
    s.checksPassed = true;
    lr.chunks.applied++;
    await save();
    deps.log("backfill:chunk-done", {
      level,
      ...range,
      records: s.records,
      changed: s.changed,
      issues: s.issues,
      games: s.checks.games,
      complete: s.checks.completeGames,
    });
    if (config.chunkPauseMs) await deps.sleep(config.chunkPauseMs);
  }

  // Level totals from the recorded chunk states.
  const states = plan.map((r) => ls.chunks[chunkKeyOf(r.from, r.to)]).filter((s): s is ChunkState => !!s);
  for (const s of [ls.structure, ...states].filter((s): s is ChunkState => !!s)) {
    lr.totals.records += s.records ?? 0;
    lr.totals.changed += s.changed ?? 0;
    lr.totals.unchanged += s.unchanged ?? 0;
    lr.totals.issues += s.issues ?? 0;
    lr.totals.notices += s.notices ?? 0;
    if (s.status === "applied-with-quarantine") lr.chunks.withQuarantine++;
    for (const [reason, n] of Object.entries(s.noticeReasons ?? {})) lr.noticeReasons[reason] = (lr.noticeReasons[reason] ?? 0) + n;
  }
  for (const reason of Object.keys(lr.noticeReasons))
    if (!HARMLESS_NOTICES.has(reason)) lr.review.push(`notice kind ${reason} (${lr.noticeReasons[reason]}) needs review`);

  // Level-wide checks.
  const levelChecks = checkResult.parse(await deps.query(checksSql(sportId, config.season, coverage.first, coverage.last)));
  const global = counts.parse(await deps.query(globalChecksSql()));
  lr.checks = { ...levelChecks, global };
  const failures = [
    ...hardFailures(levelChecks, config.continueOnQuarantine),
    ...Object.entries(global).filter(([, v]) => v !== 0),
  ];
  if (failures.length)
    throw new Stop(`level integrity checks failed: ${failures.map(([k, v]) => `${k}=${v}`).join(", ")}`, { level });
  for (const [k, v] of Object.entries(levelChecks.review))
    if (v && k !== "pendingGames")
      lr.review.push(`${k}: ${v} (gamePks ${(levelChecks.samples[k] ?? []).join(", ") || "n/a"})`);
  if (levelChecks.review.pendingGames)
    lr.review.push(`pendingGames: ${levelChecks.review.pendingGames} not final (gamePks ${(levelChecks.samples.pendingGames ?? []).join(", ")})`);
  if (levelChecks.hard.finalIncomplete)
    lr.review.push(`finalIncomplete: ${levelChecks.hard.finalIncomplete} final game(s) without a complete box score (quarantined)`);
  // Completeness against the API's own schedule (outside-scope games explain small differences).
  const whole = checkResult.parse(await deps.query(checksSql(sportId, config.season)));
  lr.completeness = {
    storedGames: whole.games,
    apiGamePks: coverage.gamePks,
    storedComplete: whole.completeGames,
    apiFinalGamePks: coverage.finalGamePks,
  };
  if (whole.completeGames !== coverage.finalGamePks)
    lr.review.push(`complete games ${whole.completeGames} differ from API final gamePks ${coverage.finalGamePks}`);
  if (whole.games !== coverage.gamePks)
    lr.review.push(`stored games ${whole.games} differ from API gamePks ${coverage.gamePks}`);

  // Idempotency: read-only previews of sample chunks with box scores re-fetched must change nothing.
  const before = await deps.query(COUNTS_SQL);
  for (const s of sampleChunks(states, config.idempotencySamples)) {
    const { summary } = await withRetries(config, deps, {
      level,
      mode: "games",
      from: s.from,
      to: s.to,
      apply: false,
      refetchComplete: true,
    });
    const c = summary.chunks.at(-1);
    const after = await deps.query(COUNTS_SQL);
    const result = idempotencyResult(s, c, JSON.stringify(after) === JSON.stringify(before));
    lr.idempotency.push(result);
    deps.log("backfill:idempotency", { level, from: s.from, to: s.to, insert: result.insert, update: result.update, passed: result.passed });
    if (result.updatesByKind.game)
      lr.review.push(`idempotency ${s.from}..${s.to}: ${result.updatesByKind.game} game row(s) differ by window (reconciled cross-chunk games)`);
    if (!result.passed)
      throw new Stop(`idempotency preview of ${s.from}..${s.to} would change data (insert ${result.insert}, update ${JSON.stringify(result.updatesByKind)})`, {
        level,
        from: s.from,
        to: s.to,
      });
  }

  // Preserved data after each level.
  const fp = fingerprintResult.parse(await deps.query(fingerprintSql(state.baseline.priorGameIds)));
  const preserved = compareFingerprints(state.baseline.fingerprint, fp);
  if (!preserved.passed) throw new Stop(`previously imported data changed: ${preserved.changed.join(", ")}`, { level });

  if (lr.review.length) lr.status = "complete-with-review";
  ls.completedAt = deps.now().toISOString();
  ls.report = lr;
  await save();
  await deps.integrityReport?.(`integrity-${level}.txt`);
  await deps.writeReport(`level-${level}.json`, lr);
  deps.log("backfill:level-done", { level, status: lr.status, applied: lr.chunks.applied, skipped: lr.chunks.skippedVerified });
  return lr;
}
