import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import * as core from "../db/schema";
import * as meta from "../db/ingestion-schema";
import type {
  EntityKind,
  IngestionRecord,
  SourceSnapshot,
  NormalizedBatch,
} from "./contracts";
import { recordKey } from "./contracts";
import { buildPlan, fingerprint, isEntityKind } from "./plan";
import type { IngestionSink, IngestionReport } from "./runner";
const tables = {
  league: core.leagues,
  level: core.levels,
  season: core.seasons,
  organization: core.organizations,
  team: core.teams,
  player: core.players,
  game: core.games,
};
class ApplyError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export class PostgresIngestionSink implements IngestionSink {
  private readonly pool: Pool;
  private readonly db;
  constructor(url: string) {
    const connectionString = z
      .url()
      .refine((v) => /^postgres(ql)?:/.test(v))
      .parse(url);
    this.pool = new Pool({
      connectionString,
      max: 3,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
      lock_timeout: 5000,
    });
    this.db = drizzle(this.pool);
  }
  async close() {
    await this.pool.end();
  }
  async preview(
    snapshot: SourceSnapshot,
    input: NormalizedBatch,
  ): Promise<IngestionReport> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      const identities = await tx
        .select()
        .from(meta.sourceIdentities)
        .where(eq(meta.sourceIdentities.provider, snapshot.provider));
      const batch = buildPlan(
        input,
        new Set(identities.map((i) => `${i.entityKind}:${i.externalId}`)),
      );
      const prior = await tx
        .select()
        .from(meta.ingestionRecordState)
        .where(eq(meta.ingestionRecordState.provider, snapshot.provider));
      const states = new Map(prior.map((r) => [r.recordKey, r]));
      const counts = { insert: 0, update: 0, unchanged: 0 };
      for (const r of batch.records) {
        const key =
          recordKey(r) +
          (r.kind === "rosterObservation" ? `:${snapshot.observedAt}` : "");
        const old = states.get(key);
        if (!old) counts.insert++;
        else if (old.contentHash === fingerprint(r)) counts.unchanged++;
        else counts.update++;
      }
      return {
        provider: snapshot.provider,
        snapshotKey: snapshot.key,
        contentHash: fingerprint(snapshot.payload),
        status: batch.issues.length
          ? batch.quarantinePolicy === "records"
            ? "dry-run-with-quarantine"
            : "quarantined"
          : "dry-run",
        records: batch.records.length,
        issues: batch.issues.length,
        databaseComparison: counts,
        ...(batch.issues.length
          ? { diagnostics: batch.issues.slice(0, 100) }
          : {}),
      };
    });
  }
  async apply(
    snapshot: SourceSnapshot,
    input: NormalizedBatch,
  ): Promise<IngestionReport> {
    const contentHash = fingerprint(snapshot.payload);
    const observedAt = new Date(snapshot.observedAt);
    const [stored] = await this.db
      .insert(meta.sourceSnapshots)
      .values({
        provider: snapshot.provider,
        snapshotKey: snapshot.key,
        contentHash,
        payload: snapshot.storedPayload ?? snapshot.payload,
        sourceUrl: snapshot.sourceUrl,
        observedAt,
        fetchedAt: new Date(snapshot.fetchedAt),
      })
      .onConflictDoUpdate({
        target: [
          meta.sourceSnapshots.provider,
          meta.sourceSnapshots.snapshotKey,
          meta.sourceSnapshots.contentHash,
          meta.sourceSnapshots.observedAt,
        ],
        set: { fetchedAt: new Date(snapshot.fetchedAt) },
      })
      .returning({ id: meta.sourceSnapshots.id });
    const [run] = await this.db
      .insert(meta.ingestionRuns)
      .values({
        provider: snapshot.provider,
        adapterVersion: snapshot.adapterVersion,
        snapshotId: stored.id,
        status: "running",
      })
      .returning({ id: meta.ingestionRuns.id });
    const report: IngestionReport = {
      provider: snapshot.provider,
      snapshotKey: snapshot.key,
      contentHash,
      status: "applied",
      records: 0,
      issues: 0,
      changed: 0,
      unchanged: 0,
      runId: run.id,
    };
    try {
      await this.db.transaction(async (tx) => {
        // Source-wide lock covers identities shared by different dates and seasons.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${snapshot.provider},0))`,
        );
        const identities = await tx
          .select()
          .from(meta.sourceIdentities)
          .where(eq(meta.sourceIdentities.provider, snapshot.provider));
        const ids = new Map(
          identities.map((i) => [
            `${i.entityKind}:${i.externalId}`,
            i.internalId,
          ]),
        );
        const batch = buildPlan(input, new Set(ids.keys()));
        report.records = batch.records.length;
        report.issues = batch.issues.length;
        if (batch.issues.length) {
          await tx
            .insert(meta.ingestionIssues)
            .values(batch.issues.map((issue) => ({ ...issue, runId: run.id })));
          if (batch.quarantinePolicy !== "records") {
            report.status = "quarantined";
            report.diagnostics = batch.issues.slice(0, 100);
            await tx
              .update(meta.ingestionRuns)
              .set({
                status: "quarantined",
                counts: { records: report.records, issues: report.issues },
                completedAt: new Date(),
              })
              .where(eq(meta.ingestionRuns.id, run.id));
            return;
          }
          report.status = "applied-with-quarantine";
          report.diagnostics = batch.issues.slice(0, 100);
        }
        const resolve = (kind: EntityKind, externalId: string) => {
          const id = ids.get(`${kind}:${externalId}`);
          if (!id) throw new ApplyError("unresolved-identity");
          return id;
        };
        const seen = new Set<string>();
        const claim = async (r: IngestionRecord, canonicalKey: string) => {
          const sourceKey =
            recordKey(r) +
            (r.kind === "rosterObservation" ? `:${snapshot.observedAt}` : "");
          if (seen.has(canonicalKey))
            throw new ApplyError("duplicate-canonical-row");
          seen.add(canonicalKey);
          const [owner] = await tx
            .select()
            .from(meta.ingestionRecordState)
            .where(eq(meta.ingestionRecordState.canonicalKey, canonicalKey));
          if (
            owner &&
            (owner.provider !== snapshot.provider ||
              owner.recordKey !== sourceKey)
          )
            throw new ApplyError("source-ownership-conflict");
          const [priorKey] = await tx
            .select()
            .from(meta.ingestionRecordState)
            .where(
              and(
                eq(meta.ingestionRecordState.provider, snapshot.provider),
                eq(meta.ingestionRecordState.recordKey, sourceKey),
              ),
            );
          if (priorKey && priorKey.canonicalKey !== canonicalKey)
            throw new ApplyError("source-key-reassigned");
          if (owner && owner.observedAt > observedAt)
            throw new ApplyError("stale-snapshot");
          const hash = fingerprint(r);
          if (
            owner &&
            owner.observedAt.getTime() === observedAt.getTime() &&
            owner.contentHash !== hash
          )
            throw new ApplyError("ambiguous-revision");
          await tx
            .insert(meta.ingestionRecordState)
            .values({
              provider: snapshot.provider,
              recordKey: sourceKey,
              canonicalKey,
              contentHash: hash,
              observedAt,
              lastRunId: run.id,
            })
            .onConflictDoUpdate({
              target: meta.ingestionRecordState.canonicalKey,
              set: { contentHash: hash, observedAt, lastRunId: run.id },
            });
          if (owner?.contentHash === hash) {
            report.unchanged!++;
            return false;
          }
          report.changed!++;
          return true;
        };
        for (const r of batch.records) {
          if (isEntityKind(r.kind) && "externalId" in r) {
            let internalId = ids.get(`${r.kind}:${r.externalId}`);
            if (!internalId) {
              internalId = randomUUID();
              ids.set(`${r.kind}:${r.externalId}`, internalId);
              await tx.insert(meta.sourceIdentities).values({
                provider: snapshot.provider,
                entityKind: r.kind,
                externalId: r.externalId,
                internalId,
                createdRunId: run.id,
              });
            } else {
              const table = tables[r.kind];
              const found = await tx
                .select({ id: table.id })
                .from(table)
                .where(eq(table.id, internalId));
              if (!found.length) throw new ApplyError("dangling-identity");
            }
            if (!(await claim(r, `entity:${r.kind}:${internalId}`))) continue;
            // UUIDs are internal; provider IDs remain exclusively in source_identities.
            const slug = `${snapshot.provider}-${internalId}`;
            switch (r.kind) {
              case "league": {
                const values = { name: r.name, slug };
                await tx
                  .insert(core.leagues)
                  .values({ id: internalId, ...values })
                  .onConflictDoUpdate({ target: core.leagues.id, set: values });
                break;
              }
              case "level": {
                const values = {
                  name: r.name,
                  slug,
                  leagueId: resolve("league", r.league),
                };
                await tx
                  .insert(core.levels)
                  .values({ id: internalId, ...values })
                  .onConflictDoUpdate({ target: core.levels.id, set: values });
                break;
              }
              case "season": {
                const values = { year: r.year, name: r.name };
                await tx
                  .insert(core.seasons)
                  .values({ id: internalId, ...values })
                  .onConflictDoUpdate({ target: core.seasons.id, set: values });
                break;
              }
              case "organization": {
                const values = {
                  name: r.name,
                  slug,
                  abbreviation: r.abbreviation,
                };
                await tx
                  .insert(core.organizations)
                  .values({ id: internalId, ...values })
                  .onConflictDoUpdate({
                    target: core.organizations.id,
                    set: values,
                  });
                break;
              }
              case "team": {
                const values = {
                  name: r.name,
                  slug,
                  abbreviation: r.abbreviation,
                  levelId: resolve("level", r.level),
                  organizationId: r.organization
                    ? resolve("organization", r.organization)
                    : null,
                };
                await tx
                  .insert(core.teams)
                  .values({ id: internalId, ...values })
                  .onConflictDoUpdate({ target: core.teams.id, set: values });
                break;
              }
              case "player": {
                const values = {
                  name: r.name,
                  primaryPosition:
                    r.position === "RHP / DH" ? "RHP" : r.position,
                  ...(r.secondaryPosition !== undefined
                    ? { secondaryPosition: r.secondaryPosition }
                    : r.position === "RHP / DH"
                      ? { secondaryPosition: "DH" }
                      : {}),
                  ...(r.bats ? { bats: r.bats } : {}),
                  ...(r.throws ? { throws: r.throws } : {}),
                  ...(r.birthDate ? { birthDate: r.birthDate } : {}),
                  ...(r.height ? { height: r.height } : {}),
                  ...(r.weight !== undefined ? { weight: r.weight } : {}),
                };
                await tx
                  .insert(core.players)
                  .values({ id: internalId, ...values })
                  .onConflictDoUpdate({ target: core.players.id, set: values });
                break;
              }
              case "game": {
                const homeTeamId = resolve("team", r.homeTeam),
                  awayTeamId = resolve("team", r.awayTeam);
                if (homeTeamId === awayTeamId)
                  throw new ApplyError("invalid-game-teams");
                const values = {
                  homeTeamId,
                  awayTeamId,
                  seasonId: resolve("season", r.season),
                  startsAt: new Date(r.startsAt),
                  status: r.status,
                  ...(r.league
                    ? { leagueId: resolve("league", r.league) }
                    : {}),
                  ...(r.officialDate ? { officialDate: r.officialDate } : {}),
                  ...(r.homeScore !== undefined
                    ? { homeScore: r.homeScore }
                    : {}),
                  ...(r.awayScore !== undefined
                    ? { awayScore: r.awayScore }
                    : {}),
                  ...(r.venue ? { venue: r.venue } : {}),
                  ...(r.boxscoreComplete !== undefined
                    ? { boxscoreComplete: r.boxscoreComplete }
                    : {}),
                };
                await tx
                  .insert(core.games)
                  .values({ id: internalId, ...values })
                  .onConflictDoUpdate({ target: core.games.id, set: values });
                break;
              }
            }
            continue;
          }
          switch (r.kind) {
            case "organizationMembership": {
              const playerId = resolve("player", r.player),
                organizationId = resolve("organization", r.organization);
              const existing = await tx
                .select()
                .from(core.playerOrganizationMemberships)
                .where(
                  eq(core.playerOrganizationMemberships.playerId, playerId),
                );
              if (
                existing.some(
                  (m) =>
                    !(
                      m.organizationId === organizationId &&
                      m.startsOn === r.startsOn
                    ) &&
                    (!m.endsOn || m.endsOn >= r.startsOn) &&
                    (!r.endsOn || m.startsOn <= r.endsOn),
                )
              )
                throw new ApplyError("overlapping-organization-stints");
              if (
                await claim(
                  r,
                  `organization-membership:${playerId}:${organizationId}:${r.startsOn}`,
                )
              )
                await tx
                  .insert(core.playerOrganizationMemberships)
                  .values({
                    playerId,
                    organizationId,
                    startsOn: r.startsOn,
                    endsOn: r.endsOn,
                  })
                  .onConflictDoUpdate({
                    target: [
                      core.playerOrganizationMemberships.playerId,
                      core.playerOrganizationMemberships.organizationId,
                      core.playerOrganizationMemberships.startsOn,
                    ],
                    set: { endsOn: r.endsOn },
                  });
              break;
            }
            case "teamMembership": {
              const playerId = resolve("player", r.player),
                teamId = resolve("team", r.team),
                seasonId = resolve("season", r.season);
              if (
                await claim(
                  r,
                  `team-membership:${playerId}:${teamId}:${seasonId}:${r.startsOn}`,
                )
              )
                await tx
                  .insert(core.playerTeamMemberships)
                  .values({
                    playerId,
                    teamId,
                    seasonId,
                    startsOn: r.startsOn,
                    endsOn: r.endsOn,
                    assignmentType: r.assignmentType,
                  })
                  .onConflictDoUpdate({
                    target: [
                      core.playerTeamMemberships.playerId,
                      core.playerTeamMemberships.teamId,
                      core.playerTeamMemberships.seasonId,
                      core.playerTeamMemberships.startsOn,
                    ],
                    set: { endsOn: r.endsOn, assignmentType: r.assignmentType },
                  });
              break;
            }
            case "rosterObservation": {
              const playerId = resolve("player", r.player),
                teamId = resolve("team", r.team),
                organizationId = r.organization
                  ? resolve("organization", r.organization)
                  : null;
              if (
                await claim(
                  r,
                  `roster:${snapshot.provider}:${playerId}:${teamId}:${snapshot.observedAt}`,
                )
              )
                await tx
                  .insert(meta.sourceRosterObservations)
                  .values({
                    provider: snapshot.provider,
                    playerId,
                    teamId,
                    organizationId,
                    ...(r.season
                      ? { seasonId: resolve("season", r.season) }
                      : {}),
                    ...(r.rosterStatus ? { rosterStatus: r.rosterStatus } : {}),
                    observedAt,
                    runId: run.id,
                  })
                  .onConflictDoUpdate({
                    target: [
                      meta.sourceRosterObservations.provider,
                      meta.sourceRosterObservations.playerId,
                      meta.sourceRosterObservations.teamId,
                      meta.sourceRosterObservations.observedAt,
                    ],
                    set: {
                      organizationId,
                      runId: run.id,
                      ...(r.season
                        ? { seasonId: resolve("season", r.season) }
                        : {}),
                      ...(r.rosterStatus
                        ? { rosterStatus: r.rosterStatus }
                        : {}),
                    },
                  });
              break;
            }
            case "gameLineSet": {
              const gameId = resolve("game", r.game);
              if (!(await claim(r, `game-line-set:${gameId}`))) break;
              const lineSets = [
                {
                  kind: "battingGame",
                  table: core.playerBattingGames,
                  people: r.battingPlayers,
                },
                {
                  kind: "pitchingGame",
                  table: core.playerPitchingGames,
                  people: r.pitchingPlayers,
                },
              ] as const;
              for (const set of lineSets) {
                const expected = new Set(
                  set.people.map((p) => resolve("player", p)),
                );
                const lines = await tx
                  .select({ id: set.table.id, playerId: set.table.playerId })
                  .from(set.table)
                  .where(eq(set.table.gameId, gameId));
                for (const line of lines)
                  if (!expected.has(line.playerId)) {
                    const key = `${set.kind}:${line.playerId}:${gameId}`;
                    const [owner] = await tx
                      .select()
                      .from(meta.ingestionRecordState)
                      .where(eq(meta.ingestionRecordState.canonicalKey, key));
                    if (!owner || owner.provider !== snapshot.provider)
                      throw new ApplyError(
                        "boxscore-replacement-ownership-conflict",
                      );
                    await tx.delete(set.table).where(eq(set.table.id, line.id));
                    await tx
                      .delete(meta.ingestionRecordState)
                      .where(eq(meta.ingestionRecordState.id, owner.id));
                  }
              }
              await tx
                .update(core.games)
                .set({ boxscoreComplete: true })
                .where(eq(core.games.id, gameId));
              break;
            }
            case "battingGame":
            case "pitchingGame": {
              const playerId = resolve("player", r.player),
                gameId = resolve("game", r.game),
                teamId = resolve("team", r.team);
              const [game] = await tx
                .select()
                .from(core.games)
                .where(eq(core.games.id, gameId));
              if (!game || ![game.homeTeamId, game.awayTeamId].includes(teamId))
                throw new ApplyError("stat-team-not-in-game");
              if (!(await claim(r, `${r.kind}:${playerId}:${gameId}`))) break;
              if (r.kind === "battingGame")
                await tx
                  .insert(core.playerBattingGames)
                  .values({ playerId, gameId, teamId, ...r.stats })
                  .onConflictDoUpdate({
                    target: [
                      core.playerBattingGames.playerId,
                      core.playerBattingGames.gameId,
                    ],
                    set: { teamId, ...r.stats },
                  });
              else
                await tx
                  .insert(core.playerPitchingGames)
                  .values({ playerId, gameId, teamId, ...r.stats })
                  .onConflictDoUpdate({
                    target: [
                      core.playerPitchingGames.playerId,
                      core.playerPitchingGames.gameId,
                    ],
                    set: { teamId, ...r.stats },
                  });
              break;
            }
          }
        }
        await tx
          .update(meta.ingestionRuns)
          .set({
            status: report.status,
            counts: {
              records: report.records,
              issues: report.issues,
              changed: report.changed,
              unchanged: report.unchanged,
            },
            completedAt: new Date(),
          })
          .where(eq(meta.ingestionRuns.id, run.id));
      });
      return report;
    } catch (error) {
      const code =
        error instanceof ApplyError ? error.code : "database-write-failed";
      await this.db
        .update(meta.ingestionRuns)
        .set({ status: "failed", errorCode: code, completedAt: new Date() })
        .where(eq(meta.ingestionRuns.id, run.id));
      throw new Error(`Ingestion rolled back (${code}); run ${run.id}`);
    }
  }
}
