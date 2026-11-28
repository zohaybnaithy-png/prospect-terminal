/**
 * Player similarity (docs/SIMILARITY-METHOD.md §3–§5, approved D-024). Pure and deterministic.
 *
 * Per level and role: every number comes from one level's completed games (read-model rule), never pooled across
 * levels. Used only by the offline validation (T-406); nothing here is rendered on the site.
 */
import { buildDataset } from "@/analytics/windows";
import type { AflBattingLine, AflPitchingLine, AflSnapshot } from "@/services/afl/types";
import { decimalAge, median } from "@/services/players/level-age";
import { SIMILARITY_DIMS, SIMILARITY_SETTINGS, type SimilarityRole, type SimilaritySettings } from "./config";

// ---------- data ----------

/** D-026 position groups from the primary position: C, IF (1B 2B 3B SS), OF (LF CF RF), or the position itself. */
export function positionGroup(position: string | null | undefined) {
  const pos = (position ?? "").toUpperCase();
  if (pos === "C") return "C";
  if (["1B", "2B", "3B", "SS", "IF"].includes(pos)) return "IF";
  if (["LF", "CF", "RF", "OF"].includes(pos)) return "OF";
  return pos || "?";
}

/** One player's games at one level in date order; per-game numerators and denominators per dimension. */
export interface PlayerGames {
  id: string;
  birthDate: string | null;
  /** Position group (D-026); pitchers are "P". */
  group: string;
  dates: string[];
  /** PA (hitters) / BF (pitchers) per game. */
  opp: number[];
  num: number[][];
  den: number[][];
  /** Baseline counts per game: hitters [H, BB, HBP, AB, SF, TB, PA], pitchers [K, BB, BF]. */
  base: number[][];
}

export interface RoleGames {
  role: SimilarityRole;
  players: PlayerGames[];
  /** The level's latest completed-game date. */
  asOf: string | null;
}

export function roleGamesFromSnapshot(snapshot: AflSnapshot, role: SimilarityRole): RoleGames {
  const ds = buildDataset(snapshot);
  const births = new Map(snapshot.players.map((p) => [p.id, p.birthDate]));
  const positions = new Map(snapshot.players.map((p) => [p.id, p.primaryPosition]));
  const nDims = SIMILARITY_DIMS[role].length;
  const players: PlayerGames[] = [];
  const source = role === "hitter" ? ds.batting : ds.pitching;
  for (const [id, raw] of source) {
    const lines = [...raw].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const p: PlayerGames = {
      id, birthDate: births.get(id) ?? null, group: role === "pitcher" ? "P" : positionGroup(positions.get(id)), dates: [], opp: [],
      num: Array.from({ length: nDims }, () => []), den: Array.from({ length: nDims }, () => []), base: [],
    };
    const push = (date: string, opp: number, pairs: [number, number][], base: number[]) => {
      p.dates.push(date);
      p.opp.push(opp);
      pairs.forEach(([n, d], j) => { p.num[j].push(n); p.den[j].push(d); });
      p.base.push(base);
    };
    for (const { date, line } of lines) {
      if (role === "hitter") {
        const l = line as AflBattingLine;
        if (!(l.plateAppearances > 0)) continue;
        const xb = l.doubles + 2 * l.triples + 3 * l.homeRuns;
        const singles = l.hits - l.doubles - l.triples - l.homeRuns;
        push(date, l.plateAppearances, [
          [l.strikeouts, l.plateAppearances],
          [l.walks, l.plateAppearances],
          [xb, l.atBats],
          [l.hits - l.homeRuns, Math.max(0, l.atBats - l.strikeouts - l.homeRuns + l.sacrificeFlies)],
          // SB per time on first, approximately (singles + BB + HBP); CS is not always present (§3).
          [l.stolenBases, Math.max(0, singles + l.walks + l.hitByPitch)],
        ], [l.hits, l.walks, l.hitByPitch, l.atBats, l.sacrificeFlies, l.hits + xb, l.plateAppearances]);
      } else {
        const l = line as AflPitchingLine;
        if (!(l.battersFaced > 0)) continue;
        const hbp = l.hitBatters ?? 0;
        push(date, l.battersFaced, [
          [l.strikeouts, l.battersFaced],
          [l.walks, l.battersFaced],
          [l.homeRunsAllowed, l.battersFaced],
          // Approximate: no sac-fly data for pitchers (§3).
          [l.hitsAllowed - l.homeRunsAllowed, Math.max(0, l.battersFaced - l.strikeouts - l.walks - hbp - l.homeRunsAllowed)],
          [l.battersFaced, 1],
        ], [l.strikeouts, l.walks, l.battersFaced]);
      }
    }
    if (p.dates.length) players.push(p);
  }
  players.sort((a, b) => a.id.localeCompare(b.id));
  return { role, players, asOf: ds.completedDates.at(-1) ?? null };
}

/** Totals of a player's games selected by `pick(gameIndex)`. */
export interface Totals {
  id: string;
  birthDate: string | null;
  group: string;
  games: number;
  opp: number;
  num: number[];
  den: number[];
  base: number[];
}

export function totals(p: PlayerGames, pick: (g: number) => boolean): Totals {
  const t: Totals = {
    id: p.id, birthDate: p.birthDate, group: p.group, games: 0, opp: 0,
    num: p.num.map(() => 0), den: p.den.map(() => 0), base: (p.base[0] ?? []).map(() => 0),
  };
  for (let g = 0; g < p.dates.length; g++) {
    if (!pick(g)) continue;
    t.games++;
    t.opp += p.opp[g];
    for (let j = 0; j < p.num.length; j++) { t.num[j] += p.num[j][g]; t.den[j] += p.den[j][g]; }
    p.base[g].forEach((x, i) => (t.base[i] += x));
  }
  return t;
}

/** Totals for every player over games on or before `through` (inclusive) or after it. */
export function totalsThrough(d: RoleGames, through: string, side: "pre" | "post" = "pre") {
  return d.players.map((p) => totals(p, (g) => (side === "pre" ? p.dates[g] <= through : p.dates[g] > through)));
}

// ---------- statistics helpers ----------

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

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function sd(xs: number[]) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function pearson(x: number[], y: number[]) {
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

export function quantile(xs: number[], q: number) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}

// ---------- §3 reliability and shrinkage ----------

export interface DimReliability {
  label: string;
  /** Players with ≥ 2 · minSample in the range (both halves usable). */
  players: number;
  splitHalfR: number;
  /** Shrinkage constant in the dimension's denominator units (Infinity: no measurable reliability). */
  k: number;
  /** Reliability at the qualification sample (minSample PA/BF converted to the dimension's denominator). */
  atMinSample: number;
}

/** Minimum players for a split-half estimate; below it the dimension gets k = Infinity (weight 0). */
export const MIN_RELIABILITY_PLAYERS = 20;

/**
 * Odd/even split-half reliability of dimension `j` over games selected by `pick`, Spearman–Brown stepped up to the
 * full sample, converted to the constant k with rel(n) = n / (n + k) (same estimator as BREAKOUT-METHOD.md §6.1).
 */
export function splitHalfReliability(
  d: RoleGames,
  j: number,
  pick: (p: PlayerGames, g: number) => boolean,
  settings: SimilaritySettings = SIMILARITY_SETTINGS,
): DimReliability {
  const odd: number[] = [];
  const even: number[] = [];
  const n: number[] = [];
  let den = 0;
  let opp = 0;
  for (const p of d.players) {
    let o = 0, xo = 0, ao = 0, xe = 0, ae = 0, idx = 0;
    for (let g = 0; g < p.dates.length; g++) {
      if (!pick(p, g)) continue;
      o += p.opp[g];
      if (idx++ % 2) { xo += p.num[j][g]; ao += p.den[j][g]; } else { xe += p.num[j][g]; ae += p.den[j][g]; }
    }
    if (o < 2 * settings.minSample || ao <= 0 || ae <= 0) continue;
    odd.push(xo / ao);
    even.push(xe / ae);
    n.push(ao + ae);
    den += ao + ae;
    opp += o;
  }
  const label = SIMILARITY_DIMS[d.role][j].label;
  if (odd.length < MIN_RELIABILITY_PLAYERS) return { label, players: odd.length, splitHalfR: NaN, k: Infinity, atMinSample: 0 };
  const r = pearson(odd, even);
  const rel = (2 * r) / (1 + r);
  const k = rel > 0 ? (mean(n) * (1 - rel)) / rel : Infinity;
  const nMin = settings.minSample * (den / opp);
  return { label, players: odd.length, splitHalfR: r, k, atMinSample: Number.isFinite(k) ? nMin / (nMin + k) : 0 };
}

export const shrink = (x: number, n: number, mu: number, k: number) =>
  !Number.isFinite(k) ? mu : n + k > 0 ? (x + k * mu) / (n + k) : mu;

export const reliabilityAt = (n: number, k: number) => (Number.isFinite(k) && n + k > 0 ? n / (n + k) : 0);

// ---------- §4 population, profiles, distance ----------

export interface DimModel {
  /** Level mean (ratio of sums over every player in the range). */
  mu: number;
  k: number;
  /** Mean and SD of the shrunk values among qualified players (for z-scores). */
  mean: number;
  sd: number;
  /** SD of the unshrunk rates among qualified players (the scale of holdout errors; never degenerate like `sd`). */
  rawSd: number;
}

export interface Profile {
  id: string;
  group: string;
  /** PA / BF in the range. */
  n: number;
  games: number;
  den: number[];
  raw: number[];
  shrunk: number[];
  z: number[];
  rel: number[];
  /** Age minus the level median (years, unrounded), or null. */
  age: number | null;
  ageZ: number | null;
  totals: Totals;
}

export interface Population {
  role: SimilarityRole;
  asOf: string;
  dims: DimModel[];
  ageMedian: number | null;
  /** Qualified players per position group. */
  groupSizes: Map<string, number>;
  ageMean: number;
  ageSd: number;
  /** Qualified players (n ≥ minSample), sorted by id. */
  profiles: Profile[];
  byId: Map<string, Profile>;
}

/**
 * The level population on `asOf` from range totals (one entry per player who played in the range).
 * `k` comes from split-half reliability of the same range (or another range when the caller decides).
 */
export function population(
  role: SimilarityRole,
  all: Totals[],
  k: number[],
  asOf: string,
  settings: SimilaritySettings = SIMILARITY_SETTINGS,
): Population {
  const nDims = SIMILARITY_DIMS[role].length;
  const played = all.filter((t) => t.opp > 0);
  const dims: DimModel[] = [];
  for (let j = 0; j < nDims; j++) {
    const sn = played.reduce((a, t) => a + t.num[j], 0);
    const sdn = played.reduce((a, t) => a + t.den[j], 0);
    dims.push({ mu: sdn > 0 ? sn / sdn : 0, k: k[j], mean: 0, sd: 0, rawSd: 0 });
  }
  // D-020: median age of everyone with a line in the range and a known birth date.
  const ages = new Map<string, number>();
  for (const t of played) {
    const a = t.birthDate ? decimalAge(t.birthDate, asOf) : null;
    if (a !== null) ages.set(t.id, a);
  }
  const ageMedian = ages.size >= settings.minAgeSample ? median([...ages.values()]) : null;
  const qualified = played.filter((t) => t.opp >= settings.minSample).sort((a, b) => a.id.localeCompare(b.id));
  const profiles: Profile[] = qualified.map((t) => {
    const raw = t.num.map((x, j) => (t.den[j] > 0 ? x / t.den[j] : dims[j].mu));
    const shrunk = t.num.map((x, j) => shrink(x, t.den[j], dims[j].mu, dims[j].k));
    const a = ages.get(t.id);
    return {
      id: t.id, group: t.group, n: t.opp, games: t.games, den: [...t.den], raw, shrunk, z: [], rel: t.den.map((n, j) => reliabilityAt(n, dims[j].k)),
      age: ageMedian !== null && a !== undefined ? a - ageMedian : null, ageZ: null, totals: t,
    };
  });
  for (let j = 0; j < nDims; j++) {
    const v = profiles.map((p) => p.shrunk[j]);
    dims[j].mean = mean(v);
    dims[j].sd = sd(v);
    dims[j].rawSd = sd(profiles.map((p) => p.raw[j]));
    for (const p of profiles) p.z[j] = dims[j].sd > 1e-9 ? (p.shrunk[j] - dims[j].mean) / dims[j].sd : 0;
  }
  const av = profiles.map((p) => p.age).filter((a): a is number => a !== null);
  const ageMean = mean(av);
  const ageSd = sd(av);
  for (const p of profiles) p.ageZ = p.age !== null && ageSd > 0 ? (p.age - ageMean) / ageSd : null;
  const groupSizes = new Map<string, number>();
  for (const p of profiles) groupSizes.set(p.group, (groupSizes.get(p.group) ?? 0) + 1);
  return { role, asOf, dims, ageMedian, groupSizes, ageMean, ageSd, profiles, byId: new Map(profiles.map((p) => [p.id, p])) };
}

/** Per-dimension pieces of a pair: z difference and weight (age last, when used and known for both). */
export interface PairPart {
  dim: number; // -1 = age
  dz: number;
  w: number;
}

export function pairParts(a: Profile, b: Profile, settings: SimilaritySettings = SIMILARITY_SETTINGS): PairPart[] {
  const parts: PairPart[] = a.z.map((z, j) => ({ dim: j, dz: z - b.z[j], w: Math.sqrt(a.rel[j] * b.rel[j]) }));
  if (settings.useAge && a.ageZ !== null && b.ageZ !== null) parts.push({ dim: -1, dz: a.ageZ - b.ageZ, w: 1 });
  return parts;
}

/** §4.3 weighted Euclidean distance on z-scores; Infinity when no dimension carries weight. */
export function distance(parts: PairPart[]) {
  let num = 0;
  let den = 0;
  for (const p of parts) { num += p.w * p.dz * p.dz; den += p.w; }
  return den > 0 ? Math.sqrt(num / den) : Infinity;
}

/** §4.4 similarity score: 100 identical, 61 one SD apart on average, 14 two SDs. */
export const similarityScore = (d: number) => (Number.isFinite(d) ? 100 * Math.exp((-d * d) / 2) : 0);

/** Inverse of a small symmetric positive-definite matrix (Gauss–Jordan); null when singular. */
export function invert(m: number[][]): number[][] | null {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (Math.abs(a[piv][c]) < 1e-12) return null;
    [a[c], a[piv]] = [a[piv], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * Inverse correlation matrix of the z-scores (dimensions + age when used) among qualified players with every
 * dimension known, for the Mahalanobis alternative (§4.3, sensitivity only).
 */
export function mahalanobisMatrix(pop: Population, settings: SimilaritySettings = SIMILARITY_SETTINGS) {
  const rows = pop.profiles
    .filter((p) => !settings.useAge || p.ageZ !== null)
    .map((p) => (settings.useAge ? [...p.z, p.ageZ as number] : [...p.z]));
  if (rows.length < 3) return null;
  const p = rows[0].length;
  const c = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => (i === j ? 1 : pearson(rows.map((r) => r[i]), rows.map((r) => r[j])))));
  return invert(c.map((row) => row.map((x) => (Number.isFinite(x) ? x : 0))));
}

function mahalanobis(parts: PairPart[], inv: number[][], nDims: number, useAge: boolean) {
  const size = nDims + (useAge ? 1 : 0);
  if (parts.length !== size) return distance(parts); // age unknown for one of the pair: fall back
  const v = parts.map((p) => Math.sqrt(p.w) * p.dz);
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  if (!(wsum > 0)) return Infinity;
  let q = 0;
  for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) q += v[i] * inv[i][j] * v[j];
  return Math.sqrt(Math.max(0, q) / wsum);
}

/** D-026 applies to hitters only (pitcher usage is already in the profile as BF per appearance). */
export const isGrouped = (pop: Pick<Population, "role">, settings: SimilaritySettings) => pop.role === "hitter" && settings.positionGroups;

export interface Neighbor {
  id: string;
  distance: number;
  score: number;
  n: number;
  parts: PairPart[];
}

/**
 * §5: the `topN` most similar qualified players (excluding the player), optionally restricted to `pool`.
 * Ties: larger sample first, then id (deterministic).
 */
export function similarPlayers(
  pop: Population,
  id: string,
  settings: SimilaritySettings = SIMILARITY_SETTINGS,
  opts: { pool?: Set<string>; depth?: number; inv?: number[][] | null } = {},
): Neighbor[] {
  const me = pop.byId.get(id);
  if (!me) return [];
  const grouped = isGrouped(pop, settings);
  if (grouped && (pop.groupSizes.get(me.group) ?? 0) < settings.minGroupSize) return [];
  const nDims = SIMILARITY_DIMS[pop.role].length;
  const out: Neighbor[] = [];
  for (const o of pop.profiles) {
    if (o.id === id || (opts.pool && !opts.pool.has(o.id)) || (grouped && o.group !== me.group)) continue;
    const parts = pairParts(me, o, settings);
    const dist = settings.distance === "mahalanobis" && opts.inv ? mahalanobis(parts, opts.inv, nDims, settings.useAge) : distance(parts);
    if (!Number.isFinite(dist)) continue;
    out.push({ id: o.id, distance: dist, score: similarityScore(dist), n: o.n, parts });
  }
  out.sort((a, b) => a.distance - b.distance || b.n - a.n || a.id.localeCompare(b.id));
  return out.slice(0, opts.depth ?? settings.topN);
}

/** §5 explanation: dimensions by |z difference| (weighted dimensions only), closest first. */
export function closestAndFurthest(parts: PairPart[], role: SimilarityRole, count = 2) {
  const label = (d: number) => (d < 0 ? "Age vs level" : SIMILARITY_DIMS[role][d].label);
  const ranked = parts.filter((p) => p.w > 0.05).sort((a, b) => Math.abs(a.dz) - Math.abs(b.dz));
  return {
    closest: ranked.slice(0, count).map((p) => label(p.dim)),
    furthest: ranked.slice(-count).reverse().map((p) => label(p.dim)),
  };
}
