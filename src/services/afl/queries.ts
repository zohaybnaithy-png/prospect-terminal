import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  like,
  max,
  min,
  or,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as core from "@/db/schema";
import * as meta from "@/db/ingestion-schema";
import { AFL, MLB_SOURCE_ID } from "@/ingestion/sources/mlb-config";
import {
  MILB_LEVELS,
  milbLevelExternalIdPrefix,
  milbSeasonExternalId,
  type MilbLevelId,
} from "@/domain/levels";
import type { AflSnapshot } from "./types";

type Database = NodePgDatabase<typeof core>;
type ReadTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** pg returns timestamptz as Date; aggregates may arrive as strings depending on driver mapping. */
const iso = (d: Date | string) => new Date(d).toISOString();

/**
 * Loads the ingested AFL season from the existing core tables.
 *
 * Every statement runs inside one READ ONLY, REPEATABLE READ transaction: PostgreSQL rejects any
 * write, and all reads see one consistent snapshot even while an ingestion apply commits.
 * League and season are resolved through source_identities (provider IDs never leave this file).
 * Returns null when the AFL league/season has not been ingested.
 */
export async function loadAflSnapshot(
  db: Database,
  season: number = AFL.defaultSeason,
): Promise<AflSnapshot | null> {
  return db.transaction(
    async (tx) => {
      const identities = await tx
        .select({
          kind: meta.sourceIdentities.entityKind,
          internalId: meta.sourceIdentities.internalId,
        })
        .from(meta.sourceIdentities)
        .where(
          and(
            eq(meta.sourceIdentities.provider, MLB_SOURCE_ID),
            or(
              and(
                eq(meta.sourceIdentities.entityKind, "league"),
                eq(meta.sourceIdentities.externalId, String(AFL.leagueId)),
              ),
              and(
                eq(meta.sourceIdentities.entityKind, "season"),
                eq(meta.sourceIdentities.externalId, `afl-${season}`),
              ),
            ),
          ),
        );
      const leagueId = identities.find((i) => i.kind === "league")?.internalId;
      const seasonId = identities.find((i) => i.kind === "season")?.internalId;
      if (!leagueId || !seasonId) return null;
      const [[league], [seasonRow]] = await Promise.all([
        tx
          .select({ id: core.leagues.id, name: core.leagues.name })
          .from(core.leagues)
          .where(eq(core.leagues.id, leagueId)),
        tx
          .select({
            id: core.seasons.id,
            year: core.seasons.year,
            name: core.seasons.name,
          })
          .from(core.seasons)
          .where(eq(core.seasons.id, seasonId)),
      ]);
      if (!league || !seasonRow) return null;
      return loadSeason(tx, league, seasonRow, {
        kind: "afl",
        leagueIds: [league.id],
        restrictRosterTeams: false,
      });
    },
    { accessMode: "read only", isolationLevel: "repeatable read" },
  );
}

/**
 * Loads one MiLB level (e.g. Triple-A: every league of sport 11) for a season into the same
 * snapshot shape the AFL views, aggregation and Analytics V1 consume. Same read-only,
 * repeatable-read transaction; level/season resolved through source_identities. `league` holds
 * the level context (its first level row's UUID and the level label); `scope` lists the leagues.
 * Returns null when the level/season has not been ingested.
 */
export async function loadMilbLevelSnapshot(
  db: Database,
  level: MilbLevelId,
  season: number,
): Promise<AflSnapshot | null> {
  const def = MILB_LEVELS[level];
  return db.transaction(
    async (tx) => {
      const si = meta.sourceIdentities;
      const identities = await tx
        .select({ kind: si.entityKind, externalId: si.externalId, internalId: si.internalId })
        .from(si)
        .where(
          and(
            eq(si.provider, MLB_SOURCE_ID),
            or(
              and(eq(si.entityKind, "season"), eq(si.externalId, milbSeasonExternalId(season))),
              and(
                eq(si.entityKind, "level"),
                like(si.externalId, `${milbLevelExternalIdPrefix(def.sportId)}%`),
              ),
            ),
          ),
        );
      const seasonId = identities.find((i) => i.kind === "season")?.internalId;
      const levelIds = identities
        .filter((i) => i.kind === "level")
        .sort((a, b) => a.externalId.localeCompare(b.externalId))
        .map((i) => i.internalId);
      if (!seasonId || !levelIds.length) return null;
      const [seasonRow] = await tx
        .select({ id: core.seasons.id, year: core.seasons.year, name: core.seasons.name })
        .from(core.seasons)
        .where(eq(core.seasons.id, seasonId));
      const levels = await tx
        .select({ id: core.levels.id, leagueId: core.levels.leagueId })
        .from(core.levels)
        .where(inArray(core.levels.id, levelIds));
      if (!seasonRow || !levels.length) return null;
      return loadSeason(
        tx,
        { id: levelIds[0], name: def.label },
        seasonRow,
        {
          kind: "milb-level",
          level,
          leagueIds: [...new Set(levels.map((l) => l.leagueId))].sort(),
          restrictRosterTeams: true,
        },
      );
    },
    { accessMode: "read only", isolationLevel: "repeatable read" },
  );
}

interface SeasonScope {
  kind: "afl" | "milb-level";
  level?: MilbLevelId;
  leagueIds: string[];
  /** Keep only roster observations on this scope's teams (a MiLB season spans all levels). */
  restrictRosterTeams: boolean;
}

async function loadSeason(
  tx: ReadTx,
  league: AflSnapshot["league"],
  season: AflSnapshot["season"],
  scope: SeasonScope,
): Promise<AflSnapshot> {
  const g = core.games;
  const inSeason = and(
    scope.leagueIds.length === 1
      ? eq(g.leagueId, scope.leagueIds[0])
      : inArray(g.leagueId, scope.leagueIds),
    eq(g.seasonId, season.id),
  );
  const gameDate = sql<string>`coalesce(${g.officialDate}, (${g.startsAt} AT TIME ZONE 'UTC')::date)::text`;

  // A single pg connection serializes these; awaiting sequentially keeps that explicit.
  const games = await tx
    .select({
      id: g.id,
      date: gameDate,
      startsAt: g.startsAt,
      status: g.status,
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      venue: g.venue,
      boxscoreComplete: g.boxscoreComplete,
    })
    .from(g)
    .where(inSeason);

  const r = meta.sourceRosterObservations;
  // Teams on this scope's levels (all clubs, even before their first game).
  const leagueLevels = tx
    .select({ id: core.levels.id })
    .from(core.levels)
    .where(
      scope.leagueIds.length === 1
        ? eq(core.levels.leagueId, scope.leagueIds[0])
        : inArray(core.levels.leagueId, scope.leagueIds),
    );
  const scopeTeams = tx
    .select({ id: core.teams.id })
    .from(core.teams)
    .where(inArray(core.teams.levelId, leagueLevels));
  const rosterStints = await tx
    .select({
      playerId: r.playerId,
      teamId: r.teamId,
      organizationId: r.organizationId,
      rosterStatus: r.rosterStatus,
      firstObservedAt: min(r.observedAt),
      lastObservedAt: max(r.observedAt),
    })
    .from(r)
    .where(
      and(
        eq(r.provider, MLB_SOURCE_ID),
        eq(r.seasonId, season.id),
        scope.restrictRosterTeams ? inArray(r.teamId, scopeTeams) : undefined,
      ),
    )
    .groupBy(r.playerId, r.teamId, r.organizationId, r.rosterStatus);

  const b = core.playerBattingGames;
  const batting = await tx
    .select({
      playerId: b.playerId,
      gameId: b.gameId,
      teamId: b.teamId,
      plateAppearances: b.plateAppearances,
      atBats: b.atBats,
      hits: b.hits,
      doubles: b.doubles,
      triples: b.triples,
      homeRuns: b.homeRuns,
      walks: b.walks,
      strikeouts: b.strikeouts,
      hitByPitch: b.hitByPitch,
      sacrificeFlies: b.sacrificeFlies,
      stolenBases: b.stolenBases,
      runs: b.runs,
      rbi: b.rbi,
      caughtStealing: b.caughtStealing,
    })
    .from(b)
    .innerJoin(g, eq(g.id, b.gameId))
    .where(inSeason);

  const p = core.playerPitchingGames;
  const pitching = await tx
    .select({
      playerId: p.playerId,
      gameId: p.gameId,
      teamId: p.teamId,
      outsRecorded: p.outsRecorded,
      battersFaced: p.battersFaced,
      hitsAllowed: p.hitsAllowed,
      earnedRuns: p.earnedRuns,
      walks: p.walks,
      strikeouts: p.strikeouts,
      homeRunsAllowed: p.homeRunsAllowed,
      runs: p.runs,
      hitBatters: p.hitBatters,
      pitches: p.pitches,
    })
    .from(p)
    .innerJoin(g, eq(g.id, p.gameId))
    .where(inSeason);

  const teamIds = new Set<string>();
  for (const game of games) teamIds.add(game.homeTeamId).add(game.awayTeamId);
  for (const row of [...rosterStints, ...batting, ...pitching])
    teamIds.add(row.teamId);
  const playerIds = new Set(
    [...rosterStints, ...batting, ...pitching].map((row) => row.playerId),
  );
  const organizationIds = new Set(
    rosterStints.flatMap((row) =>
      row.organizationId ? [row.organizationId] : [],
    ),
  );

  // All clubs on this scope's levels (even before their first game), plus any referenced team.
  const teams = await tx
    .select({
      id: core.teams.id,
      name: core.teams.name,
      abbreviation: core.teams.abbreviation,
    })
    .from(core.teams)
    .where(
      teamIds.size
        ? or(
            inArray(core.teams.levelId, leagueLevels),
            inArray(core.teams.id, [...teamIds]),
          )
        : inArray(core.teams.levelId, leagueLevels),
    );
  const organizations = organizationIds.size
    ? await tx
        .select({
          id: core.organizations.id,
          name: core.organizations.name,
          abbreviation: core.organizations.abbreviation,
        })
        .from(core.organizations)
        .where(inArray(core.organizations.id, [...organizationIds]))
    : [];
  // externalIds is deliberately not selected: provider identifiers are not part of the read model.
  const players = playerIds.size
    ? await tx
        .select({
          id: core.players.id,
          name: core.players.name,
          primaryPosition: core.players.primaryPosition,
          secondaryPosition: core.players.secondaryPosition,
          bats: core.players.bats,
          throws: core.players.throws,
          birthDate: core.players.birthDate,
          height: core.players.height,
          weight: core.players.weight,
        })
        .from(core.players)
        .where(inArray(core.players.id, [...playerIds]))
    : [];

  const [lastRun] = await tx
    .select({ completedAt: meta.ingestionRuns.completedAt })
    .from(meta.ingestionRuns)
    .where(
      and(
        eq(meta.ingestionRuns.provider, MLB_SOURCE_ID),
        inArray(meta.ingestionRuns.status, [
          "applied",
          "applied-with-quarantine",
        ]),
        isNotNull(meta.ingestionRuns.completedAt),
      ),
    )
    .orderBy(desc(meta.ingestionRuns.completedAt))
    .limit(1);

  return {
    league,
    season,
    scope: { kind: scope.kind, ...(scope.level ? { level: scope.level } : {}), leagueIds: scope.leagueIds },
    teams,
    organizations,
    players,
    games: games.map((game) => ({ ...game, startsAt: iso(game.startsAt) })),
    rosterStints: rosterStints.map((row) => ({
      ...row,
      firstObservedAt: iso(row.firstObservedAt!),
      lastObservedAt: iso(row.lastObservedAt!),
    })),
    batting,
    pitching,
    lastIngestedAt: lastRun?.completedAt ? iso(lastRun.completedAt) : null,
  };
}
