/**
 * Level moves observed in box scores: a player's first game at a MiLB level after already having
 * played at another MiLB level this season. This is evidence of a promotion, demotion or other
 * assignment, NOT an official transaction record (transactions are not ingested): the move date is
 * the first game at the new level, and rehab or short assignments look the same as promotions.
 * The Arizona Fall League is a post-season assignment and is not counted.
 */
import { completedGames } from "@/services/afl/read-model";
import type { AflSnapshot, AflTeam } from "@/services/afl/types";
import { processWeakMap } from "@/lib/process-memo";
import { precomputedPart } from "./views-store";
import { levelOrder, type LevelId } from "@/services/players/levels";
import type { LevelSnapshot } from "./types";

interface Span {
  first: string;
  last: string;
  games: number;
  /** Team of the first game at the level. */
  teamId: string;
}

export interface LevelMove {
  playerId: string;
  name: string;
  from: LevelId;
  to: LevelId;
  /** First game at the new level. */
  date: string;
  /** Up the ladder (e.g. Double-A → Triple-A). */
  up: boolean;
  team: AflTeam | null;
  /** Games at the new level since the move (this season). */
  games: number;
}

interface Stay {
  level: LevelId;
  span: Span;
  snapshot: AflSnapshot;
}

const spanMemo = processWeakMap<AflSnapshot, Map<string, Span>>("level-move-spans");

/** Per player: first/last completed game and games played at this level (memoized per snapshot). */
export function levelSpans(s: AflSnapshot): Map<string, Span> {
  const hit = spanMemo.get(s);
  if (hit) return hit;
  // Precomputed at snapshot build as [playerId, span] entries (views-store.ts), in Map order.
  const pre = precomputedPart<[string, Span][]>(s, "level-move-spans");
  if (pre) {
    const spans = new Map(pre);
    spanMemo.set(s, spans);
    return spans;
  }
  const dates = new Map(completedGames(s).map((g) => [g.id, g.date]));
  const spans = new Map<string, Span>();
  const games = new Map<string, Set<string>>();
  for (const line of [...s.batting, ...s.pitching]) {
    const date = dates.get(line.gameId);
    if (!date) continue;
    const span = spans.get(line.playerId);
    if (!span) spans.set(line.playerId, { first: date, last: date, games: 0, teamId: line.teamId });
    else {
      if (date < span.first || (date === span.first && line.teamId < span.teamId)) {
        span.first = date;
        span.teamId = line.teamId;
      }
      if (date > span.last) span.last = date;
    }
    let ids = games.get(line.playerId);
    if (!ids) games.set(line.playerId, (ids = new Set()));
    ids.add(line.gameId);
  }
  for (const [id, span] of spans) span.games = games.get(id)!.size;
  spanMemo.set(s, spans);
  return spans;
}

/**
 * Most recent observed moves, newest first. With `involving`, only moves into or out of that
 * level. A move is recorded for each level a player reached after first playing elsewhere; the
 * "from" level is the one the player played at most recently before that first game.
 */
export function levelMoves(
  levels: LevelSnapshot[],
  { limit = 10, involving }: { limit?: number; involving?: LevelId } = {},
): LevelMove[] {
  const byPlayer = new Map<string, Stay[]>();
  for (const { level, snapshot } of levels) {
    if (level === "afl") continue;
    for (const [playerId, span] of levelSpans(snapshot)) {
      const list = byPlayer.get(playerId);
      if (list) list.push({ level, span, snapshot });
      else byPlayer.set(playerId, [{ level, span, snapshot }]);
    }
  }
  const moves: { playerId: string; from: LevelId; to: Stay }[] = [];
  for (const [playerId, stays] of byPlayer) {
    if (stays.length < 2) continue;
    for (const to of stays) {
      const before = stays.filter((s) => s !== to && s.span.first < to.span.first);
      if (!before.length) continue;
      // The level played most recently before the move (latest game on or before the move date).
      const lastBefore = (s: Stay) => (s.span.last <= to.span.first ? s.span.last : s.span.first);
      const from = before.reduce((a, b) => (lastBefore(b) > lastBefore(a) ? b : a));
      if (involving && to.level !== involving && from.level !== involving) continue;
      moves.push({ playerId, from: from.level, to });
    }
  }
  // Names and teams are looked up only for the moves shown.
  return moves
    .sort(
      (a, b) =>
        b.to.span.first.localeCompare(a.to.span.first) ||
        levelOrder(a.to.level) - levelOrder(b.to.level) ||
        a.playerId.localeCompare(b.playerId),
    )
    .slice(0, limit)
    .map(({ playerId, from, to }) => ({
      playerId,
      name: to.snapshot.players.find((p) => p.id === playerId)?.name ?? "Unknown player",
      from,
      to: to.level,
      date: to.span.first,
      up: levelOrder(to.level) < levelOrder(from),
      team: to.snapshot.teams.find((t) => t.id === to.span.teamId) ?? null,
      games: to.span.games,
    }));
}
