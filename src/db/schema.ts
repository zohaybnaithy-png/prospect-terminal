import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  date,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
export const leagues = pgTable("leagues", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ...timestamps(),
});
// Data-driven levels allow D1/D2/D3, JUCO, MiLB classifications, and high school.
export const levels = pgTable("levels", {
  id: id(),
  leagueId: uuid("league_id")
    .notNull()
    .references(() => leagues.id),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ...timestamps(),
});
export const conferences = pgTable("conferences", {
  id: id(),
  leagueId: uuid("league_id")
    .notNull()
    .references(() => leagues.id),
  name: text("name").notNull(),
  ...timestamps(),
});
export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  abbreviation: text("abbreviation").notNull(),
  ...timestamps(),
});
export const teams = pgTable("teams", {
  // Fall-league teams can contain players from multiple parent organizations.
  organizationId: uuid("organization_id").references(() => organizations.id),
  id: id(),
  levelId: uuid("level_id")
    .notNull()
    .references(() => levels.id),
  conferenceId: uuid("conference_id").references(() => conferences.id),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  abbreviation: text("abbreviation").notNull(),
  ...timestamps(),
});
export const players = pgTable("players", {
  id: id(),
  name: text("name").notNull(),
  primaryPosition: text("primary_position").notNull(),
  secondaryPosition: text("secondary_position"),
  bats: text("bats"),
  throws: text("throws"),
  birthDate: date("birth_date"),
  externalIds: jsonb("external_ids")
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  ...timestamps(),
});
// Organization affiliation is independent of temporary affiliate / fall assignments.
export const playerOrganizationMemberships = pgTable(
  "player_organization_memberships",
  {
    id: id(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    ...timestamps(),
  },
  (t) => [
    index("organization_membership_player").on(t.playerId),
    uniqueIndex("organization_membership_stint").on(
      t.playerId,
      t.organizationId,
      t.startsOn,
    ),
    check(
      "organization_membership_dates",
      sql`${t.endsOn} IS NULL OR ${t.endsOn} >= ${t.startsOn}`,
    ),
  ],
);
export const seasons = pgTable(
  "seasons",
  {
    id: id(),
    year: integer("year").notNull(),
    name: text("name").notNull(),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("season_year_name").on(t.year, t.name)],
);
export const playerTeamMemberships = pgTable(
  "player_team_memberships",
  {
    id: id(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    jerseyNumber: text("jersey_number"),
    assignmentType: text("assignment_type").notNull().default("assignment"),
    ...timestamps(),
  },
  (t) => [
    index("membership_player").on(t.playerId),
    uniqueIndex("membership_stint").on(
      t.playerId,
      t.teamId,
      t.seasonId,
      t.startsOn,
    ),
    check(
      "membership_dates",
      sql`${t.endsOn} IS NULL OR ${t.endsOn} >= ${t.startsOn}`,
    ),
  ],
);
export const games = pgTable(
  "games",
  {
    id: id(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id),
    homeTeamId: uuid("home_team_id")
      .notNull()
      .references(() => teams.id),
    awayTeamId: uuid("away_team_id")
      .notNull()
      .references(() => teams.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("scheduled"),
    ...timestamps(),
  },
  (t) => [check("different_teams", sql`${t.homeTeamId} <> ${t.awayTeamId}`)],
);
const batting = () => ({
  plateAppearances: integer("plate_appearances").notNull().default(0),
  atBats: integer("at_bats").notNull().default(0),
  hits: integer("hits").notNull().default(0),
  doubles: integer("doubles").notNull().default(0),
  triples: integer("triples").notNull().default(0),
  homeRuns: integer("home_runs").notNull().default(0),
  walks: integer("walks").notNull().default(0),
  strikeouts: integer("strikeouts").notNull().default(0),
  hitByPitch: integer("hit_by_pitch").notNull().default(0),
  sacrificeFlies: integer("sacrifice_flies").notNull().default(0),
  stolenBases: integer("stolen_bases").notNull().default(0),
});
// Outs, rather than decimal innings, avoid treating 6.1 IP as 6.1 real innings.
const pitching = () => ({
  outsRecorded: integer("outs_recorded").notNull().default(0),
  battersFaced: integer("batters_faced").notNull().default(0),
  hitsAllowed: integer("hits_allowed").notNull().default(0),
  earnedRuns: integer("earned_runs").notNull().default(0),
  walks: integer("walks").notNull().default(0),
  strikeouts: integer("strikeouts").notNull().default(0),
  homeRunsAllowed: integer("home_runs_allowed").notNull().default(0),
});
const gameKeys = () => ({
  playerId: uuid("player_id")
    .notNull()
    .references(() => players.id),
  gameId: uuid("game_id")
    .notNull()
    .references(() => games.id),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
});
const seasonKeys = () => ({
  playerId: uuid("player_id")
    .notNull()
    .references(() => players.id),
  seasonId: uuid("season_id")
    .notNull()
    .references(() => seasons.id),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
});
export const playerBattingGames = pgTable(
  "player_batting_games",
  { id: id(), ...gameKeys(), ...batting(), ...timestamps() },
  (t) => [uniqueIndex("batting_game_player").on(t.playerId, t.gameId)],
);
export const playerPitchingGames = pgTable(
  "player_pitching_games",
  { id: id(), ...gameKeys(), ...pitching(), ...timestamps() },
  (t) => [uniqueIndex("pitching_game_player").on(t.playerId, t.gameId)],
);
export const playerBattingSeasons = pgTable(
  "player_batting_seasons",
  { id: id(), ...seasonKeys(), ...batting(), ...timestamps() },
  (t) => [
    uniqueIndex("batting_season_stint").on(t.playerId, t.seasonId, t.teamId),
  ],
);
export const playerPitchingSeasons = pgTable(
  "player_pitching_seasons",
  { id: id(), ...seasonKeys(), ...pitching(), ...timestamps() },
  (t) => [
    uniqueIndex("pitching_season_stint").on(t.playerId, t.seasonId, t.teamId),
  ],
);
export const rankings = pgTable(
  "rankings",
  {
    id: id(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    source: text("source").notNull(),
    rank: integer("rank").notNull(),
    scope: text("scope").notNull(),
    category: text("category").notNull(),
    asOf: date("as_of").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("ranking_observation").on(
      t.playerId,
      t.source,
      t.scope,
      t.category,
      t.asOf,
    ),
    check("positive_rank", sql`${t.rank} > 0`),
  ],
);
const scores = () => ({
  prospectGrade: numeric("prospect_grade", {
    precision: 5,
    scale: 2,
  }).notNull(),
  momentum: numeric("momentum", { precision: 7, scale: 2 }).notNull(),
  modelVersion: text("model_version").notNull(),
  explanation: text("explanation"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
});
export const prospectScores = pgTable(
  "prospect_scores",
  {
    id: id(),
    playerId: uuid("player_id")
      .notNull()
      .unique()
      .references(() => players.id),
    ...scores(),
    ...timestamps(),
  },
  (t) => [
    check("current_grade_range", sql`${t.prospectGrade} BETWEEN 0 AND 100`),
  ],
);
export const prospectScoreHistory = pgTable(
  "prospect_score_history",
  {
    id: id(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    ...scores(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("score_observation").on(
      t.playerId,
      t.modelVersion,
      t.observedAt,
    ),
    index("score_history_timeline").on(t.playerId, t.observedAt),
    check("history_grade_range", sql`${t.prospectGrade} BETWEEN 0 AND 100`),
  ],
);
export const newsItems = pgTable("news_items", {
  id: id(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  source: text("source").notNull(),
  url: text("url"),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  ...timestamps(),
});
export const newsItemPlayers = pgTable(
  "news_item_players",
  {
    id: id(),
    newsItemId: uuid("news_item_id")
      .notNull()
      .references(() => newsItems.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    ...timestamps(),
  },
  (t) => [uniqueIndex("news_player").on(t.newsItemId, t.playerId)],
);
export const highlights = pgTable("highlights", {
  id: id(),
  playerId: uuid("player_id")
    .notNull()
    .references(() => players.id),
  gameId: uuid("game_id").references(() => games.id),
  title: text("title").notNull(),
  url: text("url").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ...timestamps(),
});
