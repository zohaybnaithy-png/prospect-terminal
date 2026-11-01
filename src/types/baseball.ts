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
export interface Team {
  id: string;
  name: string;
  abbreviation: string;
  conference: string;
  level: string;
  color: string;
}
export interface ScoreObservation {
  date: string;
  grade: number;
  momentum: number;
}
export interface BattingStats {
  atBats: number;
  hits: number;
  homeRuns: number;
  walks: number;
  strikeouts: number;
  stolenBases: number;
}
export interface PitchingStats {
  outsRecorded: number;
  earnedRuns: number;
  strikeouts: number;
  walks: number;
}
export interface Player {
  id: string;
  name: string;
  teamId: string;
  position: Position;
  year: string;
  bats: string;
  throws: string;
  grade: number;
  momentum: number;
  history: ScoreObservation[];
  batting?: BattingStats;
  pitching?: PitchingStats;
  note: string;
}
export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  category: string;
  date: string;
  playerIds: string[];
}
