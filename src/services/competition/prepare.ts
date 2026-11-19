/**
 * Per-snapshot memoization of the page view models, and the warm-up (`prepareSnapshot`) that fills
 * those memos early. Database mode runs the warm-up on every freshly loaded level before it is
 * served; snapshot mode skips it and lets the first request that needs a level compute it
 * (src/services/competition/source-cache.ts). The memos make the results identical either way. Cached level snapshots are immutable (the cache replaces them as a
 * whole), so a view model computed once per snapshot object is reused by every request until the
 * level reloads. Formulas are untouched: these call the same functions the pages called before.
 */
import { MOMENTUM_WINDOW_IDS, type MomentumWindow, type Role } from "@/analytics/config";
import { mapPointsView, riserListsView, type MapPointCompact } from "@/analytics/trend-views";
import { analyticsContextFor, comparableCount, mapSets, riserSets } from "@/analytics/views";
import { coverageSummary, latestTopLines, trendingSets } from "@/services/home";
import type { AflSnapshot } from "@/services/afl/types";
import { processWeakMap } from "@/lib/process-memo";
import { precomputedPart } from "./views-store";

/**
 * `part`: the precomputed view model (views-store.ts) that fills this memo on a miss when the
 * snapshot has one; otherwise, or when it fails a check, the value is computed live as before.
 */
function memoBySnapshot<T>(
  name: string,
  compute: (s: AflSnapshot) => T,
  part: (s: AflSnapshot) => T | undefined = (s) => precomputedPart<T>(s, name),
): (s: AflSnapshot) => T {
  const memo = processWeakMap<AflSnapshot, T>(`view.${name}`);
  return (s) => {
    if (memo.has(s)) return memo.get(s)!;
    const value = part(s) ?? compute(s);
    memo.set(s, value);
    return value;
  };
}

/** Never precomputed (intermediate results of the precomputed views). */
const live = () => undefined;

/** Homepage Trending lists (6 per list), Trends risers/fallers (10), map points, coverage. */
export const homeTrending = memoBySnapshot("home-trending", (s) => trendingSets(s));
export const homeTopLines = memoBySnapshot("home-top-lines", (s) => latestTopLines(s));
export const trendRisers = memoBySnapshot("trend-risers", (s) => riserSets(s), live);
export const trendMap = memoBySnapshot("trend-map", (s) => mapSets(s), live);
/** Players with a valid comparison per role × window (0 = window unavailable). */
export const trendComparable = memoBySnapshot("trend-comparable", (s) => trendRisers(s).comparable);
/**
 * Display-ready Trends models (what the client components receive). Precomputed as its `lists`
 * only: its `comparable` is the same object as `trendComparable`'s, live and precomputed alike.
 */
const trendRiserView = memoBySnapshot(
  "trend-riser-view",
  (s) => riserListsView(trendRisers(s)),
  (s) => {
    const lists = precomputedPart<ReturnType<typeof riserListsView>["lists"]>(s, "trend-riser-lists");
    return lists && { lists, comparable: trendComparable(s) };
  },
);
/** Every role × window of the display-ready riser lists (what the views build precomputes). */
export const trendRiserListsAll = (s: AflSnapshot) => trendRiserView(s).lists;
/** Risers / fallers for every category of one role × window. */
export const trendRiserLists = (s: AflSnapshot, role: Role, window: MomentumWindow) =>
  trendRiserView(s).lists[role][window];
const mapPointMemo = memoBySnapshot("trend-map-points", () => new Map<string, MapPointCompact[]>(), live);
export function trendMapPoints(s: AflSnapshot, role: Role, window: MomentumWindow) {
  const memo = mapPointMemo(s);
  const key = `${role}|${window}`;
  let points = memo.get(key);
  if (!points)
    memo.set(key, (points = precomputedPart<MapPointCompact[]>(s, `trend-map-points|${key}`) ?? mapPointsView(trendMap(s), role, window)));
  return points;
}
export const levelCoverageSummary = memoBySnapshot("coverage", (s) => coverageSummary(s));

/**
 * Builds the analytics context and every role × window Momentum result (the expensive, cold part
 * of the Trending, Trends and directory views) for a freshly loaded snapshot (database mode only;
 * see source-cache.ts). A failure is only
 * logged: the level's data is still served, and the page that needs the view reports the error.
 */
export function prepareSnapshot(s: AflSnapshot) {
  try {
    const ctx = analyticsContextFor(s);
    for (const role of ["hitter", "pitcher"] as const)
      for (const w of MOMENTUM_WINDOW_IDS) comparableCount(ctx, role, w);
    homeTrending(s);
  } catch (error) {
    console.error(`[competition-data] warm-up compute failed (${error instanceof Error ? error.name : "unknown"})`);
  }
}
