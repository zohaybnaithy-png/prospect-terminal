/**
 * Analytics/read-model readiness report over loaded competition levels (ops tooling, read-only).
 * Exercises the same view-model functions the pages use — /data (levelCoverage), /players
 * (directoryRows), /trends and / (riserSets), /players/[id] (playerAnalyticsView, playerLevels) —
 * and reports counts and availability. It computes nothing new and changes no formula.
 */
import { MOMENTUM_WINDOW_IDS, type MomentumWindow, type Role } from "@/analytics/config";
import { playerAnalyticsView, riserSets } from "@/analytics/views";
import { directoryRows } from "@/services/players/adapter";
import type { StatWindow } from "@/services/players/directory";
import { LEVELS, type LevelId } from "@/services/players/levels";
import { levelCoverage, playerLevels } from "./model";
import type { CompetitionDataResult, LevelSnapshot } from "./types";

const STAT_WINDOWS: StatWindow[] = ["7d", "14d", "30d", "season"];
const ROLES: Role[] = ["hitter", "pitcher"];

export interface LevelReadiness {
  level: LevelId;
  loadStatus: string;
  coverageStatus: string;
  games: number;
  finalGames: number;
  firstGame: string | null;
  lastGame: string | null;
  players: number;
  teams: number;
  battingLines: number;
  pitchingLines: number;
  /** /players rows per stat window and role (one per player identity). */
  directory: Record<StatWindow, Record<Role, number>>;
  /** Players with a valid Momentum comparison (status ok) per role and window. */
  momentumComparable: Record<Role, Record<MomentumWindow, number>>;
  /** Overall risers listed per role and window (Trending). */
  risers: Record<Role, Record<MomentumWindow, number>>;
  sampleProfile: {
    roles: string[];
    momentumStatus: Record<string, Record<MomentumWindow, string>>;
    levels: LevelId[];
  } | null;
  problems: string[];
}

export interface ReadinessReport {
  status: CompetitionDataResult["status"];
  levels: LevelReadiness[];
  multiLevelPlayers: number;
  allLevelsDirectory: Record<Role, number>;
  problems: string[];
}

function levelReadiness(ls: LevelSnapshot, all: LevelSnapshot[], loadStatus: string, coverageStatus: string): LevelReadiness {
  const s = ls.snapshot;
  const problems: string[] = [];
  const gameIds = new Set(s.games.map((g) => g.id));
  const playerIds = new Set(s.players.map((p) => p.id));
  const lines = [...s.batting, ...s.pitching];
  const orphanGame = lines.filter((l) => !gameIds.has(l.gameId)).length;
  const orphanPlayer = lines.filter((l) => !playerIds.has(l.playerId)).length;
  if (orphanGame) problems.push(`${orphanGame} lines reference games outside the snapshot`);
  if (orphanPlayer) problems.push(`${orphanPlayer} lines reference players outside the snapshot`);
  const final = s.games.filter((g) => g.status === "final");
  const dates = final.map((g) => g.date).sort();

  const directory = {} as LevelReadiness["directory"];
  for (const window of STAT_WINDOWS) {
    directory[window] = {} as Record<Role, number>;
    for (const role of ROLES) directory[window][role] = directoryRows(all, { level: ls.level, window, role }).length;
  }
  const sets = riserSets(s, 10);
  const risers = { hitter: {}, pitcher: {} } as LevelReadiness["risers"];
  for (const role of ROLES)
    for (const w of MOMENTUM_WINDOW_IDS) risers[role][w] = sets.lists[role][w]?.overall?.risers.length ?? 0;

  // Sample profile: the player with the most plate appearances at this level.
  const pa = new Map<string, number>();
  for (const b of s.batting) pa.set(b.playerId, (pa.get(b.playerId) ?? 0) + (b.plateAppearances ?? 0));
  const top = [...pa].sort((a, b) => b[1] - a[1])[0]?.[0];
  let sampleProfile: LevelReadiness["sampleProfile"] = null;
  if (top) {
    const view = playerAnalyticsView(s, top);
    sampleProfile = {
      roles: view.roles.map((r) => r.role),
      momentumStatus: Object.fromEntries(
        view.roles.map((r) => [r.role, Object.fromEntries(MOMENTUM_WINDOW_IDS.map((w) => [w, r.momentum[w].status]))]),
      ) as Record<string, Record<MomentumWindow, string>>,
      levels: playerLevels(all, top).map((p) => p.level),
    };
    if (!sampleProfile.levels.includes(ls.level)) problems.push("sample player's profile does not list this level");
  }
  if (final.length && !directory.season.hitter && !directory.season.pitcher)
    problems.push("final games exist but the season directory is empty");
  return {
    level: ls.level,
    loadStatus,
    coverageStatus,
    games: s.games.length,
    finalGames: final.length,
    firstGame: dates[0] ?? null,
    lastGame: dates.at(-1) ?? null,
    players: s.players.length,
    teams: s.teams.length,
    battingLines: s.batting.length,
    pitchingLines: s.pitching.length,
    directory,
    momentumComparable: sets.comparable,
    risers,
    sampleProfile,
    problems,
  };
}

export function readinessReport(result: CompetitionDataResult): ReadinessReport {
  if (result.status !== "ok")
    return { status: result.status, levels: [], multiLevelPlayers: 0, allLevelsDirectory: { hitter: 0, pitcher: 0 }, problems: [`competition data ${result.status}`] };
  const coverage = new Map(levelCoverage(result.levels, result.levelStatus).map((c) => [c.level.id, c.status]));
  const levels = LEVELS.map((d) => result.levels.find((l) => l.level === d.id))
    .filter((l): l is LevelSnapshot => !!l)
    .map((ls) => levelReadiness(ls, result.levels, result.levelStatus[ls.level] ?? "ok", coverage.get(ls.level) ?? "unknown"));
  const seen = new Map<string, Set<LevelId>>();
  for (const ls of result.levels.filter((l) => l.level !== "afl"))
    for (const l of [...ls.snapshot.batting, ...ls.snapshot.pitching]) {
      const set = seen.get(l.playerId) ?? new Set<LevelId>();
      set.add(ls.level);
      seen.set(l.playerId, set);
    }
  return {
    status: result.status,
    levels,
    multiLevelPlayers: [...seen.values()].filter((s) => s.size > 1).length,
    allLevelsDirectory: {
      hitter: directoryRows(result.levels, { window: "season", role: "hitter" }).length,
      pitcher: directoryRows(result.levels, { window: "season", role: "pitcher" }).length,
    },
    problems: levels.flatMap((l) => l.problems.map((p) => `${l.level}: ${p}`)),
  };
}
