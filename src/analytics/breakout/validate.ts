/**
 * Offline validation of the breakout detector (docs/BREAKOUT-METHOD.md §6–§7, D-021).
 *
 * Pure: given level snapshots, computes reliability, null calibration, holdout retention, stability, the
 * pre-registered success criteria, and renders a Markdown report. Seeded, so the report is reproducible.
 */
import { DEFAULT_MOMENTUM_MODEL } from "@/analytics/config";
import { createAnalyticsContext, momentum } from "@/analytics/engine";
import type { AflSnapshot } from "@/services/afl/types";
import { BREAKOUT_SETTINGS, BREAKOUT_VALIDATION, type BreakoutRole, type BreakoutSettings } from "./config";
import {
  addDays,
  blocks,
  detector,
  gamesThrough,
  gridNull,
  ratioVariance,
  rng,
  roleDataFromSnapshot,
  shrink,
  shuffledRoleData,
  sums,
  type BreakoutResult,
  type LevelModel,
  type LevelState,
  type PlayerSeries,
  type RoleData,
} from "./detector";

type Validation = typeof BREAKOUT_VALIDATION;

// ---------- small statistics helpers ----------

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export function pearson(xs: number[], ys: number[]) {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
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
const sample = <T>(xs: T[], rand: () => number) => xs.map(() => xs[Math.floor(rand() * xs.length)]);

// ---------- §6.1 reliability ----------

export interface Reliability {
  metric: string;
  players: number;
  splitHalfR: number;
  /** Shrinkage constant in the metric's denominator units, with a 90% bootstrap interval. */
  k: number;
  kLow: number;
  kHigh: number;
  /** Reliability of a recent block of nRecent opportunities. */
  atRecent: number;
  kept: boolean;
}

function kFrom(halves: { odd: number; even: number; n: number }[]) {
  const r = pearson(halves.map((h) => h.odd), halves.map((h) => h.even));
  const rel = (2 * r) / (1 + r);
  const n = mean(halves.map((h) => h.n));
  return { r, k: rel > 0 ? (n * (1 - rel)) / rel : Infinity };
}

export function reliability(d: RoleData, m: number, settings: BreakoutSettings, v: Validation, rand: () => number): Reliability {
  const halves: { odd: number; even: number; n: number }[] = [];
  let den = 0;
  let opp = 0;
  for (const s of d.players) {
    const totalOpp = s.opp.reduce((a, b) => a + b, 0);
    if (totalOpp < 2 * settings.nRecent) continue;
    let xo = 0, ao = 0, xe = 0, ae = 0;
    s.num[m].forEach((x, g) => {
      if (g % 2) { xo += x; ao += s.den[m][g]; } else { xe += x; ae += s.den[m][g]; }
    });
    if (ao <= 0 || ae <= 0) continue;
    halves.push({ odd: xo / ao, even: xe / ae, n: ao + ae });
    den += ao + ae;
    opp += totalOpp;
  }
  const def = d.metrics[m];
  if (halves.length < 20)
    return { metric: def.label, players: halves.length, splitHalfR: NaN, k: Infinity, kLow: NaN, kHigh: NaN, atRecent: 0, kept: false };
  const { r, k } = kFrom(halves);
  const boots: number[] = [];
  for (let b = 0; b < v.bootstrap; b++) boots.push(kFrom(sample(halves, rand)).k);
  const nRecentDen = settings.nRecent * (den / opp);
  const atRecent = Number.isFinite(k) ? nRecentDen / (nRecentDen + k) : 0;
  return {
    metric: def.label,
    players: halves.length,
    splitHalfR: r,
    k,
    kLow: quantile(boots, 0.05),
    kHigh: quantile(boots, 0.95),
    atRecent,
    kept: atRecent >= settings.minReliabilityAtRecent,
  };
}

export function levelModel(rel: Reliability[]): LevelModel | null {
  const metricIdx = rel.map((r, i) => (r.kept ? i : -1)).filter((i) => i >= 0);
  if (!metricIdx.length) return null;
  return { metricIdx, weights: metricIdx.map(() => 1 / metricIdx.length), k: rel.map((r) => r.k) };
}

// ---------- composites over arbitrary game ranges ----------

/** Composite standing (level SDs above the level mean at the state's date) of games [from, to). */
export function rangeComposite(d: RoleData, s: PlayerSeries, from: number, to: number, st: LevelState, model: LevelModel) {
  let c = 0;
  model.metricIdx.forEach((m, i) => {
    const b = sums(s.num[m], s.den[m], from, to);
    const sd = st.sd[m] > 0 ? st.sd[m] : Infinity;
    c += (model.weights[i] * d.metrics[m].direction * (shrink(b.x, b.a, st.mu[m], model.k[m]) - st.mu[m])) / sd;
  });
  return c;
}

const oppIn = (s: PlayerSeries, from: number, to: number) => {
  let n = 0;
  for (let g = from; g < to; g++) n += s.opp[g];
  return n;
};

/** Results stat of the recent block for the naive baseline: OPS (hitters, higher better) or −ERA (pitchers). */
function recentResults(role: BreakoutRole, s: PlayerSeries, from: number, to: number) {
  const t = s.res.slice(from, to).reduce((acc, r) => acc.map((v, i) => v + r[i]), s.res[0].map(() => 0));
  if (role === "hitter") {
    const [h, bb, hbp, ab, sf, tb] = t;
    const obpDen = ab + bb + hbp + sf;
    if (ab <= 0 || obpDen <= 0) return null;
    return (h + bb + hbp) / obpDen + tb / ab;
  }
  const [er, outs] = t;
  return outs > 0 ? -(er * 27) / outs : null;
}

// ---------- §6.3 holdout retention ----------

interface Outcome {
  id: string;
  earlier: number;
  recent: number;
  post: number | null;
  nEarlier: number;
}

export interface GroupRetention {
  selected: number;
  withPost: number;
  /** Σ(post − earlier) / Σ(recent − earlier): ratio of means (stable when single gains are small). */
  /** NaN when the group had (almost) no recent change to retain: mean recent gain below MIN_RECENT_GAIN. */
  retention: number;
  /** Mean post-cutoff gain over the earlier block (level SDs). */
  meanGain: number;
  meanRecentGain: number;
}

/** Below this mean recent gain (level SDs) a retention ratio is not meaningful (division by ~0). */
export const MIN_RECENT_GAIN = 0.1;

function retentionOf(group: Outcome[]): GroupRetention {
  const withPost = group.filter((o) => o.post !== null);
  const num = withPost.reduce((a, o) => a + ((o.post as number) - o.earlier), 0);
  const den = withPost.reduce((a, o) => a + (o.recent - o.earlier), 0);
  const meanRecentGain = withPost.length ? den / withPost.length : NaN;
  return {
    selected: group.length,
    withPost: withPost.length,
    retention: meanRecentGain >= MIN_RECENT_GAIN ? num / den : NaN,
    meanGain: withPost.length ? num / withPost.length : NaN,
    meanRecentGain,
  };
}

export interface CutoffResult {
  cutoff: string;
  qualified: number;
  flagged: number;
  watch: number;
  flaggedRetention: GroupRetention;
  /** Mean of (flagged gain − matched-control gain) and its 90% bootstrap interval. */
  controlDiff: { n: number; mean: number; low: number; high: number };
  momentumBaseline: GroupRetention;
  resultsBaseline: GroupRetention;
  promotedWithin: number;
  /** For the §6.5 review list. */
  flags: { id: string; onset: string | null; z: number; effect: number; standingPct: number; nRecent: number; nEarlier: number; metrics: BreakoutResult["eval"]["metrics"] }[];
  /** Flagged-vs-control differences kept for pooling across cutoffs. */
  diffs: number[];
  outcomes: { flagged: Outcome[]; momentum: Outcome[]; results: Outcome[] };
}

export interface HoldoutInputs {
  snapshot: AflSnapshot;
  /** Players with a completed game at a higher level, by date (for the promotion count). */
  higherLevelDates: Map<string, string[]>;
}

export function holdout(
  d: RoleData,
  model: LevelModel,
  det: ReturnType<typeof detector>,
  cutoff: string,
  inputs: HoldoutInputs,
  v: Validation,
  rand: () => number,
): CutoffResult {
  const results = det.evaluate(cutoff);
  const st = det.state(cutoff);
  const byId = new Map(d.players.map((s) => [s.id, s]));
  const outcome = (id: string): Outcome => {
    const s = byId.get(id) as PlayerSeries;
    const ev = (results.get(id) as BreakoutResult).eval;
    const cut = gamesThrough(s.dates, cutoff);
    const postN = oppIn(s, cut, s.dates.length);
    return {
      id,
      earlier: ev.earlier,
      recent: ev.standing,
      post: postN >= v.minPost ? rangeComposite(d, s, cut, s.dates.length, st, model) : null,
      nEarlier: ev.blocks.nEarlier,
    };
  };
  const all = [...results.keys()].map(outcome);
  const outById = new Map(all.map((o) => [o.id, o]));
  const flaggedIds = [...results].filter(([, r]) => r.status === "breakout").map(([id]) => id);
  const flagged = flaggedIds.map((id) => outById.get(id) as Outcome);
  const n = flagged.length;

  // Matched controls: unflagged, similar earlier composite and earlier sample, with post data.
  const unflagged = all.filter((o) => results.get(o.id)?.status !== "breakout" && o.post !== null);
  const diffs: number[] = [];
  for (const f of flagged) {
    if (f.post === null) continue;
    const ctl = unflagged.filter(
      (o) => Math.abs(o.earlier - f.earlier) <= v.controlCompositeTolerance && Math.abs(o.nEarlier - f.nEarlier) <= v.controlSampleTolerance * f.nEarlier,
    );
    if (!ctl.length) continue;
    diffs.push((f.post - f.earlier) - mean(ctl.map((o) => (o.post as number) - o.earlier)));
  }
  const boots: number[] = [];
  if (diffs.length) for (let b = 0; b < v.bootstrap; b++) boots.push(mean(sample(diffs, rand)));

  // Naive baselines with the same number of players.
  const ctx = createAnalyticsContext({ ...inputs.snapshot, games: inputs.snapshot.games.filter((g) => g.date <= cutoff) });
  const momentumTop = all
    .map((o) => ({ o, score: momentum(ctx, o.id, d.role, "30d", DEFAULT_MOMENTUM_MODEL).score }))
    .filter((x): x is { o: Outcome; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.o.id.localeCompare(b.o.id))
    .slice(0, n)
    .map((x) => x.o);
  const resultsTop = all
    .map((o) => {
      const b = (results.get(o.id) as BreakoutResult).eval.blocks;
      return { o, v: recentResults(d.role, byId.get(o.id) as PlayerSeries, b.rStart, b.end) };
    })
    .filter((x): x is { o: Outcome; v: number } => x.v !== null)
    .sort((a, b) => b.v - a.v || a.o.id.localeCompare(b.o.id))
    .slice(0, n)
    .map((x) => x.o);

  const until = addDays(cutoff, v.promotionDays);
  const promotedWithin = flaggedIds.filter((id) => (inputs.higherLevelDates.get(id) ?? []).some((dt) => dt > cutoff && dt <= until)).length;

  return {
    cutoff,
    qualified: st.qualified,
    flagged: n,
    watch: [...results.values()].filter((r) => r.status === "watch").length,
    flaggedRetention: retentionOf(flagged),
    controlDiff: { n: diffs.length, mean: mean(diffs), low: quantile(boots, 0.05), high: quantile(boots, 0.95) },
    momentumBaseline: retentionOf(momentumTop),
    resultsBaseline: retentionOf(resultsTop),
    promotedWithin,
    flags: flaggedIds.map((id) => {
      const r = results.get(id) as BreakoutResult;
      return { id, onset: r.onset, z: r.eval.z, effect: r.eval.effect, standingPct: r.eval.standingPct, nRecent: r.eval.blocks.nRecent, nEarlier: r.eval.blocks.nEarlier, metrics: r.eval.metrics };
    }),
    diffs,
    outcomes: { flagged, momentum: momentumTop, results: resultsTop },
  };
}

// ---------- §6.2 full-detector null, §6.4 churn ----------

export function nullFlags(
  d: RoleData,
  model: LevelModel,
  nullFor: (date: string) => Float64Array,
  dates: string[],
  runs: number,
  rand: () => number,
  settings: BreakoutSettings,
) {
  let flags = 0;
  let evaluations = 0;
  for (let r = 0; r < runs; r++)
    for (const date of dates) {
      const sh = shuffledRoleData(d, date, rand);
      const det = detector(sh, model, nullFor, settings);
      for (const res of det.evaluate(date).values()) if (res.status === "breakout") flags++;
      evaluations++;
    }
  return { runs, dates: dates.length, perDate: evaluations ? flags / evaluations : NaN };
}

export function churn(det: ReturnType<typeof detector>, dates: string[], churnDays: number) {
  const onSince = new Map<string, string>();
  let spells = 0;
  let short = 0;
  const last = dates[dates.length - 1];
  for (const date of dates) {
    const res = det.evaluate(date);
    for (const [id, r] of res) if (r.status === "breakout" && !onSince.has(id)) onSince.set(id, date);
    for (const [id, start] of [...onSince]) {
      if (res.get(id)?.status === "breakout") continue;
      onSince.delete(id);
      spells++;
      if (date <= addDays(start, churnDays)) short++;
    }
  }
  // Spells still on at the end count only when they already lasted longer than the churn window.
  for (const start of onSince.values()) if (addDays(start, churnDays) < last) spells++;
  return { spells, short, share: spells ? short / spells : NaN };
}

// ---------- ISO standard-error check and metric correlation ----------

export function isoSeCheck(d: RoleData, model: LevelModel, date: string, rand: () => number, v: Validation, settings: BreakoutSettings, max = 50) {
  const m = d.metrics.findIndex((x) => x.kind === "ratio");
  if (m < 0 || !model.metricIdx.includes(m)) return null;
  const ratios: number[] = [];
  for (const s of d.players) {
    if (ratios.length >= max) break;
    const b = blocks(s, gamesThrough(s.dates, date), settings);
    if (!b) continue;
    const lin = ratioVariance(sums(s.num[m], s.den[m], b.rStart, b.end));
    if (!lin) continue;
    const idx = Array.from({ length: b.end - b.rStart }, (_, i) => b.rStart + i);
    const boot: number[] = [];
    for (let k = 0; k < Math.min(v.bootstrap, 500); k++) {
      const pick = sample(idx, rand);
      const x = pick.reduce((a, g) => a + s.num[m][g], 0);
      const a = pick.reduce((acc, g) => acc + s.den[m][g], 0);
      if (a > 0) boot.push(x / a);
    }
    const bm = mean(boot);
    const bootSe = Math.sqrt(boot.reduce((acc, x) => acc + (x - bm) ** 2, 0) / (boot.length - 1));
    if (bootSe > 0) ratios.push(Math.sqrt(lin) / bootSe);
  }
  return ratios.length ? { players: ratios.length, medianRatio: quantile(ratios, 0.5) } : null;
}

// ---------- the whole validation ----------

export interface RoleValidation {
  level: string;
  role: BreakoutRole;
  reliability: Reliability[];
  model: LevelModel | null;
  cutoffs: CutoffResult[];
  pooled: { flaggedRetention: GroupRetention; momentum: GroupRetention; results: GroupRetention; controlDiff: { n: number; mean: number; low: number; high: number } } | null;
  nullCalibration: { runs: number; dates: number; perDate: number } | null;
  churn: { spells: number; short: number; share: number } | null;
  isoSe: { players: number; medianRatio: number } | null;
  criteria: { id: string; label: string; pass: boolean; value: string }[];
  pass: boolean;
  note?: string;
}

export interface ValidationOptions {
  nullRuns?: number;
  /** Evaluate churn every n-th completed date (1 = daily). */
  churnStep?: number;
  settings?: BreakoutSettings;
}

export function validateRole(
  level: string,
  snapshot: AflSnapshot,
  role: BreakoutRole,
  higherLevelDates: Map<string, string[]>,
  options: ValidationOptions = {},
  v: Validation = BREAKOUT_VALIDATION,
): RoleValidation {
  const settings = options.settings ?? BREAKOUT_SETTINGS;
  const rand = rng(v.seed ^ (role === "hitter" ? 1 : 2) ^ hash(level));
  const d = roleDataFromSnapshot(snapshot, role);
  const rel = d.metrics.map((_, m) => reliability(d, m, settings, v, rand));
  const model = levelModel(rel);
  const empty = (note: string): RoleValidation => ({
    level, role, reliability: rel, model, cutoffs: [], pooled: null, nullCalibration: null, churn: null, isoSe: null,
    criteria: [], pass: false, note,
  });
  if (!model) return empty("No metric is reliable enough at this level (§6.1); breakout detection is not available.");
  const nullFor = gridNull(d, model, v.seed ^ hash(level + role), settings);
  const det = detector(d, model, nullFor, settings);
  const year = snapshot.season.year;
  const cutoffDates = v.cutoffs.map((c) => `${year}-${c}`);
  const cutoffs = cutoffDates.map((c) => holdout(d, model, det, c, { snapshot, higherLevelDates }, v, rand));
  const pool = (key: "flagged" | "momentum" | "results") => retentionOf(cutoffs.flatMap((c) => c.outcomes[key]));
  const diffs = cutoffs.flatMap((c) => c.diffs);
  const boots: number[] = [];
  if (diffs.length) for (let b = 0; b < v.bootstrap; b++) boots.push(mean(sample(diffs, rand)));
  const pooled = {
    flaggedRetention: pool("flagged"),
    momentum: pool("momentum"),
    results: pool("results"),
    controlDiff: { n: diffs.length, mean: mean(diffs), low: quantile(boots, 0.05), high: quantile(boots, 0.95) },
  };
  const last = d.dates[d.dates.length - 1];
  const nullCalibration = nullFlags(d, model, nullFor, [...cutoffDates, last], options.nullRuns ?? v.nullRuns, rand, settings);
  const step = options.churnStep ?? 1;
  const churnDates = d.dates.filter((_, i) => i % step === 0);
  const ch = churn(det, churnDates, v.churnDays);
  const iso = isoSeCheck(d, model, last, rand, v, settings);

  const c = v.criteria;
  const fmt = (x: number, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : "n/a");
  const criteria = [
    { id: "null", label: `Null: ≤ ${c.maxNullFlagsPerDate} false flag per date`, pass: nullCalibration.perDate <= c.maxNullFlagsPerDate, value: fmt(nullCalibration.perDate) },
    { id: "retention", label: `Retention ≥ ${c.minRetention}`, pass: pooled.flaggedRetention.retention >= c.minRetention, value: fmt(pooled.flaggedRetention.retention) },
    { id: "controls", label: "Above matched controls (90% CI excludes 0)", pass: pooled.controlDiff.n > 0 && pooled.controlDiff.low > 0, value: `${fmt(pooled.controlDiff.mean)} [${fmt(pooled.controlDiff.low)}, ${fmt(pooled.controlDiff.high)}], n=${pooled.controlDiff.n}` },
    { id: "baselines", label: "Retention above both naive baselines", pass: beats(pooled.flaggedRetention, pooled.momentum) && beats(pooled.flaggedRetention, pooled.results), value: `${fmt(pooled.flaggedRetention.retention)} vs Momentum ${fmt(pooled.momentum.retention)}, results ${fmt(pooled.results.retention)} (post gain ${fmt(pooled.flaggedRetention.meanGain)} vs ${fmt(pooled.momentum.meanGain)}, ${fmt(pooled.results.meanGain)})` },
    { id: "churn", label: `Churn ≤ ${c.maxChurn * 100}%`, pass: ch.share <= c.maxChurn, value: `${Number.isFinite(ch.share) ? `${fmt(ch.share * 100, 0)}%` : "n/a"} (${ch.short}/${ch.spells})` },
    { id: "count", label: `≥ ${c.minFlagsPerCutoff} flags at every cutoff`, pass: cutoffs.every((x) => x.flagged >= c.minFlagsPerCutoff), value: cutoffs.map((x) => x.flagged).join(" / ") },
  ];
  return { level, role, reliability: rel, model, cutoffs, pooled, nullCalibration, churn: ch, isoSe: iso, criteria, pass: criteria.every((x) => x.pass) };
}

/**
 * Criterion 3. Retention is compared when both groups have one; when a baseline had no recent change to retain
 * (retention n/a), the flagged group must instead show the larger mean post-cutoff gain.
 */
export function beats(flagged: GroupRetention, baseline: GroupRetention) {
  if (!Number.isFinite(flagged.retention)) return false;
  if (Number.isFinite(baseline.retention)) return flagged.retention > baseline.retention;
  return Number.isFinite(flagged.meanGain) && (!Number.isFinite(baseline.meanGain) || flagged.meanGain > baseline.meanGain);
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------- report ----------

export function renderValidationReport(
  results: RoleValidation[],
  meta: { source: string; snapshotId?: string; names: Map<string, string>; nullRuns: number; churnStep: number; settings?: BreakoutSettings },
) {
  const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
  const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
  const rate = (label: string, x: number | null) => (x === null ? "—" : label === "ISO" ? x.toFixed(3).replace(/^0/, "") : pct(x));
  const out: string[] = [];
  out.push("# Breakout validation report (T-405)", "");
  out.push(`Method: docs/BREAKOUT-METHOD.md (approved D-021). Source: ${meta.source}${meta.snapshotId ? ` (snapshot ${meta.snapshotId.slice(0, 12)})` : ""}.`);
  const st = meta.settings ?? BREAKOUT_SETTINGS;
  const approved = st.statistic === BREAKOUT_SETTINGS.statistic && st.nRecent === BREAKOUT_SETTINGS.nRecent && st.nEarlier === BREAKOUT_SETTINGS.nEarlier;
  out.push(`Settings: ${approved ? "approved defaults" : "**NOT the approved configuration**"} (statistic ${st.statistic}, blocks ${st.nRecent}/${st.nEarlier}, q ${st.fdrQ}, standing ${st.standingPercentile * 100}th pct, persistence ${st.checkpointsRequired} of ${st.checkpoints}).`);
  out.push(`Seed ${BREAKOUT_VALIDATION.seed}; null runs per level ${meta.nullRuns}; churn evaluated every ${meta.churnStep === 1 ? "completed date" : `${meta.churnStep}th completed date`}.`, "");
  out.push("## Verdict (§7)", "", "| Level | Role | Result | Failed criteria |", "|---|---|---|---|");
  for (const r of results)
    out.push(`| ${r.level} | ${r.role} | ${r.pass ? "**pass**" : "fail"} | ${r.note ?? (r.criteria.filter((c) => !c.pass).map((c) => c.label).join("; ") || "—")} |`);
  out.push("", "A level/role that fails shows \"Breakout detection is not available at this level\". Thresholds are not loosened after seeing these results (§7).", "");
  for (const r of results) {
    out.push(`## ${r.level} — ${r.role}s`, "");
    out.push("### Reliability (§6.1)", "", "| Metric | Players | Split-half r | k (90% CI) | Reliability at 100 | Used |", "|---|---|---|---|---|---|");
    for (const x of r.reliability)
      out.push(`| ${x.metric} | ${x.players} | ${f(x.splitHalfR)} | ${f(x.k, 0)} (${f(x.kLow, 0)}–${f(x.kHigh, 0)}) | ${f(x.atRecent)} | ${x.kept ? "yes" : "no"} |`);
    out.push("");
    if (r.note) { out.push(r.note, ""); continue; }
    out.push("### Criteria (§7)", "", "| Criterion | Value | Pass |", "|---|---|---|");
    for (const c of r.criteria) out.push(`| ${c.label} | ${c.value} | ${c.pass ? "yes" : "no"} |`);
    out.push("", "### Holdout by cutoff (§6.3)", "", "| Cutoff | Qualified | Breakout | Watch | Retention (with post) | Flagged − controls (90% CI) | Momentum 30D | Recent results | Promoted ≤45d |", "|---|---|---|---|---|---|---|---|---|");
    for (const c of r.cutoffs)
      out.push(`| ${c.cutoff} | ${c.qualified} | ${c.flagged} | ${c.watch} | ${f(c.flaggedRetention.retention)} (${c.flaggedRetention.withPost}) | ${f(c.controlDiff.mean)} [${f(c.controlDiff.low)}, ${f(c.controlDiff.high)}] n=${c.controlDiff.n} | ${f(c.momentumBaseline.retention)} (${c.momentumBaseline.withPost}) | ${f(c.resultsBaseline.retention)} (${c.resultsBaseline.withPost}) | ${c.promotedWithin} |`);
    out.push("");
    if (r.nullCalibration) out.push(`Null calibration (§6.2): ${f(r.nullCalibration.perDate, 3)} flags per date on shuffled data (${r.nullCalibration.runs} runs × ${r.nullCalibration.dates} dates).`);
    if (r.churn) out.push(`Churn (§6.4): ${r.churn.short} of ${r.churn.spells} flag spells ended within ${BREAKOUT_VALIDATION.churnDays} days.`);
    if (r.isoSe) out.push(`ISO standard error: linearized / bootstrap median ratio ${f(r.isoSe.medianRatio)} over ${r.isoSe.players} players.`);
    const review = r.cutoffs[1] ?? r.cutoffs[0];
    if (review?.flags.length) {
      out.push("", `### Flags at ${review.cutoff} for review (§6.5)`, "", "| Player | Onset | Recent / earlier | Effect (SD) | Standing pct | Changes |", "|---|---|---|---|---|---|");
      for (const x of review.flags)
        out.push(`| ${meta.names.get(x.id) ?? x.id} | ${x.onset ?? "—"} | ${x.nRecent} / ${x.nEarlier} | ${f(x.effect)} | ${f(x.standingPct * 100, 0)} | ${x.metrics.map((m) => `${m.label} ${rate(m.label, m.rawE)} → ${rate(m.label, m.rawR)}`).join(", ")} |`);
    }
    out.push("");
  }
  out.push("## Notes", "");
  out.push("- Shrinkage constants k come from the full season at each level (a population reliability constant); the detector at each cutoff otherwise uses only games on or before the cutoff.");
  out.push("- ISO's standard error uses the linearized game-cluster ratio variance instead of a per-player bootstrap (§4.3), for speed; the ratio above checks the two agree.");
  out.push("- The permutation null used for p-values is rebuilt every 7 days from the data available on that date (§6.2).");
  out.push("- Pitcher \"recent results\" baseline uses recent-block ERA (pitchers have no OPS).");
  out.push(`- Retention is a ratio of sums, Σ(post − earlier) / Σ(recent − earlier); it is n/a when a group's mean recent gain is below ${MIN_RECENT_GAIN} SD (nothing to retain). Criterion 3 then compares mean post-cutoff gain instead.`);
  return out.join("\n") + "\n";
}

export type { LevelState };
