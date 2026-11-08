/**
 * Per-snapshot memoization of the page view models, and the warm-up run on every freshly loaded
 * level before it is served. Cached level snapshots are immutable (the cache replaces them as a
 * whole), so a view model computed once per snapshot object is reused by every request until the
 * level reloads. Formulas are untouched: these call the same functions the pages called before.
 */
import { MOMENTUM_WINDOW_IDS } from "@/analytics/config";
import { analyticsContextFor, comparableCount, mapSets, riserSets } from "@/analytics/views";
import { coverageSummary, latestTopLines, trendingSets } from "@/services/home";
import type { AflSnapshot } from "@/services/afl/types";
import { processWeakMap } from "@/lib/process-memo";

function memoBySnapshot<T>(name: string, compute: (s: AflSnapshot) => T): (s: AflSnapshot) => T {
  const memo = processWeakMap<AflSnapshot, T>(`view.${name}`);
  return (s) => {
    if (memo.has(s)) return memo.get(s)!;
    const value = compute(s);
    memo.set(s, value);
    return value;
  };
}

/** Homepage Trending lists (6 per list), Trends risers/fallers (10), map points, coverage. */
export const homeTrending = memoBySnapshot("home-trending", (s) => trendingSets(s));
export const homeTopLines = memoBySnapshot("home-top-lines", (s) => latestTopLines(s));
export const trendRisers = memoBySnapshot("trend-risers", (s) => riserSets(s));
export const trendMap = memoBySnapshot("trend-map", (s) => mapSets(s));
export const levelCoverageSummary = memoBySnapshot("coverage", (s) => coverageSummary(s));

/**
 * Builds the analytics context and every role × window Momentum result (the expensive, cold part
 * of the Trending, Trends and directory views) for a freshly loaded snapshot. A failure is only
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
