import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
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
import {
  buildPlan,
  fingerprint,
  isEntityKind,
  normalizedFingerprint,
  references,
} from "./plan";
import type { IngestionSink, IngestionReport } from "./runner";
import { rawContentHashOf } from "./runner";
import { beginStage, progress, redact, updateStage } from "./progress";
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
const sqlState = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
    ? code
    : undefined;
};
const RECORD_PROGRESS_INTERVAL = 250;
type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];
type Row = Record<string, unknown>;
// Stays well below PostgreSQL's 65,535 bind-parameter limit per statement.
const MAX_PARAMETERS = 30000;
const chunk = <T>(values: T[], size: number) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, i) =>
    values.slice(i * size, (i + 1) * size),
  );
/** Runs a keyed read/write in parameter-bounded chunks; no statement for an empty key list. */
async function selectIn<K, T>(
  keys: K[],
  query: (chunk: K[]) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (const part of chunk(keys, MAX_PARAMETERS))
    rows.push(...(await query(part)));
  return rows;
}
/** Rows with different optional fields are written separately so omitted values are never overwritten. */
function bySignature(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const defined = Object.fromEntries(
      Object.entries(row).filter(([, v]) => v !== undefined),
    );
    const signature = Object.keys(defined).sort().join(",");
    // Push (not spread-copy): copying the group per row was O(n²) for large batches.
    const group = groups.get(signature);
    if (group) group.push(defined);
    else groups.set(signature, [defined]);
  }
  return [...groups].map(([signature, group]) => ({
    columns: signature.split(","),
    group,
  }));
}
async function bulkInsert(tx: Tx, table: PgTable, rows: Row[]) {
  for (const { columns, group } of bySignature(rows))
    for (const part of chunk(
      group,
      Math.floor(MAX_PARAMETERS / columns.length),
    ))
      await tx.insert(table).values(part as never);
}
/** Multi-row equivalent of per-row INSERT ... ON CONFLICT (target) DO UPDATE SET <non-target fields>. */
async function bulkUpsert(
  tx: Tx,
  table: PgTable,
  target: string[],
  rows: Row[],
  updates?: string[],
) {
  const all = getTableColumns(table);
  for (const { columns, group } of bySignature(rows)) {
    const set = Object.fromEntries(
      (updates ?? columns.filter((c) => !target.includes(c) && c !== "id"))
        .filter((c) => columns.includes(c))
        .map((c) => [c, sql`excluded.${sql.identifier(all[c].name)}`]),
    );
    for (const part of chunk(
      group,
      Math.floor(MAX_PARAMETERS / columns.length),
    )) {
      const insert = tx.insert(table).values(part as never);
      const targetColumns = target.map((c) => all[c]);
      await (Object.keys(set).length
        ? insert.onConflictDoUpdate({
            target: targetColumns,
            set: set as never,
          })
        : insert.onConflictDoNothing({ target: targetColumns }));
    }
  }
}
/**
 * Every `kind:externalId` a batch defines or references. Identity lookups are scoped to these
 * keys, so a run reads O(batch) identities instead of every identity the provider has ever
 * created (hundreds of thousands once a full MiLB season is stored). The planner only consults
 * identities for keys in this set, so results are identical to a provider-wide read.
 */
function batchIdentityKeys(batch: NormalizedBatch) {
  const byKind = new Map<EntityKind, Set<string>>();
  const add = (kind: EntityKind, externalId: string) => {
    const set = byKind.get(kind) ?? new Set<string>();
    set.add(externalId);
    byKind.set(kind, set);
  };
  for (const r of batch.records) {
    if (isEntityKind(r.kind) && "externalId" in r) add(r.kind, r.externalId);
    for (const [kind, id] of references(r)) add(kind, id);
  }
  return byKind;
}
async function readIdentities(
  db: Pick<Tx, "select">,
  provider: string,
  batch: NormalizedBatch,
) {
  const rows: (typeof meta.sourceIdentities.$inferSelect)[] = [];
  for (const [kind, ids] of batchIdentityKeys(batch))
    rows.push(
      ...(await selectIn([...ids], (part) =>
        db
          .select()
          .from(meta.sourceIdentities)
          .where(
            and(
              eq(meta.sourceIdentities.provider, provider),
              eq(meta.sourceIdentities.entityKind, kind),
              inArray(meta.sourceIdentities.externalId, part),
            ),
          ),
      )),
    );
  return rows;
}
export class PostgresIngestionSink implements IngestionSink {
  private readonly pool: Pool;
  private readonly db;
  private readonly signal?: AbortSignal;
  /** True while apply() may hold database writes that an interrupt should roll back. */
  applying = false;
  constructor(url: string, options: { signal?: AbortSignal } = {}) {
    this.signal = options.signal;
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
      // Client-side bound for a reply that never arrives (statement_timeout is enforced by the server).
      query_timeout: 60000,
      keepAlive: true,
    });
    // An idle client losing its connection must be reported, not crash the process.
    this.pool.on("error", (error) =>
      progress("db:pool-error", {
        sqlstate: sqlState(error),
        message: redact(error.message),
      }),
    );
    this.pool.on("connect", () =>
      progress("db:client-connected", { total: this.pool.totalCount }),
    );
    this.db = drizzle(this.pool);
  }
  async close() {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.pool.end(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          progress("db:close-timeout", {
            waitingClients: this.pool.totalCount,
          });
          resolve();
        }, 10000);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }
  /** Separates connection acquisition from query execution in diagnostics. */
  private async connectProbe() {
    beginStage("db:connect");
    const startedAt = Date.now();
    const client = await this.pool.connect();
    client.release();
    progress("db:connected", { ms: Date.now() - startedAt });
  }
  /**
   * Read-only: source game IDs (of `candidates`, when given) already stored as final with a
   * complete boxscore. Incremental captures use this to avoid re-fetching unchanged games.
   */
  async completedGameIds(
    provider: string,
    candidates?: string[],
  ): Promise<Set<string>> {
    const si = meta.sourceIdentities;
    const query = (part?: string[]) =>
      this.db
        .select({ externalId: si.externalId })
        .from(si)
        .innerJoin(core.games, eq(core.games.id, si.internalId))
        .where(
          and(
            eq(si.provider, provider),
            eq(si.entityKind, "game"),
            eq(core.games.status, "final"),
            eq(core.games.boxscoreComplete, true),
            part ? inArray(si.externalId, part) : undefined,
          ),
        );
    const rows = candidates
      ? await selectIn(candidates, (part) => query(part))
      : await query();
    return new Set(rows.map((r) => r.externalId));
  }
  /** Read-only: source IDs of every stored identity of one kind (e.g. players) for a provider. */
  async knownExternalIds(provider: string, kind: EntityKind): Promise<Set<string>> {
    const si = meta.sourceIdentities;
    const rows = await this.db
      .select({ externalId: si.externalId })
      .from(si)
      .where(and(eq(si.provider, provider), eq(si.entityKind, kind)));
    return new Set(rows.map((r) => r.externalId));
  }
  /**
   * Read-only: latest official date of a stored final game with a complete boxscore in a season,
   * optionally restricted to games whose home team sits on a level whose source identity starts
   * with one of `levelPrefixes` (e.g. "milb:11:"). Null when nothing complete is stored.
   */
  async latestCompleteGameDate(
    provider: string,
    seasonExternalId: string,
    levelPrefixes?: string[],
  ): Promise<string | null> {
    const result = await this.db.execute<{ latest: string | null }>(sql`
      SELECT max(coalesce(g.official_date, (g.starts_at AT TIME ZONE 'UTC')::date))::text AS latest
      FROM games g
      JOIN source_identities ss
        ON ss.internal_id = g.season_id AND ss.provider = ${provider}
       AND ss.entity_kind = 'season' AND ss.external_id = ${seasonExternalId}
      JOIN teams t ON t.id = g.home_team_id
      LEFT JOIN source_identities sl
        ON sl.internal_id = t.level_id AND sl.provider = ${provider} AND sl.entity_kind = 'level'
      WHERE g.status = 'final' AND g.boxscore_complete
        ${
          levelPrefixes?.length
            ? sql`AND (${sql.join(
                levelPrefixes.map((p) => sql`sl.external_id LIKE ${`${p}%`}`),
                sql` OR `,
              )})`
            : sql``
        }`);
    return result.rows[0]?.latest ?? null;
  }
  async preview(
    snapshot: SourceSnapshot,
    input: NormalizedBatch,
  ): Promise<IngestionReport> {
    await this.connectProbe();
    beginStage("preview:tx-begin");
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      beginStage("preview:read-identities");
      const identities = await readIdentities(tx, snapshot.provider, input);
      const batch = buildPlan(
        input,
        new Set(identities.map((i) => `${i.entityKind}:${i.externalId}`)),
      );
      beginStage("preview:read-record-state");
      const sourceKeys = batch.records.map(
        (r) =>
          recordKey(r) +
          (r.kind === "rosterObservation" ? `:${snapshot.observedAt}` : ""),
      );
      // Scoped to this batch's keys rather than every state row the provider owns.
      const prior = await selectIn(sourceKeys, (part) =>
        tx
          .select()
          .from(meta.ingestionRecordState)
          .where(
            and(
              eq(meta.ingestionRecordState.provider, snapshot.provider),
              inArray(meta.ingestionRecordState.recordKey, part),
            ),
          ),
      );
      progress("preview:compare", { records: batch.records.length });
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
      progress("preview:done", counts);
      return {
        provider: snapshot.provider,
        snapshotKey: snapshot.key,
        contentHash: normalizedFingerprint(input),
        rawContentHash: rawContentHashOf(snapshot),
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
    this.applying = true;
    try {
      return await this.applyLocked(snapshot, input);
    } finally {
      this.applying = false;
    }
  }
  private async applyLocked(
    snapshot: SourceSnapshot,
    input: NormalizedBatch,
  ): Promise<IngestionReport> {
    beginStage("apply:enter", { records: input.records.length });
    const contentHash = normalizedFingerprint(input);
    const observedAt = new Date(snapshot.observedAt);
    await this.connectProbe();
    if (this.signal?.aborted)
      throw new Error("Interrupted before apply wrote anything");
    beginStage("apply:snapshot-insert");
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
    beginStage("apply:run-insert");
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
      rawContentHash: rawContentHashOf(snapshot),
      status: "applied",
      records: 0,
      issues: 0,
      changed: 0,
      unchanged: 0,
      runId: run.id,
    };
    progress("apply:run", { runId: run.id });
    try {
      beginStage("apply:tx-begin");
      await this.db.transaction(async (tx) => {
        progress("apply:tx-begun");
        // A stalled client must not leave an open write transaction holding the source lock.
        await tx.execute(
          sql`SET LOCAL idle_in_transaction_session_timeout = '60s'`,
        );
        beginStage("apply:lock-wait");
        // Source-wide lock covers identities shared by different dates and seasons.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${snapshot.provider},0))`,
        );
        progress("apply:lock-acquired");
        if (this.signal?.aborted) throw new ApplyError("interrupted");
        beginStage("apply:read-identities");
        const identities = await readIdentities(tx, snapshot.provider, input);
        const ids = new Map(
          identities.map((i) => [
            `${i.entityKind}:${i.externalId}`,
            i.internalId,
          ]),
        );
        const batch = buildPlan(input, new Set(ids.keys()));
        report.records = batch.records.length;
        report.issues = batch.issues.length;
        progress("apply:plan", {
          identities: identities.length,
          records: batch.records.length,
          issues: batch.issues.length,
        });
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
        const sourceKeyOf = (r: IngestionRecord) =>
          recordKey(r) +
          (r.kind === "rosterObservation" ? `:${snapshot.observedAt}` : "");
        // Planned in memory against bulk-read state, in planner order: every safeguard sees the
        // same effective state sequential per-record writes would have produced, then rows are
        // written in bulk. Round trips scale with tables, not records.
        const newIdentities: (typeof meta.sourceIdentities.$inferInsert)[] = [];
        const existingIds = new Map<EntityKind, Set<string>>();
        const canonicalKeys = batch.records.map((r) => {
          if (isEntityKind(r.kind) && "externalId" in r) {
            let internalId = ids.get(`${r.kind}:${r.externalId}`);
            if (!internalId) {
              internalId = randomUUID();
              ids.set(`${r.kind}:${r.externalId}`, internalId);
              newIdentities.push({
                provider: snapshot.provider,
                entityKind: r.kind,
                externalId: r.externalId,
                internalId,
                createdRunId: run.id,
              });
            } else {
              const known = existingIds.get(r.kind) ?? new Set<string>();
              known.add(internalId);
              existingIds.set(r.kind, known);
            }
            return `entity:${r.kind}:${internalId}`;
          }
          switch (r.kind) {
            case "organizationMembership":
              return `organization-membership:${resolve("player", r.player)}:${resolve("organization", r.organization)}:${r.startsOn}`;
            case "teamMembership":
              return `team-membership:${resolve("player", r.player)}:${resolve("team", r.team)}:${resolve("season", r.season)}:${r.startsOn}`;
            case "rosterObservation":
              return `roster:${snapshot.provider}:${resolve("player", r.player)}:${resolve("team", r.team)}:${snapshot.observedAt}`;
            case "gameLineSet":
              return `game-line-set:${resolve("game", r.game)}`;
            case "battingGame":
            case "pitchingGame":
              return `${r.kind}:${resolve("player", r.player)}:${resolve("game", r.game)}`;
            default:
              throw new ApplyError("unsupported-record");
          }
        });
        beginStage("apply:read-state");
        const lineTables = {
          battingGame: core.playerBattingGames,
          pitchingGame: core.playerPitchingGames,
        } as const;
        const lineSetGames = batch.records.flatMap((r) =>
          r.kind === "gameLineSet" ? [resolve("game", r.game)] : [],
        );
        // Existing boxscore lines that a replacement line set may remove.
        const storedLines = new Map<
          string,
          { id: string; playerId: string }[]
        >();
        for (const kind of ["battingGame", "pitchingGame"] as const) {
          const table = lineTables[kind];
          for (const line of await selectIn(lineSetGames, (chunk) =>
            tx
              .select({
                id: table.id,
                playerId: table.playerId,
                gameId: table.gameId,
              })
              .from(table)
              .where(inArray(table.gameId, chunk)),
          )) {
            const key = `${kind}:${line.gameId}`;
            storedLines.set(key, [...(storedLines.get(key) ?? []), line]);
          }
        }
        const staleCandidates = [...storedLines].flatMap(([key, lines]) =>
          lines.map(
            (l) => `${key.split(":")[0]}:${l.playerId}:${key.split(":")[1]}`,
          ),
        );
        const owners = new Map(
          (
            await selectIn(
              [...new Set([...canonicalKeys, ...staleCandidates])],
              (chunk) =>
                tx
                  .select()
                  .from(meta.ingestionRecordState)
                  .where(
                    inArray(meta.ingestionRecordState.canonicalKey, chunk),
                  ),
            )
          ).map((o) => [o.canonicalKey, o]),
        );
        const priorKeys = new Map(
          (
            await selectIn(batch.records.map(sourceKeyOf), (chunk) =>
              tx
                .select()
                .from(meta.ingestionRecordState)
                .where(
                  and(
                    eq(meta.ingestionRecordState.provider, snapshot.provider),
                    inArray(meta.ingestionRecordState.recordKey, chunk),
                  ),
                ),
            )
          ).map((s) => [s.recordKey, s.canonicalKey]),
        );
        const presentIds = new Set<string>();
        for (const [kind, known] of existingIds) {
          const table = tables[kind];
          for (const row of await selectIn([...known], (chunk) =>
            tx
              .select({ id: table.id })
              .from(table)
              .where(inArray(table.id, chunk)),
          ))
            presentIds.add(`${kind}:${row.id}`);
        }
        const membershipPlayers = batch.records.flatMap((r) =>
          r.kind === "organizationMembership"
            ? [resolve("player", r.player)]
            : [],
        );
        const stints = new Map<
          string,
          { organizationId: string; startsOn: string; endsOn: string | null }[]
        >();
        for (const m of await selectIn(
          [...new Set(membershipPlayers)],
          (chunk) =>
            tx
              .select()
              .from(core.playerOrganizationMemberships)
              .where(
                inArray(core.playerOrganizationMemberships.playerId, chunk),
              ),
        ))
          stints.set(m.playerId, [...(stints.get(m.playerId) ?? []), m]);
        const statGames = batch.records.flatMap((r) =>
          r.kind === "battingGame" || r.kind === "pitchingGame"
            ? [resolve("game", r.game)]
            : [],
        );
        const games = new Map<
          string,
          { homeTeamId: string; awayTeamId: string }
        >(
          (
            await selectIn([...new Set(statGames)], (chunk) =>
              tx
                .select({
                  id: core.games.id,
                  homeTeamId: core.games.homeTeamId,
                  awayTeamId: core.games.awayTeamId,
                })
                .from(core.games)
                .where(inArray(core.games.id, chunk)),
            )
          ).map((g) => [g.id, g]),
        );
        beginStage("apply:plan-writes", {
          done: 0,
          total: batch.records.length,
        });
        const seen = new Set<string>();
        const claimedSourceKeys = new Map<string, string>();
        const pendingState = new Map<
          string,
          typeof meta.ingestionRecordState.$inferInsert
        >();
        const claim = (r: IngestionRecord, canonicalKey: string) => {
          const sourceKey = sourceKeyOf(r);
          if (seen.has(canonicalKey))
            throw new ApplyError("duplicate-canonical-row");
          seen.add(canonicalKey);
          const owner = owners.get(canonicalKey);
          if (
            owner &&
            (owner.provider !== snapshot.provider ||
              owner.recordKey !== sourceKey)
          )
            throw new ApplyError("source-ownership-conflict");
          const priorKey =
            claimedSourceKeys.get(sourceKey) ?? priorKeys.get(sourceKey);
          if (priorKey && priorKey !== canonicalKey)
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
          claimedSourceKeys.set(sourceKey, canonicalKey);
          pendingState.set(canonicalKey, {
            provider: snapshot.provider,
            recordKey: sourceKey,
            canonicalKey,
            contentHash: hash,
            observedAt,
            lastRunId: run.id,
          });
          if (owner?.contentHash === hash) {
            report.unchanged!++;
            return false;
          }
          report.changed!++;
          return true;
        };
        const writes = {
          league: [] as Row[],
          level: [] as Row[],
          season: [] as Row[],
          organization: [] as Row[],
          team: [] as Row[],
          player: [] as Row[],
          game: [] as Row[],
          organizationMembership: [] as Row[],
          teamMembership: [] as Row[],
          rosterObservation: [] as Row[],
        };
        const pendingLines = {
          battingGame: new Map<string, Row>(),
          pitchingGame: new Map<string, Row>(),
        };
        const staleLineIds = {
          battingGame: [] as string[],
          pitchingGame: [] as string[],
        };
        const staleStateIds: string[] = [];
        const completedGames: string[] = [];
        for (const [index, r] of batch.records.entries()) {
          if (index % RECORD_PROGRESS_INTERVAL === 0) {
            if (this.signal?.aborted) throw new ApplyError("interrupted");
            updateStage({ done: index, kind: r.kind });
          }
          const canonicalKey = canonicalKeys[index];
          if (isEntityKind(r.kind) && "externalId" in r) {
            const internalId = ids.get(`${r.kind}:${r.externalId}`)!;
            if (
              existingIds.get(r.kind)?.has(internalId) &&
              !presentIds.has(`${r.kind}:${internalId}`)
            )
              throw new ApplyError("dangling-identity");
            if (!claim(r, canonicalKey)) continue;
            // UUIDs are internal; provider IDs remain exclusively in source_identities.
            const slug = `${snapshot.provider}-${internalId}`;
            switch (r.kind) {
              case "league":
                writes.league.push({ id: internalId, name: r.name, slug });
                break;
              case "level":
                writes.level.push({
                  id: internalId,
                  name: r.name,
                  slug,
                  leagueId: resolve("league", r.league),
                });
                break;
              case "season":
                writes.season.push({
                  id: internalId,
                  year: r.year,
                  name: r.name,
                });
                break;
              case "organization":
                writes.organization.push({
                  id: internalId,
                  name: r.name,
                  slug,
                  abbreviation: r.abbreviation,
                });
                break;
              case "team":
                writes.team.push({
                  id: internalId,
                  name: r.name,
                  slug,
                  abbreviation: r.abbreviation,
                  levelId: resolve("level", r.level),
                  organizationId: r.organization
                    ? resolve("organization", r.organization)
                    : null,
                });
                break;
              case "player":
                writes.player.push({
                  id: internalId,
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
                });
                break;
              case "game": {
                const homeTeamId = resolve("team", r.homeTeam),
                  awayTeamId = resolve("team", r.awayTeam);
                if (homeTeamId === awayTeamId)
                  throw new ApplyError("invalid-game-teams");
                games.set(internalId, { homeTeamId, awayTeamId });
                writes.game.push({
                  id: internalId,
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
                });
                break;
              }
            }
            continue;
          }
          switch (r.kind) {
            case "organizationMembership": {
              const playerId = resolve("player", r.player),
                organizationId = resolve("organization", r.organization);
              const existing = stints.get(playerId) ?? [];
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
              if (claim(r, canonicalKey)) {
                // Later stints in this batch are checked against this write, as if already applied.
                const same = existing.find(
                  (m) =>
                    m.organizationId === organizationId &&
                    m.startsOn === r.startsOn,
                );
                if (same) {
                  if (r.endsOn !== undefined) same.endsOn = r.endsOn;
                } else
                  stints.set(playerId, [
                    ...existing,
                    {
                      organizationId,
                      startsOn: r.startsOn,
                      endsOn: r.endsOn ?? null,
                    },
                  ]);
                writes.organizationMembership.push({
                  playerId,
                  organizationId,
                  startsOn: r.startsOn,
                  endsOn: r.endsOn,
                });
              }
              break;
            }
            case "teamMembership":
              if (claim(r, canonicalKey))
                writes.teamMembership.push({
                  playerId: resolve("player", r.player),
                  teamId: resolve("team", r.team),
                  seasonId: resolve("season", r.season),
                  startsOn: r.startsOn,
                  endsOn: r.endsOn,
                  assignmentType: r.assignmentType,
                });
              break;
            case "rosterObservation":
              if (claim(r, canonicalKey))
                writes.rosterObservation.push({
                  provider: snapshot.provider,
                  playerId: resolve("player", r.player),
                  teamId: resolve("team", r.team),
                  organizationId: r.organization
                    ? resolve("organization", r.organization)
                    : null,
                  ...(r.season
                    ? { seasonId: resolve("season", r.season) }
                    : {}),
                  ...(r.rosterStatus ? { rosterStatus: r.rosterStatus } : {}),
                  observedAt,
                  runId: run.id,
                });
              break;
            case "battingGame":
            case "pitchingGame": {
              const playerId = resolve("player", r.player),
                gameId = resolve("game", r.game),
                teamId = resolve("team", r.team);
              const game = games.get(gameId);
              if (!game || ![game.homeTeamId, game.awayTeamId].includes(teamId))
                throw new ApplyError("stat-team-not-in-game");
              if (claim(r, canonicalKey))
                pendingLines[r.kind].set(`${playerId}:${gameId}`, {
                  playerId,
                  gameId,
                  teamId,
                  ...r.stats,
                });
              break;
            }
            case "gameLineSet": {
              const gameId = resolve("game", r.game);
              if (!claim(r, canonicalKey)) break;
              for (const [kind, people] of [
                ["battingGame", r.battingPlayers],
                ["pitchingGame", r.pitchingPlayers],
              ] as const) {
                const expected = new Set(
                  people.map((p) => resolve("player", p)),
                );
                const stored = storedLines.get(`${kind}:${gameId}`) ?? [];
                const current = new Set([
                  ...stored.map((l) => l.playerId),
                  ...[...pendingLines[kind].values()]
                    .filter((l) => l.gameId === gameId)
                    .map((l) => l.playerId as string),
                ]);
                for (const playerId of current)
                  if (!expected.has(playerId)) {
                    const key = `${kind}:${playerId}:${gameId}`;
                    const owner = pendingState.get(key) ?? owners.get(key);
                    if (!owner || owner.provider !== snapshot.provider)
                      throw new ApplyError(
                        "boxscore-replacement-ownership-conflict",
                      );
                    pendingLines[kind].delete(`${playerId}:${gameId}`);
                    pendingState.delete(key);
                    const line = stored.find((l) => l.playerId === playerId);
                    if (line) staleLineIds[kind].push(line.id);
                    const storedOwner = owners.get(key);
                    if (storedOwner) staleStateIds.push(storedOwner.id);
                  }
              }
              completedGames.push(gameId);
              break;
            }
          }
        }
        // Writes follow foreign-key order; every statement stays inside this transaction.
        const write = async (
          stage: string,
          rows: Row[],
          execute: (rows: Row[]) => Promise<unknown>,
        ) => {
          if (!rows.length) return;
          if (this.signal?.aborted) throw new ApplyError("interrupted");
          beginStage(`apply:write:${stage}`, { rows: rows.length });
          await execute(rows);
        };
        await write("source_identities", newIdentities, (rows) =>
          bulkInsert(tx, meta.sourceIdentities, rows),
        );
        for (const kind of [
          "league",
          "level",
          "season",
          "organization",
          "team",
          "player",
          "game",
        ] as const)
          await write(kind, writes[kind], (rows) =>
            bulkUpsert(tx, tables[kind], ["id"], rows),
          );
        const m = core.playerOrganizationMemberships;
        await write(
          "organization_memberships",
          writes.organizationMembership,
          (rows) =>
            bulkUpsert(tx, m, ["playerId", "organizationId", "startsOn"], rows),
        );
        const t = core.playerTeamMemberships;
        await write("team_memberships", writes.teamMembership, (rows) =>
          bulkUpsert(
            tx,
            t,
            ["playerId", "teamId", "seasonId", "startsOn"],
            rows,
          ),
        );
        const o = meta.sourceRosterObservations;
        await write("roster_observations", writes.rosterObservation, (rows) =>
          bulkUpsert(
            tx,
            o,
            ["provider", "playerId", "teamId", "observedAt"],
            rows,
          ),
        );
        for (const kind of ["battingGame", "pitchingGame"] as const) {
          const table = lineTables[kind];
          await write(kind, [...pendingLines[kind].values()], (rows) =>
            bulkUpsert(tx, table, ["playerId", "gameId"], rows),
          );
          await write(
            `${kind}:stale`,
            staleLineIds[kind].map((id) => ({ id })),
            (rows) =>
              selectIn(
                rows.map((r) => r.id as string),
                (chunk) =>
                  tx
                    .delete(table)
                    .where(inArray(table.id, chunk))
                    .returning({ id: table.id }),
              ),
          );
        }
        await write(
          "game_boxscore_complete",
          completedGames.map((id) => ({ id })),
          (rows) =>
            selectIn(
              rows.map((r) => r.id as string),
              (chunk) =>
                tx
                  .update(core.games)
                  .set({ boxscoreComplete: true })
                  .where(inArray(core.games.id, chunk))
                  .returning({ id: core.games.id }),
            ),
        );
        const s = meta.ingestionRecordState;
        await write("record_state", [...pendingState.values()], (rows) =>
          bulkUpsert(tx, s, ["canonicalKey"], rows, [
            "contentHash",
            "observedAt",
            "lastRunId",
          ]),
        );
        await write(
          "record_state:stale",
          staleStateIds.map((id) => ({ id })),
          (rows) =>
            selectIn(
              rows.map((r) => r.id as string),
              (chunk) =>
                tx
                  .delete(s)
                  .where(inArray(s.id, chunk))
                  .returning({ id: s.id }),
            ),
        );
        beginStage("apply:run-complete", {
          changed: report.changed,
          unchanged: report.unchanged,
        });
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
        beginStage("apply:commit");
      });
      progress("apply:committed", {
        status: report.status,
        changed: report.changed,
        unchanged: report.unchanged,
      });
      return report;
    } catch (error) {
      const code =
        error instanceof ApplyError ? error.code : "database-write-failed";
      const state = sqlState(error);
      progress("apply:rolled-back", { code, sqlstate: state });
      beginStage("apply:mark-failed");
      await this.db
        .update(meta.ingestionRuns)
        .set({ status: "failed", errorCode: code, completedAt: new Date() })
        .where(eq(meta.ingestionRuns.id, run.id));
      throw new Error(
        `Ingestion rolled back (${code}${state ? `, SQLSTATE ${state}` : ""}); run ${run.id}`,
      );
    }
  }
}
