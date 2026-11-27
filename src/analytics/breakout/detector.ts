/**
 * Breakout detector (docs/BREAKOUT-METHOD.md §4, approved D-021). Pure and deterministic (seeded RNG).
 *
 * Used only by the offline validation (T-405); nothing here is rendered on the site.
 * Per level and role: every number comes from one level's completed games (read-model rule), never pooled
 * across levels.
 */
import { buildDataset } from "@/analytics/windows";
import type { AflBattingLine, AflPitchingLine, AflSnapshot } from "@/services/afl/types";
import { BREAKOUT_METRICS, BREAKOUT_SETTINGS, type BreakoutMetricDef, type BreakoutRole, type BreakoutSettings } from "./config";

/** Minimum qualified players at a level/role/date for any flag (level SDs and percentiles need a population). */
export const MIN_BREAKOUT_POPULATION = 20;

/** One player's season at one level, games in date order. */
export interface PlayerSeries {
  id: string;
  dates: string[];
  /** Opportunities per game: PA (hitters) / BF (pitchers). */
  opp: number[];
  /** num[m][g], den[m][g] for metric m (den = opp for binomial metrics). */
  num: number[][];
  den: number[][];
  /** Results counts for the naive baselines: hitters [H, BB, HBP, AB, SF, TB], pitchers [ER, outs]. */
  res: number[][];
}

export interface RoleData {
  role: BreakoutRole;
  metrics: BreakoutMetricDef[];
  players: PlayerSeries[];
  /** Sorted distinct completed-game dates at the level. */
  dates: string[];
}

// ---------- data ----------

export function roleDataFromSnapshot(snapshot: AflSnapshot, role: BreakoutRole): RoleData {
  const ds = buildDataset(snapshot);
  const metrics = BREAKOUT_METRICS[role];
  const players: PlayerSeries[] = [];
  const source = role === "hitter" ? ds.batting : ds.pitching;
  for (const [id, lines] of source) {
    const s: PlayerSeries = { id, dates: [], opp: [], num: metrics.map(() => []), den: metrics.map(() => []), res: [] };
    for (const { date, line } of lines) {
      if (role === "hitter") {
        const l = line as AflBattingLine;
        if (!(l.plateAppearances > 0)) continue;
        const xb = l.doubles + 2 * l.triples + 3 * l.homeRuns;
        const tb = l.hits + xb;
        s.dates.push(date);
        s.opp.push(l.plateAppearances);
        s.num[0].push(l.strikeouts); s.den[0].push(l.plateAppearances);
        s.num[1].push(l.walks); s.den[1].push(l.plateAppearances);
        s.num[2].push(xb); s.den[2].push(l.atBats);
        s.res.push([l.hits, l.walks, l.hitByPitch, l.atBats, l.sacrificeFlies, tb]);
      } else {
        const l = line as AflPitchingLine;
        if (!(l.battersFaced > 0)) continue;
        s.dates.push(date);
        s.opp.push(l.battersFaced);
        s.num[0].push(l.strikeouts); s.den[0].push(l.battersFaced);
        s.num[1].push(l.walks); s.den[1].push(l.battersFaced);
        s.res.push([l.earnedRuns, l.outsRecorded]);
      }
    }
    if (s.dates.length) players.push(s);
  }
  players.sort((a, b) => a.id.localeCompare(b.id));
  return { role, metrics, players, dates: ds.completedDates };
}

/** Number of games on or before `date` (dates are sorted ISO strings). */
export function gamesThrough(dates: string[], date: string) {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------- RNG ----------

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function permutation(n: number, rand: () => number) {
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

/** The player's series with the order of games on or before `through` shuffled (dates stay in place). */
export function shuffledSeries(s: PlayerSeries, through: string, rand: () => number): PlayerSeries {
  const n = gamesThrough(s.dates, through);
  const p = permutation(n, rand);
  const pick = <T>(xs: T[]) => xs.map((x, i) => (i < n ? xs[p[i]] : x));
  return { id: s.id, dates: s.dates, opp: pick(s.opp), num: s.num.map(pick), den: s.den.map(pick), res: pick(s.res) };
}

export function shuffledRoleData(d: RoleData, through: string, rand: () => number): RoleData {
  return { ...d, players: d.players.map((s) => shuffledSeries(s, through, rand)) };
}

// ---------- blocks and per-metric statistics ----------

export interface Blocks {
  /** Games [0, rStart) are the earlier block, [rStart, end) the recent block. */
  rStart: number;
  end: number;
  nRecent: number;
  nEarlier: number;
}

/** §4.1: whole games from the end until the recent block has ≥ nRecent; the rest must reach nEarlier. */
export function blocks(s: PlayerSeries, end: number, settings: BreakoutSettings): Blocks | null {
  let nRecent = 0;
  let i = end;
  while (i > 0 && nRecent < settings.nRecent) nRecent += s.opp[--i];
  if (nRecent < settings.nRecent) return null;
  let nEarlier = 0;
  for (let g = 0; g < i; g++) nEarlier += s.opp[g];
  if (nEarlier < settings.nEarlier) return null;
  return { rStart: i, end, nRecent, nEarlier };
}

export interface BlockSums {
  x: number;
  a: number;
  /** For the ratio variance: Σx², Σxa, Σa², games. */
  xx: number;
  xa: number;
  aa: number;
  m: number;
}

export function sums(num: number[], den: number[], from: number, to: number): BlockSums {
  const out = { x: 0, a: 0, xx: 0, xa: 0, aa: 0, m: 0 };
  for (let g = from; g < to; g++) {
    const x = num[g];
    const a = den[g];
    out.x += x; out.a += a; out.xx += x * x; out.xa += x * a; out.aa += a * a; out.m += 1;
  }
  return out;
}

export const shrink = (x: number, n: number, mu: number, k: number) => (x + k * mu) / (n + k);

/** Linearized (cluster-by-game) variance of a ratio Σx/Σa; null below 2 games or with Σa = 0. */
export function ratioVariance(b: BlockSums) {
  if (b.a <= 0 || b.m < 2) return null;
  const r = b.x / b.a;
  const ss = b.xx - 2 * r * b.xa + r * r * b.aa;
  return ((b.m / (b.m - 1)) * Math.max(0, ss)) / (b.a * b.a);
}

/**
 * Per-metric standardized change: direction · (shrunk recent − shrunk earlier) / SE.
 * SE: pooled two-proportion (binomial metrics); linearized game-cluster ratio SE (ISO). §4.3.
 */
export function metricZ(
  def: BreakoutMetricDef,
  r: BlockSums,
  e: BlockSums,
  mu: number,
  k: number,
  statistic: BreakoutSettings["statistic"] = "shrunk-over-raw-se",
) {
  const shR = shrink(r.x, r.a, mu, k);
  const shE = shrink(e.x, e.a, mu, k);
  let se: number | null;
  if (def.kind === "binomial") {
    const p = (r.x + e.x) / (r.a + e.a);
    se = r.a > 0 && e.a > 0 ? Math.sqrt(p * (1 - p) * (1 / r.a + 1 / e.a)) : null;
  } else {
    const vr = ratioVariance(r);
    const ve = ratioVariance(e);
    se = vr === null || ve === null ? null : Math.sqrt(vr + ve);
  }
  const rawR = r.a > 0 ? r.x / r.a : null;
  const rawE = e.a > 0 ? e.x / e.a : null;
  const change = statistic === "raw" ? (rawR ?? 0) - (rawE ?? 0) : shR - shE;
  const z = se && se > 0 ? (def.direction * change) / se : 0;
  return { z, shR, shE, rawR, rawE };
}

// ---------- level model (per date) ----------

export interface LevelModel {
  /** Metrics in use at this level (dropped by §6.1 reliability) and their equal weights. */
  metricIdx: number[];
  weights: number[];
  /** Shrinkage constants per metric (indexed like RoleData.metrics). */
  k: number[];
}

export function compositeZ(zs: number[], weights: number[]) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < zs.length; i++) {
    num += weights[i] * zs[i];
    den += weights[i] * weights[i];
  }
  return den > 0 ? num / Math.sqrt(den) : 0;
}

export function levelMeans(d: RoleData, through: string) {
  const x = d.metrics.map(() => 0);
  const a = d.metrics.map(() => 0);
  for (const s of d.players) {
    const n = gamesThrough(s.dates, through);
    for (let m = 0; m < d.metrics.length; m++)
      for (let g = 0; g < n; g++) {
        x[m] += s.num[m][g];
        a[m] += s.den[m][g];
      }
  }
  return x.map((v, m) => (a[m] > 0 ? v / a[m] : 0));
}

/** The composite z of one player's blocks (used for the real value and for every permutation). */
export function playerCompositeZ(
  s: PlayerSeries,
  b: Blocks,
  d: RoleData,
  model: LevelModel,
  mu: number[],
  statistic: BreakoutSettings["statistic"] = "shrunk-over-raw-se",
) {
  const zs = model.metricIdx.map((m) =>
    metricZ(d.metrics[m], sums(s.num[m], s.den[m], b.rStart, b.end), sums(s.num[m], s.den[m], 0, b.rStart), mu[m], model.k[m], statistic).z,
  );
  return compositeZ(zs, model.weights);
}

export interface PlayerEval {
  id: string;
  blocks: Blocks;
  z: number;
  p: number | null;
  /** Composite effect (level SDs) and recent-block standing (level SDs above the level mean). */
  effect: number;
  standing: number;
  /** Earlier-block composite (level SDs), for matched controls. */
  earlier: number;
  standingPct: number;
  bh: boolean;
  /** Criteria 1–3 (§4.4). */
  crit: boolean;
  /** Watch base: criteria 2–3 and p ≤ watchP before false-discovery control. */
  watchBase: boolean;
  metrics: { id: string; label: string; rawR: number | null; rawE: number | null; shR: number; shE: number }[];
}

export interface LevelState {
  date: string;
  mu: number[];
  sd: number[];
  qualified: number;
  players: Map<string, PlayerEval>;
}

/** Benjamini–Hochberg: the set of indexes whose p-values pass at level q. */
export function benjaminiHochberg(ps: number[], q: number) {
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  let cut = -1;
  for (let i = 0; i < order.length; i++) if (order[i][0] <= ((i + 1) / order.length) * q) cut = i;
  return new Set(order.slice(0, cut + 1).map(([, i]) => i));
}

/** Upper-tail empirical p-value with the +1 correction; nullSorted ascending. */
export function empiricalP(z: number, nullSorted: Float64Array) {
  const below = countBelow(nullSorted, z);
  return (1 + (nullSorted.length - below)) / (1 + nullSorted.length);
}

/** Count of values < z in an ascending array. */
function countBelow(xs: Float64Array, z: number) {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < z) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const sdOf = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
};

/**
 * All players' evaluations at one date (criteria 1–3). `nullSorted` supplies p-values; without it p is null and
 * no player can pass criterion 1.
 */
export function levelState(
  d: RoleData,
  date: string,
  model: LevelModel,
  nullSorted: Float64Array | null,
  settings: BreakoutSettings = BREAKOUT_SETTINGS,
): LevelState {
  const mu = levelMeans(d, date);
  const rows: { s: PlayerSeries; b: Blocks; r: BlockSums[]; e: BlockSums[] }[] = [];
  for (const s of d.players) {
    const end = gamesThrough(s.dates, date);
    const b = blocks(s, end, settings);
    if (!b) continue;
    rows.push({
      s,
      b,
      r: d.metrics.map((_, m) => sums(s.num[m], s.den[m], b.rStart, b.end)),
      e: d.metrics.map((_, m) => sums(s.num[m], s.den[m], 0, b.rStart)),
    });
  }
  const sd = d.metrics.map((_, m) =>
    sdOf(rows.map(({ r, e }) => shrink(r[m].x + e[m].x, r[m].a + e[m].a, mu[m], model.k[m]))),
  );
  const state: LevelState = { date, mu, sd, qualified: rows.length, players: new Map() };
  if (rows.length < MIN_BREAKOUT_POPULATION) return state;
  const evals: PlayerEval[] = rows.map(({ s, b, r, e }) => {
    let effect = 0;
    let standing = 0;
    let earlier = 0;
    const zs: number[] = [];
    const metrics: PlayerEval["metrics"] = [];
    model.metricIdx.forEach((m, i) => {
      const def = d.metrics[m];
      const mz = metricZ(def, r[m], e[m], mu[m], model.k[m], settings.statistic);
      zs.push(mz.z);
      const w = model.weights[i];
      const scale = sd[m] > 0 ? sd[m] : Infinity;
      effect += (w * def.direction * (mz.shR - mz.shE)) / scale;
      standing += (w * def.direction * (mz.shR - mu[m])) / scale;
      earlier += (w * def.direction * (mz.shE - mu[m])) / scale;
      metrics.push({ id: def.id, label: def.label, rawR: mz.rawR, rawE: mz.rawE, shR: mz.shR, shE: mz.shE });
    });
    const z = compositeZ(zs, model.weights);
    return {
      id: s.id, blocks: b, z, p: nullSorted ? empiricalP(z, nullSorted) : null,
      effect, standing, earlier, standingPct: 0, bh: false, crit: false, watchBase: false, metrics,
    };
  });
  const sortedStanding = Float64Array.from(evals.map((x) => x.standing)).sort();
  for (const x of evals) x.standingPct = countBelow(sortedStanding, x.standing + 1e-12) / evals.length;
  if (nullSorted) {
    const pass = benjaminiHochberg(evals.map((x) => x.p as number), settings.fdrQ);
    evals.forEach((x, i) => (x.bh = pass.has(i)));
  }
  for (const x of evals) {
    const size = x.effect >= settings.minEffect && x.standingPct >= settings.standingPercentile;
    x.crit = x.bh && size;
    x.watchBase = size && x.p !== null && x.p <= settings.watchP;
    state.players.set(x.id, x);
  }
  return state;
}

/** §6.2 pooled null: each qualified player's games on or before `date` shuffled `perPlayer` times. */
export function nullPool(
  d: RoleData,
  date: string,
  model: LevelModel,
  rand: () => number,
  settings: BreakoutSettings = BREAKOUT_SETTINGS,
) {
  const mu = levelMeans(d, date);
  const out: number[] = [];
  for (const s of d.players) {
    const end = gamesThrough(s.dates, date);
    if (!blocks(s, end, settings)) continue;
    for (let k = 0; k < settings.nullShufflesPerPlayer; k++) {
      const sh = shuffledSeries(s, date, rand);
      const b = blocks(sh, end, settings);
      if (b) out.push(playerCompositeZ(sh, b, d, model, mu, settings.statistic));
    }
  }
  return Float64Array.from(out).sort();
}

export const addDays = (date: string, days: number) => {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

export type BreakoutStatus = "breakout" | "watch" | "none";

export interface BreakoutResult {
  status: BreakoutStatus;
  eval: PlayerEval;
  /** Earlier checkpoints meeting criteria 1–3 (out of settings.checkpoints). */
  checkpointsMet: number;
  /** §4.5: first checkpoint of the current persistent run (breakouts only). */
  onset: string | null;
}

/**
 * Detector over a level/role: memoized states by date; the null pool comes from `nullFor` (the real data's
 * pool, also used when this detector runs on shuffled data).
 */
export function detector(
  d: RoleData,
  model: LevelModel,
  nullFor: (date: string) => Float64Array,
  settings: BreakoutSettings = BREAKOUT_SETTINGS,
) {
  const states = new Map<string, LevelState>();
  const state = (date: string) => {
    let st = states.get(date);
    if (!st) {
      st = levelState(d, date, model, nullFor(date), settings);
      states.set(date, st);
    }
    return st;
  };
  const crit = (id: string, date: string) => state(date).players.get(id)?.crit ?? false;
  const evaluate = (date: string): Map<string, BreakoutResult> => {
    const out = new Map<string, BreakoutResult>();
    for (const [id, ev] of state(date).players) {
      let met = 0;
      for (let c = 1; c <= settings.checkpoints; c++) if (crit(id, addDays(date, -c * settings.checkpointStepDays))) met++;
      const breakout = ev.crit && met >= settings.checkpointsRequired;
      let onset: string | null = null;
      if (breakout) {
        onset = date;
        for (let c = 1; crit(id, addDays(date, -c * settings.checkpointStepDays)); c++)
          onset = addDays(date, -c * settings.checkpointStepDays);
      }
      const status: BreakoutStatus = breakout ? "breakout" : ev.watchBase ? "watch" : "none";
      out.set(id, { status, eval: ev, checkpointsMet: met, onset });
    }
    return out;
  };
  return { state, evaluate };
}

/** The real data's null provider on a fixed grid of dates (§6.2), memoized. */
export function gridNull(d: RoleData, model: LevelModel, seed: number, settings: BreakoutSettings = BREAKOUT_SETTINGS) {
  const first = d.dates[0];
  const pools = new Map<string, Float64Array>();
  return (date: string) => {
    if (!first || date < first) return new Float64Array();
    const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86400000);
    const grid = addDays(first, Math.floor(days / settings.nullGridDays) * settings.nullGridDays);
    let pool = pools.get(grid);
    if (!pool) {
      const gridSeed = (seed ^ Math.imul(days - (days % settings.nullGridDays) + 1, 2654435761)) >>> 0;
      pool = nullPool(d, grid, model, rng(gridSeed), settings);
      pools.set(grid, pool);
    }
    return pool;
  };
}
