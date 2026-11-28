/** Player similarity and its validation (docs/SIMILARITY-METHOD.md, D-024, T-406). Synthetic data only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SIMILARITY_SETTINGS } from "../src/analytics/similarity/config";
import {
  closestAndFurthest,
  distance,
  invert,
  positionGroup,
  pairParts,
  population,
  reliabilityAt,
  roleGamesFromSnapshot,
  shrink,
  similarityScore,
  similarPlayers,
  splitHalfReliability,
  totals,
  type Population,
  type Profile,
  type Totals,
} from "../src/analytics/similarity/profiles";
import { baselineValue, validateRole } from "../src/analytics/similarity/validate";
import { syntheticSeason } from "./similarity-synthetic";

const profile = (id: string, z: number[], ageZ: number | null, n = 200, rel = z.map(() => 1), group = "IF"): Profile => ({
  id, group, n, games: 50, den: z.map(() => n), raw: z, shrunk: z, z, rel, age: ageZ, ageZ,
  totals: { id, birthDate: null, group, games: 50, opp: n, num: [], den: [], base: [] },
});

test("shrinkage and reliability match hand calculations", () => {
  assert.equal(shrink(20, 100, 0.25, 100), 0.225);
  assert.equal(shrink(20, 100, 0.25, Infinity), 0.25, "no reliability: the level mean");
  assert.equal(reliabilityAt(100, 100), 0.5);
  assert.equal(reliabilityAt(100, Infinity), 0);
});

test("distance is the reliability-weighted Euclidean mean and the score is 100·exp(−D²/2)", () => {
  const a = profile("a", [1, 0], 0);
  const b = profile("b", [0, 0], 0);
  const parts = pairParts(a, b);
  assert.equal(parts.length, 3, "two dimensions plus age");
  assert.ok(Math.abs(distance(parts) - Math.sqrt(1 / 3)) < 1e-12);
  assert.ok(Math.abs(similarityScore(1) - 100 * Math.exp(-0.5)) < 1e-12);
  assert.equal(similarityScore(0), 100);
  // Weights √(rel_a · rel_b): a noisy dimension counts for little.
  const c = profile("c", [1, 0], null, 200, [0.04, 1]);
  const w = pairParts(c, b);
  assert.equal(w.length, 2, "age unknown for one player: dimension dropped");
  assert.ok(Math.abs(w[0].w - 0.2) < 1e-12);
  assert.ok(Math.abs(distance(w) - Math.sqrt(0.2 / 1.2)) < 1e-12);
  assert.equal(pairParts(a, b, { ...SIMILARITY_SETTINGS, useAge: false }).length, 2);
});

const pop = (profiles: Profile[]): Population => {
  const groupSizes = new Map<string, number>();
  for (const p of profiles) groupSizes.set(p.group, (groupSizes.get(p.group) ?? 0) + 1);
  return { role: "hitter", asOf: "2026-09-01", dims: [], ageMedian: 22, groupSizes, ageMean: 0, ageSd: 1, profiles, byId: new Map(profiles.map((p) => [p.id, p])) };
};
const ungrouped = { ...SIMILARITY_SETTINGS, positionGroups: false };

test("lists exclude the player and break ties by sample size, then id", () => {
  const me = profile("m", [0, 0], 0);
  const p = pop([me, profile("b", [1, 0], 0, 150), profile("a", [1, 0], 0, 150), profile("c", [1, 0], 0, 300), profile("d", [0.1, 0], 0)]);
  assert.deepEqual(similarPlayers(p, "m", ungrouped).map((n) => n.id), ["d", "c", "a", "b"]);
  assert.deepEqual(similarPlayers(p, "m", ungrouped, { pool: new Set(["a", "b"]) }).map((n) => n.id), ["a", "b"]);
  const ex = closestAndFurthest(pairParts(me, profile("x", [2, 0.1], 0.5)), "hitter", 1);
  assert.deepEqual(ex, { closest: ["BB%"], furthest: ["K%"] });
});

test("D-026: hitters are compared only within their position group, and small groups get no list", () => {
  const z = [0, 0];
  const catchers = Array.from({ length: 20 }, (_, i) => profile(`c${String(i).padStart(2, "0")}`, [i / 10, 0], 0, 200, undefined, "C"));
  const infield = Array.from({ length: 20 }, (_, i) => profile(`i${String(i).padStart(2, "0")}`, z, 0, 200, undefined, "IF"));
  const dh = [profile("dh1", z, 0, 200, undefined, "DH"), profile("dh2", z, 0, 200, undefined, "DH")];
  const p = pop([...catchers, ...infield, ...dh]);
  const list = similarPlayers(p, "c00");
  assert.equal(list.length, 5);
  assert.ok(list.every((n) => n.id.startsWith("c")), "identical infielders are not offered to a catcher");
  assert.deepEqual(similarPlayers(p, "dh1"), [], "group below minGroupSize: not enough similar players");
  assert.ok(similarPlayers(p, "c00", ungrouped).some((n) => !n.id.startsWith("c")), "without the rule, positions mix");
  assert.equal(positionGroup("SS"), "IF");
  assert.equal(positionGroup("CF"), "OF");
  assert.equal(positionGroup("DH"), "DH");
  const pitchers = { ...p, role: "pitcher" as const };
  assert.equal(similarPlayers(pitchers, "dh1").length, 5, "pitchers are not grouped");
});

test("population: level mean is a ratio of sums, qualification and age vs the D-020 median", () => {
  const t = (id: string, opp: number, k: number, birthDate: string | null): Totals => ({
    id, birthDate, group: "IF", games: 30, opp, num: [k, 0, 0, 0, 0], den: [opp, opp, opp, opp, opp], base: [],
  });
  const all = [t("a", 200, 40, "2004-09-01"), t("b", 50, 20, "2000-09-01"), t("c", 150, 30, null)];
  const pop = population("hitter", all, [100, 100, 100, 100, 100], "2026-09-01", { ...SIMILARITY_SETTINGS, minAgeSample: 2 });
  assert.ok(Math.abs(pop.dims[0].mu - 90 / 400) < 1e-12);
  assert.deepEqual(pop.profiles.map((p) => p.id), ["a", "c"], "b below minSample");
  assert.ok(Math.abs(pop.ageMedian! - 24) < 0.01, "median over everyone with a line, qualified or not");
  assert.ok(Math.abs(pop.byId.get("a")!.age! + 2) < 0.01);
  assert.equal(pop.byId.get("c")!.age, null);
});

test("only completed games count (read-model rule)", () => {
  const s = syntheticSeason({ hitters: 3, pitchers: 0, days: 10 });
  const open = { ...s, games: s.games.map((g, i) => (i === 0 ? { ...g, boxscoreComplete: false } : g)) };
  const games = (x: typeof s) => roleGamesFromSnapshot(x, "hitter").players.reduce((a, p) => a + p.dates.length, 0);
  assert.ok(games(open) < games(s));
});

test("split-half reliability is high for a stable rate and the OPS baseline matches a hand calculation", () => {
  const d = roleGamesFromSnapshot(syntheticSeason({ hitters: 120, pitchers: 0, seed: 3 }), "hitter");
  const r = splitHalfReliability(d, 0, () => true);
  assert.ok(r.splitHalfR > 0.5 && Number.isFinite(r.k), `K% r ${r.splitHalfR}`);
  const tt: Totals = { id: "x", birthDate: null, group: "IF", games: 1, opp: 10, num: [], den: [], base: [3, 1, 0, 9, 0, 5, 10] };
  assert.ok(Math.abs(baselineValue("hitter", tt)! - (4 / 10 + 5 / 9)) < 1e-12);
  assert.equal(totals(d.players[0], () => false).opp, 0);
});

test("a small symmetric matrix inverts", () => {
  const inv = invert([[2, 1], [1, 2]])!;
  assert.ok(Math.abs(inv[0][0] - 2 / 3) < 1e-12 && Math.abs(inv[0][1] + 1 / 3) < 1e-12);
  assert.equal(invert([[1, 1], [1, 1]]), null);
});

test("synthetic check: real archetypes pass stability and holdout, noise-only data fails both", () => {
  const real = validateRole("Test", syntheticSeason({ hitters: 150, pitchers: 0, seed: 5 }), "hitter");
  const noise = validateRole("Test", syntheticSeason({ hitters: 150, pitchers: 0, seed: 5, mode: "null" }), "hitter");
  const pass = (r: typeof real, id: string) => r.criteria.find((c) => c.id === id)!.pass;
  assert.equal(pass(real, "1"), true, real.criteria[0].detail);
  assert.equal(pass(real, "2"), true, real.criteria[1].detail);
  assert.equal(pass(noise, "1"), false, noise.criteria[0].detail);
  assert.equal(pass(noise, "2"), false, noise.criteria[1].detail);
  assert.equal(pass(real, "3"), null, "face validity is a human review");
});

test("the validation is deterministic", () => {
  const s = syntheticSeason({ hitters: 0, pitchers: 90, seed: 2 });
  const a = validateRole("Test", s, "pitcher");
  const b = validateRole("Test", s, "pitcher");
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
