/**
 * Deterministic golden outputs of the Momentum engine (scripts/momentum-golden.test.ts).
 *
 * Builds clearly fictional, deterministic snapshots (no real players, no database) and records
 * every Momentum-derived output the site serves: per-player results for every role × window ×
 * model, timelines, profile views, fingerprints, discovery lists, map points, Trending, Trends
 * view models, directory rows, normalization scales, sample distributions, model comparison, and
 * results under injected settings. Each output is serialized exactly (full floating-point
 * precision; -0, NaN and ±Infinity kept distinct) and hashed, so any change to any value fails the
 * test and names the entry that changed.
 *
 * The golden file is generated ONCE from the unmodified engine and must not be regenerated to make
 * a performance change pass: performance work is required to reproduce it bit for bit.
 */
import { createHash } from "node:crypto";
import type { AflBattingLine, AflGame, AflPitchingLine, AflSnapshot } from "../src/services/afl/types";
import {
  MODEL_IDS,
  MOMENTUM_SETTINGS,
  MOMENTUM_WINDOW_IDS,
  compareModels,
  comparableCount,
  createAnalyticsContext,
  fingerprint,
  mapSets,
  momentum,
  normalizationScales,
  playerAnalyticsView,
  playerRoles,
  playerTimeline,
  qualifiedMomentum,
  riserSets,
  sampleDistribution,
  type MomentumSettings,
  type Role,
} from "../src/analytics";
import { trendingSets } from "../src/services/home";
import { trendMapPoints, trendRiserLists } from "../src/services/competition/prepare";
import { levelDirectoryRows } from "../src/services/players/adapter";
import { STAT_WINDOWS } from "../src/services/players/directory";
import type { LevelId } from "../src/services/players/levels";
import { scaleSnapshot } from "./milb-scale-support";
import { bl, dayDate, pl, syntheticSnapshot, trajectorySnapshot, u, type SyntheticPlayer } from "./analytics-test-support";

const ROLES: Role[] = ["hitter", "pitcher"];

/** Exact serialization: insertion-ordered JSON, plus markers for values JSON would lose. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "number") {
      if (Number.isNaN(v)) return "__NaN__";
      if (v === Infinity) return "__+Infinity__";
      if (v === -Infinity) return "__-Infinity__";
      if (Object.is(v, -0)) return "__-0__";
    }
    if (v instanceof Map) return { __map__: [...v.entries()] };
    if (v instanceof Set) return { __set__: [...v.values()] };
    return v;
  });
}

export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex").slice(0, 24);

/**
 * Edge cases the generators do not produce: two-way player, insufficient recent sample, late
 * debut (no baseline), player who stopped (no recent games), zero-out pitching lines (ERA/WHIP
 * missing → component renormalization), null optional counts, a small population (fallback
 * scales), doubleheaders (two games on one date), and excluded non-final / incomplete games.
 */
export function edgeSnapshot(): AflSnapshot {
  const DAYS = 40;
  const id = (n: number) => u(500 + n);
  const strong = (d: number) => [bl(4, 3, 2, { hr: 1, bb: 1 }), bl(5, 4, 2, { d: 1, k: 1 }), bl(4, 4, 1, { k: 1 })][d % 3];
  const weak = (d: number) => [bl(4, 4, 0, { k: 2 }), bl(4, 3, 1, { bb: 1, k: 1 }), bl(5, 5, 1, { k: 3 })][d % 3];
  const players: SyntheticPlayer[] = [
    { id: id(1), name: "Edge Two Way", batting: (d) => (d < 20 ? weak(d) : strong(d)), pitching: (d) => (d % 5 === 0 ? pl(9, 14, { h: 3, er: d < 20 ? 3 : 1, bb: 2, k: d < 20 ? 3 : 7 }) : null) },
    { id: id(2), name: "Edge Short Recent", batting: (d) => (d <= 30 ? strong(d) : d === 38 ? bl(2, 2, 0, { k: 1 }) : null) },
    { id: id(3), name: "Edge Late Debut", batting: (d) => (d >= 36 ? strong(d) : null) },
    { id: id(4), name: "Edge Stopped", batting: (d) => (d <= 24 ? weak(d) : null) },
    { id: id(5), name: "Edge Zero Outs", pitching: (d) => (d % 4 === 0 ? (d % 8 === 0 ? pl(0, 4, { h: 3, er: 3, bb: 1 }) : pl(6, 9, { h: 2, er: 1, bb: 1, k: 3 })) : null) },
    { id: id(6), name: "Edge Reliever", pitching: (d) => (d % 3 === 1 ? pl(3, 4, { h: d < 20 ? 2 : 0, er: d < 20 ? 1 : 0, k: d < 20 ? 0 : 2 }) : null) },
    { id: id(7), name: "Edge Walker", batting: (d) => bl(4, 2, 0, { bb: 2, k: d % 2 }) },
    {
      id: id(8),
      name: "Edge Null Counts",
      batting: (d) => ({ ...(d < 20 ? weak(d) : strong(d)), runs: null, rbi: d % 2 ? null : 1, caughtStealing: null }),
    },
    { id: id(9), name: "Edge Everyday", batting: (d) => (d < 20 ? strong(d) : weak(d)) },
    { id: id(10), name: "Edge Starter", pitching: (d) => (d % 6 === 0 ? pl(15, 22, { h: 5, er: d < 20 ? 4 : 1, bb: 2, k: d < 20 ? 4 : 8 }) : null) },
  ];
  const s = syntheticSnapshot(players, DAYS, { extraGames: true });
  // Doubleheaders: a second completed game on the same date for some players.
  const extraGames: AflGame[] = [];
  const extraBat: AflBattingLine[] = [];
  const extraPit: AflPitchingLine[] = [];
  const [home, away] = s.teams.map((t) => t.id);
  for (const d of [10, 20, 35, 39]) {
    const gameId = u(1500 + d);
    const date = dayDate(d);
    extraGames.push({ id: gameId, date, startsAt: `${date}T23:05:00.000Z`, status: "final", homeTeamId: home, awayTeamId: away, homeScore: 1, awayScore: 0, venue: "Synthetic Park", boxscoreComplete: true });
    extraBat.push({ ...strong(d + 1), playerId: id(1), gameId, teamId: home }, { ...weak(d + 1), playerId: id(9), gameId, teamId: home });
    extraPit.push({ ...pl(3, 5, { h: 1, bb: 1, k: 2 }), playerId: id(6), gameId, teamId: home });
  }
  return { ...s, games: [...s.games, ...extraGames], batting: [...s.batting, ...extraBat], pitching: [...s.pitching, ...extraPit] };
}

export interface GoldenFixture {
  name: string;
  level: LevelId;
  snapshot: AflSnapshot;
  /** Deterministic subset for the expensive per-player views (timelines, profiles). */
  sample: (ids: string[]) => string[];
}

export function goldenFixtures(): GoldenFixture[] {
  return [
    { name: "milb", level: "aa", snapshot: scaleSnapshot({ ns: 7, level: "aa", teams: 8, days: 90, seed: 11 }), sample: (ids) => ids.filter((_, i) => i % 20 === 0) },
    { name: "afl", level: "afl", snapshot: trajectorySnapshot(), sample: (ids) => ids },
    { name: "edge", level: "afl", snapshot: edgeSnapshot(), sample: (ids) => ids },
    { name: "empty", level: "afl", snapshot: syntheticSnapshot([], 0, { extraGames: false }), sample: (ids) => ids },
  ];
}

const variants: Record<string, MomentumSettings> = {
  "change-sd": { ...MOMENTUM_SETTINGS, normalization: { ...MOMENTUM_SETTINGS.normalization, method: "change-sd" } },
  "no-persistence-floor": { ...MOMENTUM_SETTINGS, persistence: { ...MOMENTUM_SETTINGS.persistence, multiplierFloor: 0 } },
};

/** Every golden entry, keyed `fixture/section/...`. Values are the raw outputs (hashed by the test). */
export function goldenEntries(fixtures: GoldenFixture[] = goldenFixtures()): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const put = (key: string, value: unknown) => {
    if (out.has(key)) throw new Error(`duplicate golden key ${key}`);
    out.set(key, value);
  };
  for (const f of fixtures) {
    const s = f.snapshot;
    const ctx = createAnalyticsContext(s);
    const ids = [...new Set([...ctx.ds.batting.keys(), ...ctx.ds.pitching.keys()])].sort();
    const sample = new Set(f.sample(ids));
    put(`${f.name}/asOf`, { asOf: ctx.ds.asOf, completedDates: ctx.ds.completedDates });

    for (const pid of ids)
      for (const role of playerRoles(ctx.ds, pid))
        for (const w of MOMENTUM_WINDOW_IDS)
          put(`${f.name}/momentum/${pid}/${role}/${w}`, Object.fromEntries(MODEL_IDS.map((m) => [m, momentum(ctx, pid, role, w, m)])));

    for (const pid of ids) {
      if (!sample.has(pid)) continue;
      for (const role of playerRoles(ctx.ds, pid)) {
        for (const w of MOMENTUM_WINDOW_IDS) put(`${f.name}/timeline/${pid}/${role}/${w}`, playerTimeline(ctx, pid, role, w, "balanced"));
        put(`${f.name}/fingerprint/${pid}/${role}`, fingerprint(ctx, pid, role, "14d", "balanced"));
      }
      put(`${f.name}/profile/${pid}`, playerAnalyticsView(s, pid));
    }
    // A player with no lines at all (profile of an unknown id degrades to empty roles).
    put(`${f.name}/profile/unknown`, playerAnalyticsView(s, u(999999)));

    for (const role of ROLES)
      for (const w of MOMENTUM_WINDOW_IDS) {
        put(`${f.name}/comparable/${role}/${w}`, comparableCount(ctx, role, w));
        put(`${f.name}/qualified/${role}/${w}`, qualifiedMomentum(ctx, role, w, "balanced").map((m) => [m.playerId, m.score]));
        put(`${f.name}/distribution/${role}/${w}`, sampleDistribution(ctx, role, w));
        put(`${f.name}/trends-risers/${role}/${w}`, trendRiserLists(s, role, w));
        put(`${f.name}/trends-map/${role}/${w}`, trendMapPoints(s, role, w));
        for (const [name, settings] of Object.entries({ "level-sd": MOMENTUM_SETTINGS, "change-sd": variants["change-sd"] }))
          put(`${f.name}/scales/${role}/${w}/${name}`, normalizationScales(ctx.ds, role, settings, w));
      }
    for (const w of MOMENTUM_WINDOW_IDS) put(`${f.name}/compare-models/${w}`, compareModels(ctx, w));
    put(`${f.name}/riser-sets`, riserSets(s));
    put(`${f.name}/map-sets`, mapSets(s));
    put(`${f.name}/trending`, trendingSets(s));
    for (const sw of STAT_WINDOWS) put(`${f.name}/directory/${sw}`, levelDirectoryRows(s, f.level, sw));

    for (const [vname, settings] of Object.entries(variants)) {
      const vctx = createAnalyticsContext(s, settings);
      for (const pid of ids)
        for (const role of playerRoles(vctx.ds, pid))
          for (const w of MOMENTUM_WINDOW_IDS) put(`${f.name}/variant-${vname}/${pid}/${role}/${w}`, momentum(vctx, pid, role, w, "balanced"));
    }
  }
  return out;
}

/** Entries stored in full (not only hashed) so a failure is readable without rerunning. */
export const EXAMPLE_KEYS = (entries: Map<string, unknown>) =>
  [...entries.keys()].filter(
    (k) =>
      (k.startsWith("edge/momentum/") && k.endsWith("/14d")) ||
      k === "afl/comparable/hitter/14d" ||
      k === "afl/scales/hitter/14d/level-sd" ||
      k === "empty/trending",
  );
