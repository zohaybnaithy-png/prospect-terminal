/**
 * Competition levels Prospect Terminal understands. Framework-free and server/client safe.
 *
 * MiLB levels map to MLB Stats API sport IDs (the API's level hierarchy is sport → league →
 * team). Sport IDs are verified at ingestion time against the API's sport names; league IDs
 * are DISCOVERED per season, never hardcoded here. AFL is a league context, not a rung on the
 * affiliated ladder.
 */
export type MilbLevelId = "aaa" | "aa" | "high-a" | "single-a";
export type CompetitionLevelId = MilbLevelId | "afl";

export interface MilbLevel {
  id: MilbLevelId;
  label: string;
  shortLabel: string;
  /** MLB Stats API sportId. */
  sportId: number;
  /** Ladder order, Triple-A first. */
  rank: number;
  /** Accepted API sport names (verified at runtime; historical names included). */
  sportNamePattern: RegExp;
}

export const MILB_LEVELS: Record<MilbLevelId, MilbLevel> = {
  aaa: {
    id: "aaa",
    label: "Triple-A",
    shortLabel: "AAA",
    sportId: 11,
    rank: 1,
    sportNamePattern: /^triple-a$/i,
  },
  aa: {
    id: "aa",
    label: "Double-A",
    shortLabel: "AA",
    sportId: 12,
    rank: 2,
    sportNamePattern: /^double-a$/i,
  },
  "high-a": {
    id: "high-a",
    label: "High-A",
    shortLabel: "A+",
    sportId: 13,
    rank: 3,
    // Named "Class A Advanced" before 2021.
    sportNamePattern: /^(high-a|class a advanced|advanced a)$/i,
  },
  "single-a": {
    id: "single-a",
    label: "Single-A",
    shortLabel: "A",
    sportId: 14,
    rank: 4,
    // Named "Low-A" in 2021 and "Class A" earlier.
    sportNamePattern: /^(single-a|low-a|class a)$/i,
  },
};
export const MILB_LEVEL_IDS = Object.keys(MILB_LEVELS) as MilbLevelId[];

export const COMPETITION_LEVEL_LABELS: Record<CompetitionLevelId, string> = {
  aaa: "Triple-A",
  aa: "Double-A",
  "high-a": "High-A",
  "single-a": "Single-A",
  afl: "Arizona Fall League",
};

export const milbLevelBySportId = (sportId: number) =>
  MILB_LEVEL_IDS.map((id) => MILB_LEVELS[id]).find((l) => l.sportId === sportId);

export const isMilbLevelId = (value: string): value is MilbLevelId =>
  (MILB_LEVEL_IDS as string[]).includes(value);

/**
 * Source-identity key of a MiLB level row. One level row exists per (sport, league) because the
 * schema's levels belong to a league; the read model groups level rows by sport prefix.
 */
export const milbLevelExternalId = (sportId: number, leagueId: number) =>
  `milb:${sportId}:${leagueId}`;
export const milbLevelExternalIdPrefix = (sportId: number) => `milb:${sportId}:`;
export const milbSeasonExternalId = (season: number) => `milb-${season}`;
