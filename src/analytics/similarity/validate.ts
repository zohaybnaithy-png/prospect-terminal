/**
 * Offline similarity validation (docs/SIMILARITY-METHOD.md §6–§7, approved D-024, T-406). Pure and seeded.
 * Reads one level snapshot at a time; nothing is combined across levels.
 */
import type { AflPlayer, AflSnapshot } from "@/services/afl/types";
import {
  AGE_DIM_LABEL,
  SIMILARITY_DIMS,
  SIMILARITY_SETTINGS,
  SIMILARITY_VALIDATION,
  type SimilarityRole,
  type SimilaritySettings,
} from "./config";
import {
  closestAndFurthest,
  mahalanobisMatrix,
  mean,
  population,
  quantile,
  rng,
  roleGamesFromSnapshot,
  similarPlayers,
  splitHalfReliability,
  totals,
  totalsThrough,
  type DimReliability,
  type PlayerGames,
  type Population,
  type RoleGames,
  type Totals,
} from "./profiles";

export type Validation = typeof SIMILARITY_VALIDATION;

const sample = <T>(xs: T[], rand: () => number) => xs.map(() => xs[Math.floor(rand() * xs.length)]);

/** Mean and 90% bootstrap interval of the mean. */
function ci(xs: number[], v: Validation, rand: () => number) {
  const m = mean(xs);
  if (xs.length < 2) return { mean: m, lo: NaN, hi: NaN };
  const boots: number[] = [];
  for (let b = 0; b < v.bootstrap; b++) boots.push(mean(sample(xs, rand)));
  return { mean: m, lo: quantile(boots, 0.05), hi: quantile(boots, 0.95) };
}

export function reliabilities(d: RoleGames, pick: (p: PlayerGames, g: number) => boolean, settings: SimilaritySettings) {
  return SIMILARITY_DIMS[d.role].map((_, j) => splitHalfReliability(d, j, pick, settings));
}

// ---------- §6.1 stability (split-half) ----------

export interface SplitHalfResult {
  /** Players qualified in both halves (the comparison pool). */
  players: number;
  chance: number;
  overlap: { mean: number; lo: number; hi: number };
  baseline: { mean: number; lo: number; hi: number };
  /** Paired difference overlap − baseline. */
  difference: { mean: number; lo: number; hi: number };
  baselineLabel: string;
}

/** The single-stat baseline (§6.1): closest OPS for hitters, closest K−BB% for pitchers. */
export function baselineValue(role: SimilarityRole, t: Totals): number | null {
  if (role === "hitter") {
    const [h, bb, hbp, ab, sf, tb] = t.base;
    const obpDen = ab + bb + hbp + sf;
    if (!(ab > 0) || !(obpDen > 0)) return null;
    return (h + bb + hbp) / obpDen + tb / ab;
  }
  const [k, bb, bf] = t.base;
  return bf > 0 ? (k - bb) / bf : null;
}

function baselineNeighbors(values: Map<string, { v: number; n: number }>, id: string, depth: number) {
  const me = values.get(id)!;
  return [...values]
    .filter(([o]) => o !== id)
    .map(([o, x]) => ({ id: o, d: Math.abs(x.v - me.v), n: x.n }))
    .sort((a, b) => a.d - b.d || b.n - a.n || a.id.localeCompare(b.id))
    .slice(0, depth)
    .map((x) => x.id);
}

export function splitHalf(d: RoleGames, k: number[], settings: SimilaritySettings, v: Validation, rand: () => number): SplitHalfResult {
  const asOf = d.asOf ?? "";
  const odd = d.players.map((p) => totals(p, (g) => g % 2 === 1));
  const even = d.players.map((p) => totals(p, (g) => g % 2 === 0));
  const po = population(d.role, odd, k, asOf, settings);
  const pe = population(d.role, even, k, asOf, settings);
  const common = new Set(po.profiles.filter((p) => pe.byId.has(p.id)).map((p) => p.id));
  const vals = (half: Totals[]) => {
    const m = new Map<string, { v: number; n: number }>();
    for (const t of half) {
      const b = common.has(t.id) ? baselineValue(d.role, t) : null;
      if (b !== null) m.set(t.id, { v: b, n: t.opp });
    }
    return m;
  };
  const bo = vals(odd);
  const be = vals(even);
  const overlaps: number[] = [];
  const baselines: number[] = [];
  const diffs: number[] = [];
  for (const id of common) {
    const a = similarPlayers(po, id, settings, { pool: common });
    const b = new Set(similarPlayers(pe, id, settings, { pool: common, depth: v.overlapDepth }).map((x) => x.id));
    if (a.length < settings.topN) continue;
    const ov = a.filter((x) => b.has(x.id)).length / a.length;
    let bl = NaN;
    if (bo.has(id) && be.has(id)) {
      const ba = baselineNeighbors(bo, id, settings.topN);
      const bb = new Set(baselineNeighbors(be, id, v.overlapDepth));
      bl = ba.filter((x) => bb.has(x)).length / ba.length;
    }
    overlaps.push(ov);
    if (Number.isFinite(bl)) { baselines.push(bl); diffs.push(ov - bl); }
  }
  return {
    players: common.size,
    chance: common.size > 1 ? Math.min(1, v.overlapDepth / (common.size - 1)) : NaN,
    overlap: ci(overlaps, v, rand),
    baseline: ci(baselines, v, rand),
    difference: ci(diffs, v, rand),
    baselineLabel: d.role === "hitter" ? "closest OPS" : "closest K−BB%",
  };
}

// ---------- §6.2 predictive meaning (holdout) ----------

export interface HoldoutCutoff {
  date: string;
  players: number;
  alpha: number;
  mseLevel: number;
  mseOwn: number;
  mseSimilar: number;
  mseCombined: number;
}

export interface HoldoutResult {
  cutoffs: HoldoutCutoff[];
  /** Mean over cutoffs of MSE(own) − MSE(combined), z² units; 90% bootstrap interval over players. */
  improvement: { mean: number; lo: number; hi: number };
}

interface Residuals {
  own: number[];
  nbr: number[];
  lvl: number[];
}

const mse = (r: Residuals, a: number) => mean(r.own.map((e, j) => ((1 - a) * e + a * r.nbr[j]) ** 2));

export function holdout(d: RoleGames, year: number, settings: SimilaritySettings, v: Validation, rand: () => number): HoldoutResult {
  const skill = SIMILARITY_DIMS[d.role].map((x, j) => (x.skill ? j : -1)).filter((j) => j >= 0);
  const per: { date: string; rows: Residuals[] }[] = [];
  for (const c of v.cutoffs) {
    const date = `${year}-${c}`;
    const pre = totalsThrough(d, date, "pre");
    const post = new Map(totalsThrough(d, date, "post").map((t) => [t.id, t]));
    // No leakage: the shrinkage constants come from pre-cutoff games only.
    const k = reliabilities(d, (p, g) => p.dates[g] <= date, settings).map((r) => r.k);
    const pop = population(d.role, pre, k, date, settings);
    const pool = new Set(pop.profiles.filter((p) => (post.get(p.id)?.opp ?? 0) >= v.minPost).map((p) => p.id));
    const rows: Residuals[] = [];
    if (pool.size > settings.topN)
      for (const id of [...pool].sort()) {
        const me = pop.byId.get(id)!;
        const after = post.get(id)!;
        const nbrs = similarPlayers(pop, id, settings, { pool });
        const r: Residuals = { own: [], nbr: [], lvl: [] };
        for (const j of skill) {
          const dm = pop.dims[j];
          if (!(after.den[j] > 0) || !(dm.rawSd > 0)) continue;
          const rates = nbrs.map((n) => post.get(n.id)!).filter((t) => t.den[j] > 0).map((t) => t.num[j] / t.den[j]);
          if (!rates.length) continue;
          const y = after.num[j] / after.den[j];
          r.own.push((y - me.shrunk[j]) / dm.rawSd);
          r.nbr.push((y - mean(rates)) / dm.rawSd);
          r.lvl.push((y - dm.mu) / dm.rawSd);
        }
        if (r.own.length) rows.push(r);
      }
    per.push({ date, rows });
  }
  const used = per.filter((p) => p.rows.length >= 20);
  const grid = Array.from({ length: Math.round(1 / v.alphaStep) + 1 }, (_, i) => i * v.alphaStep);
  // α for each cutoff is chosen on the other cutoffs only (leave-one-cutoff-out), never on the evaluated one.
  const alphaFor = (skip: string) => {
    const rows = used.filter((p) => p.date !== skip).flatMap((p) => p.rows);
    if (!rows.length) return 0;
    let best = 0;
    let bestErr = Infinity;
    for (const a of grid) {
      const e = mean(rows.map((r) => mse(r, a)));
      if (e < bestErr - 1e-12) { bestErr = e; best = a; }
    }
    return best;
  };
  const cutoffs: HoldoutCutoff[] = [];
  const gains: { rows: number[] }[] = [];
  for (const p of used) {
    const alpha = alphaFor(p.date);
    cutoffs.push({
      date: p.date,
      players: p.rows.length,
      alpha,
      mseLevel: mean(p.rows.map((r) => mean(r.lvl.map((e) => e * e)))),
      mseOwn: mean(p.rows.map((r) => mse(r, 0))),
      mseSimilar: mean(p.rows.map((r) => mse(r, 1))),
      mseCombined: mean(p.rows.map((r) => mse(r, alpha))),
    });
    gains.push({ rows: p.rows.map((r) => mse(r, 0) - mse(r, alpha)) });
  }
  const point = mean(gains.map((g) => mean(g.rows)));
  const boots: number[] = [];
  if (gains.length)
    for (let b = 0; b < v.bootstrap; b++) boots.push(mean(gains.map((g) => mean(sample(g.rows, rand)))));
  return { cutoffs, improvement: { mean: point, lo: quantile(boots, 0.05), hi: quantile(boots, 0.95) } };
}

// ---------- §6.3 face validity ----------

export interface FaceList {
  id: string;
  neighbors: { id: string; score: number; n: number; closest: string[]; furthest: string[] }[];
}

export interface MismatchStat {
  label: string;
  /** Share (or mean) among top-N neighbor pairs vs all pairs of qualified players. */
  neighbors: number;
  allPairs: number;
}

export interface FaceValidity {
  lists: FaceList[];
  checks: MismatchStat[];
}

const positionGroup = (p: AflPlayer | undefined) => {
  const pos = (p?.primaryPosition ?? "").toUpperCase();
  if (pos === "C") return "C";
  if (["1B", "2B", "3B", "SS", "IF"].includes(pos)) return "IF";
  if (["LF", "CF", "RF", "OF"].includes(pos)) return "OF";
  return pos || "?";
};

export function faceValidity(
  pop: Population,
  players: Map<string, AflPlayer>,
  settings: SimilaritySettings,
  v: Validation,
  rand: () => number,
): FaceValidity {
  const ids = pop.profiles.map((p) => p.id);
  const lists = new Map(ids.map((id) => [id, similarPlayers(pop, id, settings)]));
  const order = [...ids];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const chosen = order.slice(0, v.faceValidityPerRole).sort();
  const out: FaceList[] = chosen.map((id) => ({
    id,
    neighbors: lists.get(id)!.map((n) => ({ id: n.id, score: n.score, n: n.n, ...closestAndFurthest(n.parts, pop.role) })),
  }));
  const pairStat = (label: string, f: (a: string, b: string) => number | null): MismatchStat => {
    const nb: number[] = [];
    for (const [a, l] of lists) for (const n of l) { const x = f(a, n.id); if (x !== null) nb.push(x); }
    const all: number[] = [];
    for (const a of ids) for (const b of ids) if (a !== b) { const x = f(a, b); if (x !== null) all.push(x); }
    return { label, neighbors: mean(nb), allPairs: mean(all) };
  };
  const age = (id: string) => pop.byId.get(id)!.age;
  const checks: MismatchStat[] = [
    pairStat("Mean absolute age difference (years)", (a, b) => (age(a) !== null && age(b) !== null ? Math.abs(age(a)! - age(b)!) : null)),
  ];
  if (pop.role === "pitcher") {
    const bfApp = (id: string) => pop.byId.get(id)!.raw[4];
    const cls = (id: string) => (bfApp(id) >= v.starterBf ? "S" : bfApp(id) < v.relieverBf ? "R" : "M");
    checks.push(pairStat("Starter-like paired with reliever-like (share)", (a, b) => {
      const x = cls(a) + cls(b);
      return x === "SR" || x === "RS" ? 1 : 0;
    }));
    checks.push(pairStat("Same throwing hand (share)", (a, b) => {
      const x = players.get(a)?.throws;
      const y = players.get(b)?.throws;
      return x && y ? (x === y ? 1 : 0) : null;
    }));
  } else {
    checks.push(pairStat("Same position group C/IF/OF/other (share)", (a, b) => (positionGroup(players.get(a)) === positionGroup(players.get(b)) ? 1 : 0)));
    checks.push(pairStat("Catcher paired with non-catcher (share)", (a, b) => ((positionGroup(players.get(a)) === "C") !== (positionGroup(players.get(b)) === "C") ? 1 : 0)));
    checks.push(pairStat("Same batting side (share)", (a, b) => {
      const x = players.get(a)?.bats;
      const y = players.get(b)?.bats;
      return x && y ? (x === y ? 1 : 0) : null;
    }));
  }
  return { lists: out, checks };
}

// ---------- §6.4 sensitivity ----------

export interface SensitivityRow {
  variant: string;
  players: number;
  /** Mean share of the default top-N kept by the variant. */
  overlap: number;
}

export function sensitivity(d: RoleGames, k: number[], base: Population, settings: SimilaritySettings, v: Validation): SensitivityRow[] {
  const end = d.players.map((p) => totals(p, () => true));
  const asOf = d.asOf ?? "";
  const lists = new Map(base.profiles.map((p) => [p.id, new Set(similarPlayers(base, p.id, settings).map((n) => n.id))]));
  const compare = (variant: string, s: SimilaritySettings) => {
    const pop = s.minSample === settings.minSample ? base : population(d.role, end, k, asOf, s);
    const inv = s.distance === "mahalanobis" ? mahalanobisMatrix(pop, s) : null;
    const shares: number[] = [];
    for (const p of pop.profiles) {
      const def = lists.get(p.id);
      if (!def) continue;
      const alt = similarPlayers(pop, p.id, s, { inv });
      if (!alt.length) continue;
      shares.push(alt.filter((n) => def.has(n.id)).length / settings.topN);
    }
    return { variant, players: shares.length, overlap: mean(shares) };
  };
  return [
    ...v.sensitivityMinSamples.map((m) => compare(`minSample ${m}`, { ...settings, minSample: m })),
    compare("without age vs level", { ...settings, useAge: false }),
    compare("Mahalanobis distance", { ...settings, distance: "mahalanobis" }),
  ];
}

// ---------- §7 criteria ----------

export interface Criterion {
  id: string;
  text: string;
  pass: boolean | null;
  detail: string;
}

export interface RoleValidation {
  label: string;
  role: SimilarityRole;
  asOf: string | null;
  qualified: number;
  reliability: DimReliability[];
  ageMedian: number | null;
  splitHalf: SplitHalfResult;
  holdout: HoldoutResult;
  face: FaceValidity;
  sensitivity: SensitivityRow[];
  criteria: Criterion[];
  verdict: string;
}

const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

export function validateRole(
  label: string,
  snapshot: AflSnapshot,
  role: SimilarityRole,
  opts: { settings?: SimilaritySettings; validation?: Validation } = {},
): RoleValidation {
  const settings = opts.settings ?? SIMILARITY_SETTINGS;
  const v = opts.validation ?? SIMILARITY_VALIDATION;
  const rand = rng(v.seed + (role === "hitter" ? 0 : 1));
  const d = roleGamesFromSnapshot(snapshot, role);
  const rel = reliabilities(d, () => true, settings);
  const k = rel.map((r) => r.k);
  const end = population(role, d.players.map((p) => totals(p, () => true)), k, d.asOf ?? "", settings);
  const sh = splitHalf(d, k, settings, v, rand);
  const ho = holdout(d, snapshot.season.year, settings, v, rand);
  const meta = new Map(snapshot.players.map((p) => [p.id, p]));
  const face = faceValidity(end, meta, settings, v, rand);
  const sens = sensitivity(d, k, end, settings, v);
  const c1 = sh.overlap.mean >= v.chanceMultiple * sh.chance && sh.overlap.mean > sh.baseline.mean;
  const c2 = ho.cutoffs.length > 0 && ho.improvement.lo > 0;
  const c4 = end.profiles.length >= v.minQualified;
  const criteria: Criterion[] = [
    {
      id: "1", text: `Split-half overlap ≥ ${v.chanceMultiple} × chance and above the single-stat baseline`, pass: c1,
      detail: `overlap ${f(sh.overlap.mean)} vs chance ${f(sh.chance)} (×${f(sh.overlap.mean / sh.chance, 1)}), ${sh.baselineLabel} ${f(sh.baseline.mean)}`,
    },
    {
      id: "2", text: "Holdout: similar players lower the prediction error beyond the player's own rate (90% interval > 0)", pass: c2,
      detail: `improvement ${f(ho.improvement.mean, 4)} [${f(ho.improvement.lo, 4)}, ${f(ho.improvement.hi, 4)}] over ${ho.cutoffs.length} cutoffs`,
    },
    { id: "3", text: "Face validity: no systematic mismatch class", pass: null, detail: "baseball-analyst review (see the report section and the appendix)" },
    { id: "4", text: `At least ${v.minQualified} qualified players`, pass: c4, detail: `${end.profiles.length} qualified (≥ ${settings.minSample} ${role === "hitter" ? "PA" : "BF"})` },
  ];
  const verdict = !c4 || !c1
    ? "not available at this level (criterion 1 or 4 fails)"
    : c2
      ? "passes 1, 2 and 4: similar players with predictive value, subject to criterion 3"
      : "passes 1 and 4, fails 2: browsing aid only (\"similar so far this season\"), subject to criterion 3";
  return {
    label, role, asOf: d.asOf, qualified: end.profiles.length, reliability: rel, ageMedian: end.ageMedian,
    splitHalf: sh, holdout: ho, face, sensitivity: sens, criteria, verdict,
  };
}

// ---------- report ----------

export interface ReportContext {
  source: string;
  snapshotId?: string;
  settings: SimilaritySettings;
  validation?: Validation;
}

const isDefault = (s: SimilaritySettings) => JSON.stringify(s) === JSON.stringify(SIMILARITY_SETTINGS);
const mark = (p: boolean | null) => (p === null ? "review" : p ? "**pass**" : "fail");

export function renderValidationReport(results: RoleValidation[], ctx: ReportContext): string {
  const v = ctx.validation ?? SIMILARITY_VALIDATION;
  const s = ctx.settings;
  const L: string[] = [];
  L.push("# Similarity validation report", "");
  L.push(`Method: docs/SIMILARITY-METHOD.md (approved D-024). Source: ${ctx.source}${ctx.snapshotId ? `, snapshot id ${ctx.snapshotId}` : ""}.`);
  L.push(`Settings: minSample ${s.minSample}, top ${s.topN}, age ${s.useAge ? "on" : "off"}, ${s.distance} distance, seed ${v.seed}, bootstrap ${v.bootstrap}. ` +
    (isDefault(s) ? "These are the approved defaults." : "**Not the approved defaults** (comparison run only)."), "");
  L.push("## Verdict", "", "| Level | Role | Qualified | C1 stability | C2 holdout | C3 face validity | C4 population | Verdict |", "|---|---|---|---|---|---|---|---|");
  for (const r of results) L.push(`| ${r.label} | ${r.role} | ${r.qualified} | ${r.criteria.map((c) => mark(c.pass)).join(" | ")} | ${r.verdict} |`);
  L.push("");
  L.push("## 1. Reliability (split-half, full season)", "", "k is in the dimension's own denominator units; reliability is at the qualification sample.", "");
  L.push("| Level | Role | Dimension | Players | Split-half r | k | Reliability at minSample |", "|---|---|---|---|---|---|---|");
  for (const r of results) for (const x of r.reliability) L.push(`| ${r.label} | ${r.role} | ${x.label} | ${x.players} | ${f(x.splitHalfR)} | ${Number.isFinite(x.k) ? x.k.toFixed(0) : "∞"} | ${f(x.atMinSample, 2)} |`);
  L.push("");
  L.push("## 2. Stability (§6.1)", "", `Top ${s.topN} from odd games, looked up in the top ${v.overlapDepth} from even games, among players qualified in both halves. Chance = ${v.overlapDepth} / (players − 1). 90% bootstrap intervals.`, "");
  L.push("| Level | Role | Players | Chance | Overlap | Baseline | Baseline overlap | Difference |", "|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const x = r.splitHalf;
    L.push(`| ${r.label} | ${r.role} | ${x.players} | ${f(x.chance)} | ${f(x.overlap.mean)} [${f(x.overlap.lo)}, ${f(x.overlap.hi)}] | ${x.baselineLabel} | ${f(x.baseline.mean)} [${f(x.baseline.lo)}, ${f(x.baseline.hi)}] | ${f(x.difference.mean)} [${f(x.difference.lo)}, ${f(x.difference.hi)}] |`);
  }
  L.push("");
  L.push("## 3. Predictive meaning (§6.2)", "",
    `At each cutoff: similar players from games through the cutoff, among players with ≥ ${s.minSample} before and ≥ ${v.minPost} after. ` +
    "Errors are post-cutoff skill rates minus the prediction, in level SDs of the pre-cutoff observed rates, squared and averaged over the skill dimensions. " +
    "Combined = (1 − α) · own shrunk rate + α · similar players' mean post-cutoff rate, with α chosen on the other cutoffs only.", "");
  L.push("| Level | Role | Cutoff | Players | α | MSE level mean | MSE own | MSE similar | MSE combined |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of results) for (const c of r.holdout.cutoffs)
    L.push(`| ${r.label} | ${r.role} | ${c.date} | ${c.players} | ${f(c.alpha, 2)} | ${f(c.mseLevel)} | ${f(c.mseOwn)} | ${f(c.mseSimilar)} | ${f(c.mseCombined)} |`);
  L.push("", "| Level | Role | Improvement (MSE own − combined) | 90% interval |", "|---|---|---|---|");
  for (const r of results) L.push(`| ${r.label} | ${r.role} | ${f(r.holdout.improvement.mean, 4)} | [${f(r.holdout.improvement.lo, 4)}, ${f(r.holdout.improvement.hi, 4)}] |`);
  L.push("");
  L.push("## 4. Face validity (§6.3), automatic checks", "", "Over every qualified player's list, compared with all pairs of qualified players. The random-sample lists are in the appendix for the review.", "");
  L.push("| Level | Role | Check | Neighbor pairs | All pairs |", "|---|---|---|---|---|");
  for (const r of results) for (const c of r.face.checks) L.push(`| ${r.label} | ${r.role} | ${c.label} | ${f(c.neighbors, 2)} | ${f(c.allPairs, 2)} |`);
  L.push("");
  L.push("## 5. Sensitivity (§6.4, information only)", "", `Share of the default top ${s.topN} that a variant keeps, at season end.`, "");
  L.push("| Level | Role | Variant | Players | Kept |", "|---|---|---|---|---|");
  for (const r of results) for (const x of r.sensitivity) L.push(`| ${r.label} | ${r.role} | ${x.variant} | ${x.players} | ${f(x.overlap, 2)} |`);
  L.push("");
  L.push("## 6. Criteria detail", "");
  for (const r of results) {
    L.push(`**${r.label} ${r.role}s** (as of ${r.asOf ?? "n/a"}, level median age ${r.ageMedian === null ? "n/a" : r.ageMedian.toFixed(1)})`, "");
    for (const c of r.criteria) L.push(`- C${c.id} ${mark(c.pass)}: ${c.text}. ${c.detail}.`);
    L.push("");
  }
  return L.join("\n") + "\n";
}

/** Appendix for the face-validity review: the random-sample lists with profiles (§6.3). */
export function renderFaceValidityAppendix(
  results: RoleValidation[],
  snapshots: Map<string, AflSnapshot>,
  ctx: ReportContext,
): string {
  const s = ctx.settings;
  const L: string[] = ["# Similarity face-validity appendix", "",
    `Random sample (seed ${(ctx.validation ?? SIMILARITY_VALIDATION).seed}), not hand-picked. Source: ${ctx.source}${ctx.snapshotId ? `, snapshot id ${ctx.snapshotId}` : ""}. ` +
    "Profiles are shrunk rates at season end; age is years vs the level median.", ""];
  for (const r of results) {
    const snap = snapshots.get(r.label)!;
    const meta = new Map(snap.players.map((p) => [p.id, p]));
    const d = roleGamesFromSnapshot(snap, r.role);
    const k = r.reliability.map((x) => x.k);
    const pop = population(r.role, d.players.map((p) => totals(p, () => true)), k, d.asOf ?? "", s);
    const dims = SIMILARITY_DIMS[r.role];
    const head = `| Player | Pos | ${r.role === "hitter" ? "Bats" : "Throws"} | ${r.role === "hitter" ? "PA" : "BF"} | ${dims.map((x) => x.label).join(" | ")} | ${AGE_DIM_LABEL} | Score | Closest | Furthest |`;
    const row = (id: string, extra: string) => {
      const p = pop.byId.get(id)!;
      const m = meta.get(id);
      return `| ${m?.name ?? id} | ${m?.primaryPosition ?? "?"} | ${(r.role === "hitter" ? m?.bats : m?.throws) ?? "?"} | ${p.n} | ${p.shrunk.map((x, j) => x.toFixed(dims[j].digits)).join(" | ")} | ${p.age === null ? "n/a" : (p.age >= 0 ? "+" : "") + p.age.toFixed(1)} | ${extra} |`;
    };
    L.push(`## ${r.label} ${r.role}s`, "");
    for (const list of r.face.lists) {
      L.push(head, `|${"---|".repeat(dims.length + 9)}`);
      L.push(row(list.id, "— | — | —"));
      for (const n of list.neighbors) L.push(row(n.id, `${n.score.toFixed(0)} | ${n.closest.join(", ")} | ${n.furthest.join(", ")}`));
      L.push("");
    }
  }
  return L.join("\n") + "\n";
}
