export type Position =
  | "SS"
  | "CF"
  | "1B"
  | "2B"
  | "3B"
  | "C"
  | "RF"
  | "LF"
  | "RHP"
  | "LHP"
  | "RHP / DH";
export type TimeWindow = "7d" | "14d" | "30d" | "season";
export type RankingMode = "priority" | "performance";
export type PlayerType = "all" | "hitters" | "pitchers";
export interface Organization {
  id: string;
  name: string;
  abbreviation: string;
}
/** AFL is a league context, not another rung on the affiliated-level ladder. */
export interface DevelopmentContext {
  id: string;
  slug: string;
  name: string;
  shortName: string;
  kind: "level" | "league";
}
export interface Team {
  id: string;
  name: string;
  abbreviation: string;
  contextId: string;
  organizationId: string | null;
}
export interface ScoreObservation {
  date: string;
  grade: number;
  momentum: number;
}
export interface BattingStats {
  atBats: number;
  hits: number;
  doubles: number;
  triples: number;
  homeRuns: number;
  walks: number;
  strikeouts: number;
  stolenBases: number;
  hitByPitch: number;
  sacrificeFlies: number;
}
export interface PitchingStats {
  outsRecorded: number;
  earnedRuns: number;
  hitsAllowed: number;
  strikeouts: number;
  walks: number;
}
export interface PerformanceLine {
  batting?: BattingStats;
  pitching?: PitchingStats;
}
export interface PlayerTeamMembership {
  id: string;
  playerId: string;
  teamId: string;
  season: number;
  startsOn: string;
  endsOn: string | null;
  assignmentType: "assignment" | "promotion" | "afl-assignment";
}
export interface PlayerOrganizationMembership {
  playerId: string;
  organizationId: string;
  startsOn: string;
  endsOn: string | null;
}
export interface SeasonStatLine extends PerformanceLine {
  season: number;
  teamId: string;
}
export interface Player extends PerformanceLine {
  id: string;
  name: string;
  teamId: string;
  organizationId: string;
  position: Position;
  birthDate: string;
  bats: string;
  throws: string;
  grade: number;
  momentum: number;
  history: ScoreObservation[];
  performance: Record<TimeWindow, PerformanceLine>;
  seasonStats: SeasonStatLine[];
  note: string;
}
export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  category: string;
  date: string;
  playerIds: string[];
  teamIds: string[];
  organizationIds: string[];
}
export interface DiscoveryFilters {
  ranking: RankingMode;
  context: string;
  window: TimeWindow;
  type: PlayerType;
  query: string;
  organization: string;
  team: string;
  minGrade: number;
  minMomentum: number | null;
  maxAge: number | null;
  position: string;
}
export interface Catalog {
  players: Player[];
  teams: Team[];
  organizations: Organization[];
  contexts: DevelopmentContext[];
  memberships: PlayerTeamMembership[];
  organizationMemberships: PlayerOrganizationMembership[];
  news: NewsItem[];
}
