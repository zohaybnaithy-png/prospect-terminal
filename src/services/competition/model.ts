/**
 * Pure selectors across competition levels. No I/O, no new formulas: every statistic comes from
 * the per-level read model (src/services/afl/read-model) and nothing is combined across levels.
 * Levels are different competitions, so their statistics are never summed, averaged or ranked
 * against each other here.
 */
import {
  aflAsOf,
  completedGames,
  displayPosition,
  type BattingAggregate,
  type PitchingAggregate,
} from "@/services/afl/read-model";
import { aggregateBatting, aggregatePitching } from "@/statistics/aggregate";
import { coverageSummary, type CoverageSummary } from "@/services/home";
import { LEVELS, levelOrder, type LevelDefinition, type LevelId } from "@/services/players/levels";
import type { AflOrganization, AflTeam } from "@/services/afl/types";
import type { LevelLoadStatus, LevelSnapshot } from "./types";

/** Statistics are "as of" each level's latest completed game, never the wall clock. */
export const levelAsOf = (ls: LevelSnapshot) => aflAsOf(ls.snapshot);

/**
 * The level shown by default: the one with the most recent completed game (in November that is
 * the AFL; in July, whichever MiLB level played last). Ties and levels without completed games
 * fall back to ladder order. Null only when no level is loaded.
 */
export function defaultLevel(levels: LevelSnapshot[]): LevelId | null {
  let best: { level: LevelId; asOf: string | null } | null = null;
  for (const ls of [...levels].sort((a, b) => levelOrder(a.level) - levelOrder(b.level))) {
    const asOf = levelAsOf(ls);
    if (!best || (asOf !== null && (best.asOf === null || asOf > best.asOf)))
      best = { level: ls.level, asOf };
  }
  return best?.level ?? null;
}

/** The requested level when it is loaded, otherwise the default level. */
export function selectLevel(
  levels: LevelSnapshot[],
  requested: string | undefined,
): LevelSnapshot | null {
  return (
    levels.find((l) => l.level === requested) ??
    levels.find((l) => l.level === defaultLevel(levels)) ??
    null
  );
}

export type LevelCoverageStatus = "live" | "no-games" | "not-ingested" | "unavailable";

export interface LevelCoverage {
  level: LevelDefinition;
  status: LevelCoverageStatus;
  coverage: CoverageSummary | null;
}

/** One row per known level, in ladder order, with honest status for levels without data. */
export function levelCoverage(
  levels: LevelSnapshot[],
  levelStatus: Partial<Record<LevelId, LevelLoadStatus>>,
): LevelCoverage[] {
  return LEVELS.map((level) => {
    const ls = levels.find((l) => l.level === level.id);
    if (!ls)
      return {
        level,
        status: levelStatus[level.id] === "unavailable" ? "unavailable" : "not-ingested",
        coverage: null,
      };
    const coverage = coverageSummary(ls.snapshot);
    return { level, status: coverage.gamesFinal ? "live" : "no-games", coverage };
  });
}

export interface PlayerLevelPresence {
  level: LevelId;
  /** Season name of the level's snapshot (the AFL and MiLB seasons are separate seasons). */
  season: string;
  /** Completed games with a batting or pitching line at this level. */
  games: number;
  firstGame: string | null;
  lastGame: string | null;
  team: AflTeam | null;
  organization: AflOrganization | null;
  position: string;
  batting: BattingAggregate | null;
  pitching: PitchingAggregate | null;
}

/**
 * Every level whose season snapshot contains the player (game lines or a roster observation),
 * most recent game first. The player UUID is shared across levels, so this is one identity.
 */
export function playerLevels(levels: LevelSnapshot[], playerId: string): PlayerLevelPresence[] {
  const out: PlayerLevelPresence[] = [];
  for (const { level, snapshot: s } of levels) {
    const player = s.players.find((p) => p.id === playerId);
    if (!player) continue;
    const dates = new Map(completedGames(s).map((g) => [g.id, g.date]));
    const bat = s.batting.filter((l) => l.playerId === playerId && dates.has(l.gameId));
    const pit = s.pitching.filter((l) => l.playerId === playerId && dates.has(l.gameId));
    const gameDates = [...bat, ...pit].map((l) => dates.get(l.gameId)!);
    const gameIds = new Set([...bat, ...pit].map((l) => l.gameId));
    const lastLine = [...bat, ...pit].sort((a, b) =>
      dates.get(b.gameId)!.localeCompare(dates.get(a.gameId)!),
    )[0];
    const stint = s.rosterStints
      .filter((r) => r.playerId === playerId)
      .sort(
        (a, b) =>
          b.lastObservedAt.localeCompare(a.lastObservedAt) || a.teamId.localeCompare(b.teamId),
      )[0];
    const teamId = stint?.teamId ?? lastLine?.teamId ?? null;
    out.push({
      level,
      season: s.season.name,
      games: gameIds.size,
      firstGame: gameDates.length ? gameDates.reduce((a, b) => (a < b ? a : b)) : null,
      lastGame: gameDates.length ? gameDates.reduce((a, b) => (a > b ? a : b)) : null,
      team: s.teams.find((t) => t.id === teamId) ?? null,
      organization: stint?.organizationId
        ? (s.organizations.find((o) => o.id === stint.organizationId) ?? null)
        : null,
      position: displayPosition(player),
      batting: bat.length ? aggregateBatting(bat) : null,
      pitching: pit.length ? aggregatePitching(pit) : null,
    });
  }
  return out.sort(
    (a, b) =>
      (b.lastGame ?? "").localeCompare(a.lastGame ?? "") || levelOrder(a.level) - levelOrder(b.level),
  );
}

/**
 * Level a player profile opens at: the requested level when the player appears there, otherwise
 * the level of their most recent game (the first presence entry).
 */
export function profileLevel(
  presence: PlayerLevelPresence[],
  requested: string | undefined,
): LevelId | null {
  return (presence.find((p) => p.level === requested) ?? presence[0])?.level ?? null;
}
