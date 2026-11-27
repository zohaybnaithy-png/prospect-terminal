/** Breakout detector and validation (docs/BREAKOUT-METHOD.md, D-021, T-405). Synthetic data only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BREAKOUT_METRICS, BREAKOUT_SETTINGS } from "../src/analytics/breakout/config";
import {
  benjaminiHochberg,
  blocks,
  compositeZ,
  detector,
  empiricalP,
  gamesThrough,
  gridNull,
  metricZ,
  ratioVariance,
  rng,
  roleDataFromSnapshot,
  shrink,
  shuffledSeries,
  sums,
  type PlayerSeries,
} from "../src/analytics/breakout/detector";
import { beats, churn, nullFlags, validateRole } from "../src/analytics/breakout/validate";
import { syntheticSeason } from "./breakout-synthetic";

const series = (opp: number[], dates?: string[]): PlayerSeries => ({
  id: "p",
  dates: dates ?? opp.map((_, i) => `2026-05-${String(i + 1).padStart(2, "0")}`),
  opp,
  num: [opp.map(() => 1)],
  den: [opp],
  res: opp.map(() => [0, 0]),
});

test("blocks take whole games from the end and need both minimums", () => {
  const s = series([30, 30, 30, 30, 30, 30, 30, 30]);
  const b = blocks(s, 8, { ...BREAKOUT_SETTINGS, nRecent: 100, nEarlier: 100 });
  assert.deepEqual(b, { rStart: 4, end: 8, nRecent: 120, nEarlier: 120 });
  assert.equal(blocks(s, 6, { ...BREAKOUT_SETTINGS, nRecent: 100, nEarlier: 100 }), null, "earlier block below 100");
  assert.equal(blocks(series([40, 40]), 2, BREAKOUT_SETTINGS), null, "recent block below 100");
});

test("gamesThrough counts games on or before a date", () => {
  const d = ["2026-05-01", "2026-05-01", "2026-05-03"];
  assert.equal(gamesThrough(d, "2026-04-30"), 0);
  assert.equal(gamesThrough(d, "2026-05-01"), 2);
  assert.equal(gamesThrough(d, "2026-05-02"), 2);
  assert.equal(gamesThrough(d, "2026-06-01"), 3);
});

test("shrinkage and the binomial z match hand calculations", () => {
  assert.equal(shrink(20, 100, 0.25, 100), 0.225);
  const k = BREAKOUT_METRICS.hitter[0]; // K%, lower is better
  const r = { x: 15, a: 100, xx: 0, xa: 0, aa: 0, m: 25 };
  const e = { x: 60, a: 200, xx: 0, xa: 0, aa: 0, m: 50 };
  const mz = metricZ(k, r, e, 0.25, 100);
  const shR = (15 + 25) / 200;
  const shE = (60 + 25) / 300;
  const p = 75 / 300;
  const se = Math.sqrt(p * (1 - p) * (1 / 100 + 1 / 200));
  assert.ok(Math.abs(mz.z - -(shR - shE) / se) < 1e-12);
  assert.ok(mz.z > 0, "a lower K% is an improvement");
});

test("the ratio variance is the game-clustered linearized variance", () => {
  const num = [1, 0, 2, 0];
  const den = [4, 3, 4, 4];
  const b = sums(num, den, 0, 4);
  const r = 3 / 15;
  const ss = num.reduce((a, x, g) => a + (x - r * den[g]) ** 2, 0);
  assert.ok(Math.abs((ratioVariance(b) as number) - ((4 / 3) * ss) / 225) < 1e-12);
  assert.equal(ratioVariance(sums([1], [4], 0, 1)), null, "one game has no variance estimate");
});

test("composite z of equal weights is the scaled sum", () => {
  assert.ok(Math.abs(compositeZ([1, 2], [0.5, 0.5]) - 1.5 / Math.sqrt(0.5)) < 1e-12);
});

test("Benjamini–Hochberg passes the step-up set", () => {
  // m = 5, q = 0.1: thresholds 0.02, 0.04, 0.06, 0.08, 0.10 → the largest passing rank is 3.
  assert.deepEqual([...benjaminiHochberg([0.01, 0.5, 0.03, 0.055, 0.2], 0.1)].sort(), [0, 2, 3]);
  assert.equal(benjaminiHochberg([0.5, 0.6], 0.1).size, 0);
});

test("empirical p-values are upper-tail with the +1 correction", () => {
  const nul = Float64Array.from([-1, 0, 1, 2]);
  assert.equal(empiricalP(1.5, nul), 2 / 5);
  assert.equal(empiricalP(5, nul), 1 / 5);
  assert.equal(empiricalP(-5, nul), 5 / 5);
});

test("shuffling permutes only games on or before the date and keeps dates in place", () => {
  const s = series([1, 2, 3, 4, 5, 6]);
  const sh = shuffledSeries(s, "2026-05-04", rng(1));
  assert.deepEqual(sh.dates, s.dates);
  assert.deepEqual([...sh.opp.slice(0, 4)].sort(), [1, 2, 3, 4]);
  assert.deepEqual(sh.opp.slice(4), [5, 6]);
});

test("only completed games count (read-model rule)", () => {
  const { snapshot } = syntheticSeason({ hitters: 3, pitchers: 0, days: 10 });
  const open = { ...snapshot, games: snapshot.games.map((g, i) => (i === 0 ? { ...g, boxscoreComplete: false } : g)) };
  const full = roleDataFromSnapshot(snapshot, "hitter");
  const part = roleDataFromSnapshot(open, "hitter");
  const games = (d: typeof full) => d.players.reduce((a, s) => a + s.dates.length, 0);
  assert.ok(games(part) < games(full));
  assert.ok(!part.dates.includes(snapshot.games[0].date));
});

test("large planted changes are found, precisely, and shuffled data stays quiet", () => {
  // Deliberately large changes: this checks correctness, not the method's power at realistic effect sizes.
  const { snapshot, planted } = syntheticSeason({ hitters: 0, pitchers: 160, seed: 5, breakoutShare: 0.25, effect: 2 });
  const d = roleDataFromSnapshot(snapshot, "pitcher");
  const model = { metricIdx: [0, 1], weights: [0.5, 0.5], k: [80, 250] };
  const nullFor = gridNull(d, model, 9);
  const det = detector(d, model, nullFor);
  const last = "2026-08-15";
  const flagged = [...det.evaluate(last)].filter(([, r]) => r.status === "breakout").map(([id]) => id);
  assert.ok(flagged.length >= 5, `found ${flagged.length}`);
  const truePositives = flagged.filter((id) => planted.has(id)).length;
  assert.ok(truePositives / flagged.length >= 0.8, `precision ${truePositives}/${flagged.length}`);
  for (const id of flagged) {
    const r = det.evaluate(last).get(id)!;
    assert.ok(r.onset && r.onset <= last && r.checkpointsMet >= 2);
  }
  const quiet = nullFlags(d, model, nullFor, [last], 5, rng(3), BREAKOUT_SETTINGS);
  assert.ok(quiet.perDate <= 1, `null flags per date ${quiet.perDate}`);
});

test("the validation is deterministic", () => {
  const { snapshot } = syntheticSeason({ hitters: 60, pitchers: 0, seed: 2 });
  const a = validateRole("Test", snapshot, "hitter", new Map(), { nullRuns: 2, churnStep: 7 });
  const b = validateRole("Test", snapshot, "hitter", new Map(), { nullRuns: 2, churnStep: 7 });
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.criteria.length, 6);
});

test("criterion 3 compares retention, or post gain when a baseline had nothing to retain", () => {
  const g = (retention: number, meanGain: number) => ({ selected: 10, withPost: 10, retention, meanGain, meanRecentGain: 1 });
  assert.equal(beats(g(0.6, 0.5), g(0.4, 0.9)), true);
  assert.equal(beats(g(0.6, 0.5), g(0.7, 0.1)), false);
  assert.equal(beats(g(0.6, 0.5), g(NaN, 0.2)), true);
  assert.equal(beats(g(0.6, 0.1), g(NaN, 0.2)), false);
  assert.equal(beats(g(NaN, 0.5), g(0.1, 0.1)), false, "no flagged retention never passes");
});

test("churn counts flag spells that end within the window", () => {
  const status = new Map<string, string[]>([
    ["a", ["2026-06-01", "2026-06-02"]], // on 2 days → churn
    ["b", ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-20", "2026-06-25", "2026-06-30"]],
  ]);
  const dates = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-20", "2026-06-25", "2026-06-30", "2026-07-30"];
  const fake = {
    state: () => { throw new Error("unused"); },
    evaluate: (date: string) =>
      new Map([...status].map(([id, on]) => [id, { status: on.includes(date) ? "breakout" : "none" }] as const)),
  } as unknown as ReturnType<typeof detector>;
  const c = churn(fake, dates, 14);
  assert.deepEqual(c, { spells: 2, short: 1, share: 0.5 });
});
