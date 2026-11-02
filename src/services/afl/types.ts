import type { BattingCounts, PitchingCounts } from "@/statistics/aggregate";

/**
 * Normalized read model of the ingested AFL season, loaded from the core tables.
 * Contains internal UUIDs only; provider IDs stay in source_identities and are never exposed.
 */
export interface AflTeam {
  id: string;
  name: string;
  abbreviation: string;
}
export interface AflOrganization {
  id: string;
  name: string;
  abbreviation: string;
}
export interface AflPlayer {
  id: string;
  name: string;
  primaryPosition: string;
  secondaryPosition: string | null;
  bats: string | null;
  throws: string | null;
  birthDate: string | null;
  height: string | null;
  weight: number | null;
}
export type AflGameStatus =
  | "scheduled"
  | "in-progress"
  | "final"
  | "postponed"
  | "cancelled";
export interface AflGame {
  id: string;
  /** Official baseball date; falls back to the UTC start date like GameStatisticsRepository. */
  date: string;
  startsAt: string;
  status: AflGameStatus | string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number | null;
  awayScore: number | null;
  venue: string | null;
  boxscoreComplete: boolean;
}
/** Grouped source roster observations: participation evidence, not dated transactions. */
export interface AflRosterStint {
  playerId: string;
  teamId: string;
  organizationId: string | null;
  rosterStatus: string | null;
  firstObservedAt: string;
  lastObservedAt: string;
}
export interface AflBattingLine extends BattingCounts {
  playerId: string;
  gameId: string;
  teamId: string;
}
export interface AflPitchingLine extends PitchingCounts {
  playerId: string;
  gameId: string;
  teamId: string;
}
export interface AflSnapshot {
  league: { id: string; name: string };
  season: { id: string; year: number; name: string };
  teams: AflTeam[];
  organizations: AflOrganization[];
  players: AflPlayer[];
  games: AflGame[];
  rosterStints: AflRosterStint[];
  batting: AflBattingLine[];
  pitching: AflPitchingLine[];
  /** completed_at of the latest applied ingestion run for the provider, if any. */
  lastIngestedAt: string | null;
}

export type AflDataResult =
  | { status: "ok"; snapshot: AflSnapshot }
  /** No DATABASE_URL in the server environment. */
  | { status: "not-configured" }
  /** Database reachable but no AFL league/season has been ingested. */
  | { status: "empty" }
  /** Connection or query failure. Details are logged server-side only. */
  | { status: "unavailable" };
