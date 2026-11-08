/**
 * Compute-time profile of each page's view models over loaded competition levels (ops tooling).
 * Calls the same functions the pages call, in page order, timing the first (cold) and a repeat
 * (warm) call. Pure: no I/O, no formulas.
 */
import { analyticsContextFor, mapSets, playerAnalyticsView, riserSets } from "@/analytics/views";
import { latestTopLines, trendingSets } from "@/services/home";
import { recentPerformers, playerProfile, scoreboard } from "@/services/afl/read-model";
import { directoryRows } from "@/services/players/adapter";
import { directoryOptions } from "@/services/players/directory";
import { levelCoverage, playerLevels, selectLevel } from "./model";
import type { CompetitionDataResult } from "./types";

const ms = (f: () => unknown) => {
  const t = performance.now();
  f();
  return Math.round((performance.now() - t) * 10) / 10;
};

export function profilePages(result: CompetitionDataResult) {
  if (result.status !== "ok") return { status: result.status };
  const out: Record<string, Record<string, unknown>> = {};
  for (const ls of result.levels) {
    const s = ls.snapshot;
    const top = [...s.batting].sort((a, b) => (b.plateAppearances ?? 0) - (a.plateAppearances ?? 0))[0]?.playerId;
    const steps: Record<string, () => unknown> = {
      analyticsContext: () => analyticsContextFor(s),
      "home:trendingSets": () => trendingSets(s),
      "home:latestTopLines": () => latestTopLines(s),
      "home:recentPerformers": () => (["hitters", "pitchers"] as const).map((r) => recentPerformers(s, "7d", r)),
      "strip:scoreboard": () => scoreboard(s),
      "players:directoryRows(level,season,hitter)": () => {
        const rows = directoryRows(result.levels, { level: ls.level, window: "season", role: "hitter" });
        directoryOptions(rows);
      },
      "trends:riserSets": () => riserSets(s),
      "trends:mapSets": () => mapSets(s),
      "profile:playerLevels": () => top && playerLevels(result.levels, top),
      "profile:playerProfile": () => top && playerProfile(s, top),
      "profile:playerAnalyticsView": () => top && playerAnalyticsView(s, top),
    };
    const level: Record<string, unknown> = {
      lines: s.batting.length + s.pitching.length,
      players: s.players.length,
    };
    for (const [name, f] of Object.entries(steps)) level[name] = { coldMs: ms(f), warmMs: ms(f) };
    out[ls.level] = level;
  }
  const all = {
    "players:directoryRows(all,season,hitter)": () => directoryRows(result.levels, { window: "season", role: "hitter" }),
    "data:levelCoverage": () => levelCoverage(result.levels, result.levelStatus),
    "home:selectLevel": () => selectLevel(result.levels, undefined),
  };
  out.allLevels = Object.fromEntries(Object.entries(all).map(([k, f]) => [k, { coldMs: ms(f), warmMs: ms(f) }]));
  return out;
}
