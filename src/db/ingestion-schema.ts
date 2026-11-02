import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { players, teams, organizations, seasons } from "./schema";
const id = () => uuid("id").primaryKey().defaultRandom();
const now = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const sourceSnapshots = pgTable(
  "source_snapshots",
  {
    id: id(),
    provider: text("provider").notNull(),
    snapshotKey: text("snapshot_key").notNull(),
    contentHash: text("content_hash").notNull(),
    payload: jsonb("payload").notNull(),
    sourceUrl: text("source_url").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("source_snapshot_revision").on(
      t.provider,
      t.snapshotKey,
      t.contentHash,
      t.observedAt,
    ),
  ],
);
export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: id(),
    provider: text("provider").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => sourceSnapshots.id),
    status: text("status").notNull(),
    counts: jsonb("counts").notNull().default({}),
    errorCode: text("error_code"),
    startedAt: now(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("ingestion_run_provider").on(t.provider, t.startedAt)],
);
/** Polymorphic internal IDs are verified against their typed core table in the writer. */
export const sourceIdentities = pgTable(
  "source_identities",
  {
    id: id(),
    provider: text("provider").notNull(),
    entityKind: text("entity_kind").notNull(),
    externalId: text("external_id").notNull(),
    internalId: uuid("internal_id").notNull(),
    createdRunId: uuid("created_run_id")
      .notNull()
      .references(() => ingestionRuns.id),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("source_identity_external").on(
      t.provider,
      t.entityKind,
      t.externalId,
    ),
    index("source_identity_internal").on(t.entityKind, t.internalId),
  ],
);
export const ingestionIssues = pgTable("ingestion_issues", {
  id: id(),
  runId: uuid("run_id")
    .notNull()
    .references(() => ingestionRuns.id),
  recordKey: text("record_key").notNull(),
  code: text("code").notNull(),
  message: text("message").notNull(),
  createdAt: now(),
});
/** One source owns each logical canonical row. Cross-source replacement needs reconciliation. */
export const ingestionRecordState = pgTable(
  "ingestion_record_state",
  {
    id: id(),
    provider: text("provider").notNull(),
    recordKey: text("record_key").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    contentHash: text("content_hash").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    lastRunId: uuid("last_run_id")
      .notNull()
      .references(() => ingestionRuns.id),
  },
  (t) => [
    uniqueIndex("ingestion_record_source_key").on(t.provider, t.recordKey),
    uniqueIndex("ingestion_canonical_owner").on(t.canonicalKey),
  ],
);
export const sourceRosterObservations = pgTable(
  "source_roster_observations",
  {
    id: id(),
    provider: text("provider").notNull(),
    seasonId: uuid("season_id").references(() => seasons.id),
    rosterStatus: text("roster_status"),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    organizationId: uuid("organization_id").references(() => organizations.id),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => ingestionRuns.id),
  },
  (t) => [
    uniqueIndex("roster_observation_source").on(
      t.provider,
      t.playerId,
      t.teamId,
      t.observedAt,
    ),
  ],
);
