import { z } from "zod";
const ref = z.string().min(1).max(160);
const date = z.iso.date();
const datetime = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const entity = <K extends string, S extends z.ZodRawShape>(kind: K, shape: S) =>
  z.object({ kind: z.literal(kind), externalId: ref, ...shape }).strict();
export const entityKinds = [
  "league",
  "level",
  "season",
  "organization",
  "team",
  "player",
  "game",
] as const;
export type EntityKind = (typeof entityKinds)[number];
const batting = z
  .object({
    runs: count.optional(),
    rbi: count.optional(),
    caughtStealing: count.optional(),
    sacrificeBunts: count.optional(),
    catcherInterference: count.optional(),
    plateAppearances: count,
    atBats: count,
    hits: count,
    doubles: count,
    triples: count,
    homeRuns: count,
    walks: count,
    strikeouts: count,
    hitByPitch: count,
    sacrificeFlies: count,
    stolenBases: count,
  })
  .strict()
  .refine(
    (s) =>
      s.hits <= s.atBats &&
      s.doubles + s.triples + s.homeRuns <= s.hits &&
      s.atBats + s.walks + s.hitByPitch + s.sacrificeFlies <=
        s.plateAppearances,
    "Inconsistent batting counts",
  );
const pitching = z
  .object({
    runs: count.optional(),
    hitBatters: count.optional(),
    pitches: count.optional(),
    outsRecorded: count,
    battersFaced: count,
    hitsAllowed: count,
    earnedRuns: count,
    walks: count,
    strikeouts: count,
    homeRunsAllowed: count,
  })
  .strict()
  .refine(
    (s) => s.strikeouts <= s.battersFaced && s.homeRunsAllowed <= s.hitsAllowed,
    "Inconsistent pitching counts",
  );
export const recordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("gameLineSet"),
      key: ref,
      game: ref,
      battingPlayers: z.array(ref),
      pitchingPlayers: z.array(ref),
      lineKeys: z.array(ref),
    })
    .strict(),
  entity("league", { name: ref }),
  entity("level", { league: ref, name: ref }),
  entity("season", { year: z.number().int().min(1800).max(2200), name: ref }),
  entity("organization", { name: ref, abbreviation: ref }),
  entity("team", {
    name: ref,
    abbreviation: ref,
    level: ref,
    organization: ref.nullable(),
  }),
  entity("player", {
    name: ref,
    position: ref,
    secondaryPosition: ref.nullable().optional(),
    bats: z.enum(["L", "R", "S"]).optional(),
    throws: z.enum(["L", "R"]).optional(),
    birthDate: date.optional(),
    height: ref.optional(),
    weight: count.optional(),
  }),
  entity("game", {
    season: ref,
    league: ref.optional(),
    officialDate: date.optional(),
    homeScore: count.optional(),
    awayScore: count.optional(),
    venue: ref.optional(),
    boxscoreComplete: z.boolean().optional(),
    homeTeam: ref,
    awayTeam: ref,
    startsAt: datetime,
    status: z.enum([
      "scheduled",
      "in-progress",
      "final",
      "postponed",
      "cancelled",
    ]),
  }),
  z
    .object({
      kind: z.literal("teamMembership"),
      key: ref,
      player: ref,
      team: ref,
      season: ref,
      startsOn: date,
      endsOn: date.nullable(),
      assignmentType: z.enum(["assignment", "promotion", "afl-assignment"]),
    })
    .strict()
    .refine(
      (r) => !r.endsOn || r.endsOn >= r.startsOn,
      "Membership end precedes start",
    ),
  z
    .object({
      kind: z.literal("organizationMembership"),
      key: ref,
      player: ref,
      organization: ref,
      startsOn: date,
      endsOn: date.nullable(),
    })
    .strict()
    .refine(
      (r) => !r.endsOn || r.endsOn >= r.startsOn,
      "Membership end precedes start",
    ),
  z
    .object({
      kind: z.literal("rosterObservation"),
      season: ref.optional(),
      rosterStatus: ref.optional(),
      key: ref,
      player: ref,
      team: ref,
      organization: ref.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("battingGame"),
      key: ref,
      player: ref,
      team: ref,
      game: ref,
      stats: batting,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pitchingGame"),
      key: ref,
      player: ref,
      team: ref,
      game: ref,
      stats: pitching,
    })
    .strict(),
]);
export type IngestionRecord = z.infer<typeof recordSchema>;
export interface SourceSnapshot {
  provider: string;
  adapterVersion: string;
  key: string;
  observedAt: string;
  fetchedAt: string;
  sourceUrl: string;
  payload: unknown;
  storedPayload?: unknown;
}
export interface IngestionIssue {
  recordKey: string;
  code:
    | "invalid-record"
    | "duplicate-key"
    | "missing-reference"
    | "inconsistent-game"
    | "invalid-snapshot";
  message: string;
}
export interface NormalizedBatch {
  quarantinePolicy?: "records";
  records: IngestionRecord[];
  issues: IngestionIssue[];
}
export interface SourceAdapter {
  readonly id: string;
  readonly version: string;
  load(): Promise<SourceSnapshot>;
  normalize(snapshot: SourceSnapshot): NormalizedBatch;
}
export const snapshotSchema = z
  .object({
    provider: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/),
    adapterVersion: ref,
    key: ref,
    observedAt: datetime,
    fetchedAt: datetime,
    sourceUrl: z.string().max(500),
    payload: z.unknown(),
    storedPayload: z.unknown().optional(),
  })
  .strict();
export const recordKey = (r: IngestionRecord) =>
  "externalId" in r ? `${r.kind}:${r.externalId}` : `${r.kind}:${r.key}`;
