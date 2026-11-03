/**
 * Pure selectors over an AflSnapshot. No database access, no I/O, no ranking model.
 * Rates come from the shared statistics aggregation (summed raw counts), and windows use the
 * same official-date bounds as GameStatisticsRepository.
 */
import {
  aggregateBatting,
  aggregatePitching,
  windowBounds,
} from "@/statistics/aggregate";
import { ageOn } from "@/lib/format";
import type {
  AflGame,
  AflOrganization,
  AflPlayer,
  AflRosterStint,
  AflSnapshot,
  AflTeam,
  AflBattingLine,
  AflPitchingLine,
} from "./types";
import { formatFixed, formatRate, inningsFromOuts, slashLine } from "./format";
export * from "./format";

export type AflWindow = "7d" | "14d" | "30d" | "season";
export type BattingAggregate = ReturnType<typeof aggregateBatting>;
export type PitchingAggregate = ReturnType<typeof aggregatePitching>;

export const aflWindowLabels: Record<AflWindow, string> = {
  "7d": "Last 7 days",
  "14d": "Last 14 days",
  "30d": "Last 30 days",
  season: "AFL season",
};

/** Same inclusion rule as GameStatisticsRepository: final games with a complete boxscore. */
export function completedGames(s: AflSnapshot): AflGame[] {
  return s.games.filter((g) => g.status === "final" && g.boxscoreComplete);
}

/** Statistics are "as of" the latest completed game, never the wall clock. */
export function aflAsOf(s: AflSnapshot): string | null {
  return completedGames(s).reduce<string | null>(
    (max, g) => (max === null || g.date > max ? g.date : max),
    null,
  );
}

export function aflWindowBounds(s: AflSnapshot, window: AflWindow) {
  const asOf = aflAsOf(s);
  if (!asOf || Number(asOf.slice(0, 4)) !== s.season.year) return null;
  return windowBounds({
    season: s.season.year,
    asOf,
    window,
    leagueId: s.league.id,
  });
}

function completedGameDates(s: AflSnapshot, window: AflWindow) {
  const bounds = aflWindowBounds(s, window);
  return bounds ? completedGameDatesInRange(s, bounds) : new Map<string, string>();
}

/** Completed-game id → official date for an inclusive date range (same inclusion rule). */
export function completedGameDatesInRange(
  s: AflSnapshot,
  range: { from: string; to: string },
) {
  const dates = new Map<string, string>();
  for (const g of completedGames(s))
    if (g.date >= range.from && g.date <= range.to) dates.set(g.id, g.date);
  return dates;
}

export function groupByPlayer<T extends { playerId: string; gameId: string }>(
  lines: T[],
  games: Map<string, string>,
) {
  const grouped = new Map<string, T[]>();
  for (const line of lines) {
    if (!games.has(line.gameId)) continue;
    const list = grouped.get(line.playerId);
    if (list) list.push(line);
    else grouped.set(line.playerId, [line]);
  }
  return grouped;
}

const byId = <T extends { id: string }>(rows: T[]) =>
  new Map(rows.map((r) => [r.id, r]));

/** Most recent roster observation wins; ties prefer the earlier-sorted team for stability. */
export function currentStint(
  s: AflSnapshot,
  playerId: string,
): AflRosterStint | null {
  return (
    s.rosterStints
      .filter((r) => r.playerId === playerId)
      .sort(
        (a, b) =>
          b.lastObservedAt.localeCompare(a.lastObservedAt) ||
          a.teamId.localeCompare(b.teamId),
      )[0] ?? null
  );
}

function lastLineTeam(
  s: AflSnapshot,
  playerId: string,
  gameById: Map<string, AflGame>,
): string | null {
  let best: { date: string; teamId: string } | null = null;
  for (const line of [...s.batting, ...s.pitching]) {
    if (line.playerId !== playerId) continue;
    const date = gameById.get(line.gameId)?.date ?? "";
    if (!best || date > best.date) best = { date, teamId: line.teamId };
  }
  return best?.teamId ?? null;
}

export interface AflPlayerContext {
  team: AflTeam | null;
  organization: AflOrganization | null;
  rosterStatus: string | null;
  /** "roster" when from a source roster observation, "game-lines" when inferred from box scores. */
  teamSource: "roster" | "game-lines" | null;
}

function playerContext(
  s: AflSnapshot,
  playerId: string,
  maps: {
    teams: Map<string, AflTeam>;
    organizations: Map<string, AflOrganization>;
    games: Map<string, AflGame>;
  },
): AflPlayerContext {
  const stint = currentStint(s, playerId);
  if (stint)
    return {
      team: maps.teams.get(stint.teamId) ?? null,
      organization: stint.organizationId
        ? (maps.organizations.get(stint.organizationId) ?? null)
        : null,
      rosterStatus: stint.rosterStatus,
      teamSource: "roster",
    };
  const teamId = lastLineTeam(s, playerId, maps.games);
  return {
    team: teamId ? (maps.teams.get(teamId) ?? null) : null,
    organization: null,
    rosterStatus: null,
    teamSource: teamId ? "game-lines" : null,
  };
}

export interface AflPlayerRow extends AflPlayerContext {
  id: string;
  name: string;
  position: string;
  age: number | null;
  batting: BattingAggregate | null;
  pitching: PitchingAggregate | null;
}

/** One row per AFL player with the selected window's aggregates (null when no lines). */
export function buildPlayerRows(
  s: AflSnapshot,
  window: AflWindow = "season",
): AflPlayerRow[] {
  const asOf = aflAsOf(s);
  const games = completedGameDates(s, window);
  const batting = groupByPlayer(s.batting, games);
  const pitching = groupByPlayer(s.pitching, games);
  const maps = {
    teams: byId(s.teams),
    organizations: byId(s.organizations),
    games: byId(s.games),
  };
  return s.players
    .map((p) => {
      const b = batting.get(p.id),
        pi = pitching.get(p.id);
      return {
        id: p.id,
        name: p.name,
        position: displayPosition(p),
        age: p.birthDate && asOf ? ageOn(p.birthDate, asOf) : null,
        ...playerContext(s, p.id, maps),
        batting: b?.length ? aggregateBatting(b) : null,
        pitching: pi?.length ? aggregatePitching(pi) : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function displayPosition(p: AflPlayer) {
  return p.secondaryPosition
    ? `${p.primaryPosition} / ${p.secondaryPosition}`
    : p.primaryPosition;
}

export interface PlayerRowFilters {
  query?: string;
  teamId?: string;
  organizationId?: string;
}
export function filterPlayerRows(
  rows: AflPlayerRow[],
  { query = "", teamId, organizationId }: PlayerRowFilters,
) {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!teamId || r.team?.id === teamId) &&
      (!organizationId || r.organization?.id === organizationId) &&
      (!q ||
        [
          r.name,
          r.team?.name,
          r.team?.abbreviation,
          r.organization?.name,
          r.organization?.abbreviation,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q)),
  );
}

/**
 * Descriptive leaderboard qualification. These are display thresholds for a raw-stat sort,
 * NOT a Prospect Priority, Momentum, or Pure Performance formula.
 */
export const RECENT_HITTER_MIN_PA: Record<
  Exclude<AflWindow, "season">,
  number
> = { "7d": 10, "14d": 20, "30d": 40 };

export interface RecentPerformer {
  playerId: string;
  name: string;
  team: AflTeam | null;
  organization: AflOrganization | null;
  /** Raw-stat summary, e.g. ".333/.400/.600 · 25 PA" or "12.0 IP · 1.50 ERA". */
  summary: string;
  /** The single statistic used for the descriptive sort. */
  sortLabel: string;
  sortValue: string;
}

export function recentPerformers(
  s: AflSnapshot,
  window: Exclude<AflWindow, "season">,
  role: "hitters" | "pitchers",
  limit = 5,
): RecentPerformer[] {
  const rows = buildPlayerRows(s, window);
  if (role === "hitters")
    return rows
      .filter(
        (r): r is AflPlayerRow & { batting: BattingAggregate } =>
          r.batting !== null &&
          r.batting.ops !== null &&
          r.batting.plateAppearances >= RECENT_HITTER_MIN_PA[window],
      )
      .sort(
        (a, b) =>
          b.batting.ops! - a.batting.ops! ||
          b.batting.plateAppearances - a.batting.plateAppearances ||
          a.name.localeCompare(b.name),
      )
      .slice(0, limit)
      .map((r) => ({
        playerId: r.id,
        name: r.name,
        team: r.team,
        organization: r.organization,
        summary: `${slashLine(r.batting)} · ${r.batting.plateAppearances} PA`,
        sortLabel: "OPS",
        sortValue: formatRate(r.batting.ops),
      }));
  return rows
    .filter(
      (r): r is AflPlayerRow & { pitching: PitchingAggregate } =>
        r.pitching !== null && r.pitching.outsRecorded > 0,
    )
    .sort(
      (a, b) =>
        b.pitching.strikeouts - a.pitching.strikeouts ||
        b.pitching.outsRecorded - a.pitching.outsRecorded ||
        a.pitching.earnedRuns - b.pitching.earnedRuns ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit)
    .map((r) => ({
      playerId: r.id,
      name: r.name,
      team: r.team,
      organization: r.organization,
      summary: `${inningsFromOuts(r.pitching.outsRecorded)} IP · ${formatFixed(r.pitching.era, 2)} ERA`,
      sortLabel: "K",
      sortValue: String(r.pitching.strikeouts),
    }));
}

export interface ScoreboardGame {
  id: string;
  date: string;
  statusLabel: string;
  away: AflTeam;
  home: AflTeam;
  awayScore: number | null;
  homeScore: number | null;
}

/**
 * Latest date with completed games, plus the next date with games still to play.
 * Falls back to the earliest upcoming dates before the first completed game.
 */
export function scoreboard(s: AflSnapshot, limit = 8): ScoreboardGame[] {
  const teams = byId(s.teams);
  const sorted = [...s.games].sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.startsAt.localeCompare(b.startsAt),
  );
  const latestFinal = aflAsOf(s);
  const nextDate = sorted.find(
    (g) =>
      g.status === "scheduled" &&
      (latestFinal === null || g.date > latestFinal),
  )?.date;
  const dates = new Set([latestFinal, nextDate].filter(Boolean));
  const picked = dates.size
    ? sorted.filter((g) => dates.has(g.date))
    : sorted.slice(-limit);
  return picked.slice(0, limit).flatMap((g) => {
    const home = teams.get(g.homeTeamId),
      away = teams.get(g.awayTeamId);
    if (!home || !away) return [];
    const hasScore = g.status === "final" || g.status === "in-progress";
    return [
      {
        id: g.id,
        date: g.date,
        statusLabel: gameStatusLabel(g),
        home,
        away,
        // Scores are shown only once play has started; scheduled/postponed rows show none.
        homeScore: hasScore ? g.homeScore : null,
        awayScore: hasScore ? g.awayScore : null,
      },
    ];
  });
}

const phoenixTime = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Phoenix",
});
export function gameStatusLabel(g: AflGame) {
  switch (g.status) {
    case "final":
      return "Final";
    case "in-progress":
      return "In progress";
    case "postponed":
      return "Postponed";
    case "cancelled":
      return "Cancelled";
    case "scheduled":
      return `${phoenixTime.format(new Date(g.startsAt))} MST`;
    default:
      return g.status;
  }
}

export interface GameLogEntry {
  gameId: string;
  date: string;
  team: AflTeam | null;
  opponent: AflTeam | null;
  home: boolean;
  /** "W 5–3" / "L 2–4" / "T 3–3", or null when scores are unavailable. */
  result: string | null;
  batting: BattingAggregate | null;
  pitching: PitchingAggregate | null;
}

export interface AflPlayerProfile {
  player: AflPlayer;
  row: AflPlayerRow;
  asOf: string | null;
  windows: Record<
    AflWindow,
    { batting: BattingAggregate | null; pitching: PitchingAggregate | null }
  >;
  gameLog: GameLogEntry[];
  rosterHistory: (AflRosterStint & {
    team: AflTeam | null;
    organization: AflOrganization | null;
  })[];
}

export function playerProfile(
  s: AflSnapshot,
  playerId: string,
): AflPlayerProfile | null {
  const player = s.players.find((p) => p.id === playerId);
  if (!player) return null;
  const windows = Object.fromEntries(
    (["7d", "14d", "30d", "season"] as const).map((w) => {
      const row = buildPlayerRows(s, w).find((r) => r.id === playerId)!;
      return [w, { batting: row.batting, pitching: row.pitching }];
    }),
  ) as AflPlayerProfile["windows"];
  const row = buildPlayerRows(s, "season").find((r) => r.id === playerId)!;
  const teams = byId(s.teams),
    organizations = byId(s.organizations);
  const complete = new Map(completedGames(s).map((g) => [g.id, g]));
  const entries = new Map<
    string,
    { batting?: AflBattingLine; pitching?: AflPitchingLine; teamId: string }
  >();
  for (const line of s.batting)
    if (line.playerId === playerId && complete.has(line.gameId))
      entries.set(line.gameId, {
        ...entries.get(line.gameId),
        batting: line,
        teamId: line.teamId,
      });
  for (const line of s.pitching)
    if (line.playerId === playerId && complete.has(line.gameId))
      entries.set(line.gameId, {
        ...entries.get(line.gameId),
        pitching: line,
        teamId: line.teamId,
      });
  const gameLog = [...entries.entries()]
    .map(([gameId, e]) => {
      const g = complete.get(gameId)!;
      const home = g.homeTeamId === e.teamId;
      const opponentId = home ? g.awayTeamId : g.homeTeamId;
      const own = home ? g.homeScore : g.awayScore,
        opp = home ? g.awayScore : g.homeScore;
      return {
        gameId,
        date: g.date,
        team: teams.get(e.teamId) ?? null,
        opponent: teams.get(opponentId) ?? null,
        home,
        result:
          own === null || opp === null
            ? null
            : `${own > opp ? "W" : own < opp ? "L" : "T"} ${own}–${opp}`,
        batting: e.batting ? aggregateBatting([e.batting]) : null,
        pitching: e.pitching ? aggregatePitching([e.pitching]) : null,
      };
    })
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        complete
          .get(b.gameId)!
          .startsAt.localeCompare(complete.get(a.gameId)!.startsAt),
    );
  const rosterHistory = s.rosterStints
    .filter((r) => r.playerId === playerId)
    .sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt))
    .map((r) => ({
      ...r,
      team: teams.get(r.teamId) ?? null,
      organization: r.organizationId
        ? (organizations.get(r.organizationId) ?? null)
        : null,
    }));
  return { player, row, asOf: aflAsOf(s), windows, gameLog, rosterHistory };
}

/** Teams and organizations that actually have players in the snapshot, for filter menus. */
export function filterOptions(rows: AflPlayerRow[]) {
  const teams = new Map<string, AflTeam>(),
    organizations = new Map<string, AflOrganization>();
  for (const r of rows) {
    if (r.team) teams.set(r.team.id, r.team);
    if (r.organization) organizations.set(r.organization.id, r.organization);
  }
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name);
  return {
    teams: [...teams.values()].sort(byName),
    organizations: [...organizations.values()].sort(byName),
  };
}
