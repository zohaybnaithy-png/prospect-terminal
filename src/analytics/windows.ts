/**
 * Comparison windows over the AFL read model.
 *
 * Reuses the read model's completed-game rule (final + complete box score) and the shared
 * statistics aggregation/window bounds; this module only adds "recent vs. before" pairing and an
 * index of each player's dated game lines so many windows can be evaluated cheaply.
 */
import {
  aggregateBatting,
  aggregatePitching,
  windowBounds,
} from "@/statistics/aggregate";
import { aflAsOf, completedGames } from "@/services/afl/read-model";
import type {
  AflBattingLine,
  AflPitchingLine,
  AflSnapshot,
} from "@/services/afl/types";
import type { MomentumWindow, Role } from "./config";
import type { HitterSample, PitcherSample } from "./metrics";
import { addDays } from "./stats";

export interface DateRange {
  from: string;
  to: string;
}
export interface DatedLine<T> {
  date: string;
  line: T;
}

export interface AnalyticsDataset {
  snapshot: AflSnapshot;
  seasonYear: number;
  leagueId: string;
  /** Latest completed game date (statistics are "as of" this, never the wall clock). */
  asOf: string | null;
  /** Sorted distinct official dates with at least one completed game. */
  completedDates: string[];
  batting: Map<string, DatedLine<AflBattingLine>[]>;
  pitching: Map<string, DatedLine<AflPitchingLine>[]>;
}

/**
 * Per-player line lists whose dates were verified to be in ascending order under plain string
 * comparison (the comparison `linesInRange` filters with). Only these may be binary-searched.
 */
const ordered = new WeakSet<object>();

function index<T extends { playerId: string; gameId: string }>(
  lines: T[],
  dates: Map<string, string>,
) {
  const out = new Map<string, DatedLine<T>[]>();
  for (const line of lines) {
    const date = dates.get(line.gameId);
    if (!date) continue; // not a completed game: excluded, like every AFL read-model window
    const list = out.get(line.playerId);
    if (list) list.push({ date, line });
    else out.set(line.playerId, [{ date, line }]);
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    // ISO dates sort the same under localeCompare and plain comparison; verify rather than assume.
    let sorted = true;
    for (let i = 1; i < list.length && sorted; i++) sorted = list[i - 1].date <= list[i].date;
    if (sorted) ordered.add(list);
  }
  return out;
}

export function buildDataset(snapshot: AflSnapshot): AnalyticsDataset {
  const completed = completedGames(snapshot);
  const dates = new Map(completed.map((g) => [g.id, g.date]));
  const asOf = aflAsOf(snapshot);
  return {
    snapshot,
    seasonYear: snapshot.season.year,
    leagueId: snapshot.league.id,
    // An as-of date outside the season year has no valid windows (same rule as aflWindowBounds).
    asOf: asOf && Number(asOf.slice(0, 4)) === snapshot.season.year ? asOf : null,
    completedDates: [...new Set(completed.map((g) => g.date))].sort(),
    batting: index(snapshot.batting, dates),
    pitching: index(snapshot.pitching, dates),
  };
}

export interface ComparisonRanges {
  /** The recent window: the same inclusive bounds the read model uses for 7d/14d/30d. */
  recent: DateRange;
  /** Everything in the season before the recent window; null when the window starts the season. */
  baseline: DateRange | null;
}

/**
 * Memo for `comparisonRanges`, scoped to each dataset object (a WeakMap, so it is freed with the
 * snapshot's analytics context). The ranges depend only on the season, league, end date and window,
 * but `windowBounds` validates every input on every call, and Momentum asks for the same few
 * ranges once per player, checkpoint and window. Only successful results are cached (invalid input
 * still throws), and every call returns fresh objects, so no caller shares or can mutate a cached
 * value and serialized outputs are unchanged.
 */
const rangeMemo = new WeakMap<object, Map<string, ComparisonRanges>>();

/** "What changed in the last N days compared with everything before?" as date ranges. */
export function comparisonRanges(
  ds: Pick<AnalyticsDataset, "seasonYear" | "leagueId">,
  end: string,
  window: MomentumWindow,
): ComparisonRanges {
  let memo = rangeMemo.get(ds);
  if (!memo) rangeMemo.set(ds, (memo = new Map()));
  const key = `${ds.seasonYear}|${ds.leagueId}|${end}|${window}`;
  let ranges = memo.get(key);
  if (!ranges) memo.set(key, (ranges = computeComparisonRanges(ds, end, window)));
  return {
    recent: { ...ranges.recent },
    baseline: ranges.baseline ? { ...ranges.baseline } : null,
  };
}

function computeComparisonRanges(
  ds: Pick<AnalyticsDataset, "seasonYear" | "leagueId">,
  end: string,
  window: MomentumWindow,
): ComparisonRanges {
  const recent = windowBounds({
    season: ds.seasonYear,
    asOf: end,
    window,
    leagueId: ds.leagueId,
  });
  const seasonStart = `${ds.seasonYear}-01-01`;
  const baselineTo = addDays(recent.from, -1);
  return {
    recent,
    baseline:
      baselineTo >= seasonStart ? { from: seasonStart, to: baselineTo } : null,
  };
}

/** First index whose date satisfies `pred` (monotone over an ordered list), else `lines.length`. */
function firstIndex<T>(lines: DatedLine<T>[], pred: (date: string) => boolean) {
  let lo = 0,
    hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(lines[mid].date)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The lines dated within `r` (inclusive), in list order. On a verified date-ordered list (see
 * `index`) the matching lines are one contiguous run, found by binary search: exactly the lines,
 * in exactly the order, that the linear filter selects. Any other list is filtered linearly.
 */
export function linesInRange<T>(lines: DatedLine<T>[] | undefined, r: DateRange) {
  if (!lines) return [];
  if (!ordered.has(lines))
    return lines.filter((l) => l.date >= r.from && l.date <= r.to).map((l) => l.line);
  const end = firstIndex(lines, (d) => d > r.to);
  const out: T[] = [];
  for (let i = firstIndex(lines, (d) => d >= r.from); i < end; i++) out.push(lines[i].line);
  return out;
}

/** Aggregated sample for a role and range; null when the player has no lines in it. */
export function sampleInRange(
  ds: AnalyticsDataset,
  role: Role,
  playerId: string,
  range: DateRange | null,
): HitterSample | PitcherSample | null {
  if (!range) return null;
  if (role === "hitter") {
    const lines = linesInRange(ds.batting.get(playerId), range);
    return lines.length ? aggregateBatting(lines) : null;
  }
  const lines = linesInRange(ds.pitching.get(playerId), range);
  return lines.length ? aggregatePitching(lines) : null;
}

/** Full-season sample through as-of. */
export function seasonSample(ds: AnalyticsDataset, role: Role, playerId: string) {
  if (!ds.asOf) return null;
  return sampleInRange(ds, role, playerId, {
    from: `${ds.seasonYear}-01-01`,
    to: ds.asOf,
  });
}

/** Roles a player has completed-game lines for (two-way players have both). */
export function playerRoles(ds: AnalyticsDataset, playerId: string): Role[] {
  const roles: Role[] = [];
  if (ds.batting.get(playerId)?.length) roles.push("hitter");
  if (ds.pitching.get(playerId)?.length) roles.push("pitcher");
  return roles;
}
