/**
 * Homepage view models built from the real AFL snapshot. Pure and serializable: no I/O, no new
 * formulas. Trending lists are the V1 Momentum risers/fallers; "top lines" is a descriptive sort
 * of single-game box-score lines, not a rating.
 */
import {
  DEFAULT_MOMENTUM_MODEL,
  MOMENTUM_WINDOW_IDS,
  type MomentumWindow,
  type Role,
} from "@/analytics/config";
import { risersAndFallers, type RankedEntry } from "@/analytics/engine";
import { analyticsContextFor, comparableCount } from "@/analytics/views";
import { formatMetric, metricDefinition } from "@/analytics/metrics";
import {
  aflAsOf,
  buildPlayerRows,
  completedGames,
  formatFixed,
  formatRate,
  inningsFromOuts,
  slashLine,
  type AflPlayerRow,
} from "@/services/afl/read-model";
import type { AflSnapshot } from "@/services/afl/types";

export interface TrendingEntry {
  playerId: string;
  name: string;
  position: string;
  team: { id: string; abbreviation: string; name: string } | null;
  organization: { id: string; abbreviation: string; name: string } | null;
  score: number;
  confidence: RankedEntry["confidence"];
  persistenceLabel: string;
  trendLengthDays: number;
  /** e.g. "OPS .612 → .948". */
  keyChange: string;
  /** Raw production in the Momentum window, e.g. ".333/.410/.600 · 3 HR · 39 PA". */
  recentLine: string;
  sample: RankedEntry["sample"];
}

export interface TrendingSets {
  asOf: string | null;
  lists: Record<
    Role,
    Record<
      MomentumWindow,
      { risers: TrendingEntry[]; fallers: TrendingEntry[] }
    >
  >;
  comparable: Record<Role, Record<MomentumWindow, number>>;
}

function recentLine(row: AflPlayerRow | undefined, role: Role): string {
  if (role === "hitter") {
    const b = row?.batting;
    if (!b) return "No plate appearances in window";
    const hr = b.homeRuns ? ` · ${b.homeRuns} HR` : "";
    const sb = b.stolenBases ? ` · ${b.stolenBases} SB` : "";
    return `${slashLine(b)}${hr}${sb} · ${b.plateAppearances} PA`;
  }
  const p = row?.pitching;
  if (!p) return "No batters faced in window";
  return `${inningsFromOuts(p.outsRecorded)} IP · ${formatFixed(p.era, 2)} ERA · ${p.strikeouts} K / ${p.walks} BB`;
}

export function trendingSets(snapshot: AflSnapshot, limit = 6): TrendingSets {
  const ctx = analyticsContextFor(snapshot);
  const rowsByWindow = Object.fromEntries(
    MOMENTUM_WINDOW_IDS.map((w) => [
      w,
      new Map(buildPlayerRows(snapshot, w).map((r) => [r.id, r])),
    ]),
  ) as Record<MomentumWindow, Map<string, AflPlayerRow>>;
  const toEntry =
    (role: Role, w: MomentumWindow) =>
    (e: RankedEntry): TrendingEntry => ({
      playerId: e.playerId,
      name: e.name,
      position: e.position,
      team: e.team,
      organization: e.organization,
      score: e.score,
      confidence: e.confidence,
      persistenceLabel: e.persistenceLabel,
      trendLengthDays: e.trendLengthDays,
      keyChange: `${metricDefinition(e.keyMetric).label} ${formatMetric(e.keyMetric, e.keyBefore)} → ${formatMetric(e.keyMetric, e.keyNow)}`,
      recentLine: recentLine(rowsByWindow[w].get(e.playerId), role),
      sample: e.sample,
    });
  const lists = { hitter: {}, pitcher: {} } as TrendingSets["lists"];
  const comparable = { hitter: {}, pitcher: {} } as TrendingSets["comparable"];
  for (const role of ["hitter", "pitcher"] as const)
    for (const w of MOMENTUM_WINDOW_IDS) {
      const { risers, fallers } = risersAndFallers(
        ctx,
        role,
        w,
        DEFAULT_MOMENTUM_MODEL,
        "overall",
        limit,
      );
      lists[role][w] = {
        risers: risers.map(toEntry(role, w)),
        fallers: fallers.map(toEntry(role, w)),
      };
      comparable[role][w] = comparableCount(ctx, role, w);
    }
  return { asOf: ctx.ds.asOf, lists, comparable };
}

export interface TopLine {
  playerId: string;
  name: string;
  team: { id: string; abbreviation: string; name: string } | null;
  opponent: { id: string; abbreviation: string; name: string } | null;
  /** Compact box-score line, e.g. "3-4, 2B, HR, 3 RBI, BB". */
  line: string;
}

/**
 * Notable single-game lines from the latest completed game date. Hitters are ordered by total
 * bases, then hits; pitchers by strikeouts, then outs recorded. A descriptive sort, not a rating.
 */
export function latestTopLines(
  snapshot: AflSnapshot,
  limit = 5,
): { date: string | null; hitters: TopLine[]; pitchers: TopLine[] } {
  const date = aflAsOf(snapshot);
  if (!date) return { date: null, hitters: [], pitchers: [] };
  const games = new Map(
    completedGames(snapshot)
      .filter((g) => g.date === date)
      .map((g) => [g.id, g]),
  );
  const players = new Map(snapshot.players.map((p) => [p.id, p]));
  const teams = new Map(snapshot.teams.map((t) => [t.id, t]));
  const opponentOf = (gameId: string, teamId: string) => {
    const g = games.get(gameId)!;
    return (
      teams.get(g.homeTeamId === teamId ? g.awayTeamId : g.homeTeamId) ?? null
    );
  };
  const hitters = snapshot.batting
    .filter((l) => games.has(l.gameId) && l.plateAppearances > 0)
    .map((l) => {
      const tb = l.hits + l.doubles + 2 * l.triples + 3 * l.homeRuns;
      return { l, tb };
    })
    .sort(
      (a, b) =>
        b.tb - a.tb ||
        b.l.hits - a.l.hits ||
        (b.l.rbi ?? 0) - (a.l.rbi ?? 0) ||
        a.l.playerId.localeCompare(b.l.playerId),
    )
    .slice(0, limit)
    .map(({ l }) => {
      const parts = [`${l.hits}-${l.atBats}`];
      const xbh = (n: number, label: string) =>
        n ? parts.push(n > 1 ? `${n} ${label}` : label) : 0;
      xbh(l.doubles, "2B");
      xbh(l.triples, "3B");
      xbh(l.homeRuns, "HR");
      if (l.rbi) parts.push(`${l.rbi} RBI`);
      if (l.walks) parts.push(l.walks > 1 ? `${l.walks} BB` : "BB");
      if (l.stolenBases)
        parts.push(l.stolenBases > 1 ? `${l.stolenBases} SB` : "SB");
      return {
        playerId: l.playerId,
        name: players.get(l.playerId)?.name ?? "Unknown player",
        team: teams.get(l.teamId) ?? null,
        opponent: opponentOf(l.gameId, l.teamId),
        line: parts.join(", "),
      };
    });
  const pitchers = snapshot.pitching
    .filter((l) => games.has(l.gameId) && l.outsRecorded > 0)
    .sort(
      (a, b) =>
        b.strikeouts - a.strikeouts ||
        b.outsRecorded - a.outsRecorded ||
        a.earnedRuns - b.earnedRuns ||
        a.playerId.localeCompare(b.playerId),
    )
    .slice(0, limit)
    .map((l) => ({
      playerId: l.playerId,
      name: players.get(l.playerId)?.name ?? "Unknown player",
      team: teams.get(l.teamId) ?? null,
      opponent: opponentOf(l.gameId, l.teamId),
      line: `${inningsFromOuts(l.outsRecorded)} IP, ${l.hitsAllowed} H, ${l.earnedRuns} ER, ${l.walks} BB, ${l.strikeouts} K`,
    }));
  return { date, hitters, pitchers };
}

export interface CoverageSummary {
  league: string;
  season: string;
  asOf: string | null;
  lastIngestedAt: string | null;
  teams: number;
  players: number;
  hitters: number;
  pitchers: number;
  gamesFinal: number;
  gamesScheduled: number;
  gamesOther: number;
  /** Season league-wide batting line from summed counts. */
  leagueOps: string;
}

export function coverageSummary(snapshot: AflSnapshot): CoverageSummary {
  const final = completedGames(snapshot);
  const finalIds = new Set(final.map((g) => g.id));
  const scheduled = snapshot.games.filter(
    (g) => g.status === "scheduled",
  ).length;
  const rows = buildPlayerRows(snapshot, "season");
  const hitterIds = new Set(
    snapshot.batting
      .filter((l) => finalIds.has(l.gameId))
      .map((l) => l.playerId),
  );
  const pitcherIds = new Set(
    snapshot.pitching
      .filter((l) => finalIds.has(l.gameId))
      .map((l) => l.playerId),
  );
  let obpNum = 0,
    obpDen = 0,
    tb = 0,
    ab = 0;
  for (const r of rows) {
    const b = r.batting;
    if (!b) continue;
    obpNum += b.hits + b.walks + b.hitByPitch;
    obpDen += b.atBats + b.walks + b.hitByPitch + b.sacrificeFlies;
    tb += b.hits + b.doubles + 2 * b.triples + 3 * b.homeRuns;
    ab += b.atBats;
  }
  return {
    league: snapshot.league.name,
    season: snapshot.season.name,
    asOf: aflAsOf(snapshot),
    lastIngestedAt: snapshot.lastIngestedAt,
    teams: snapshot.teams.length,
    players: snapshot.players.length,
    hitters: hitterIds.size,
    pitchers: pitcherIds.size,
    gamesFinal: final.length,
    gamesScheduled: scheduled,
    gamesOther: snapshot.games.length - final.length - scheduled,
    leagueOps:
      obpDen && ab ? formatRate(obpNum / obpDen + tb / ab) : formatRate(null),
  };
}
