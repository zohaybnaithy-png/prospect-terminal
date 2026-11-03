import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  COMPONENT_METRICS,
  COMPONENTS_BY_ROLE,
  MODEL_IDS,
  MOMENTUM_BANDS,
  MOMENTUM_MODELS,
  MOMENTUM_SETTINGS,
  PERCENTILE_CATEGORIES,
  MAP_PERFORMANCE_METRICS,
  WHAT_CHANGED_METRICS,
  KEY_METRIC,
  DEFAULT_MOMENTUM_MODEL,
  PERSISTENCE_LABELS,
  persistenceLabel,
  effectiveSample,
  sampleDistribution,
  type MomentumSettings,
  addDays,
  buildDataset,
  changeSnapshot,
  clamp,
  combineComponents,
  compareModels,
  comparisonRanges,
  componentChanges,
  confidenceLevel,
  createAnalyticsContext,
  daysBetween,
  drivers,
  explainMomentum,
  fingerprint,
  formatMetric,
  formatMetricChange,
  mean,
  metricChange,
  metricDefinition,
  metricValue,
  momentum,
  momentumBand,
  normalizationScales,
  opportunities,
  percentileRank,
  performanceMap,
  playerMomentumByWindow,
  playerRoles,
  playerTimeline,
  quadrantOf,
  reliability,
  risersAndFallers,
  rolePopulation,
  sampleInRange,
  spearman,
  standardDeviation,
  trendPersistence,
  zToScore,
  type Checkpoint,
  type HitterSample,
} from "../src/analytics";
import { aggregateBatting, aggregatePitching } from "../src/statistics/aggregate";
import { buildPlayerRows } from "../src/services/afl/read-model";
import {
  IDS,
  STRONG,
  WEAK,
  bl,
  dayDate,
  pl,
  syntheticSnapshot,
  trajectorySnapshot,
  u,
} from "./analytics-test-support";

const S = MOMENTUM_SETTINGS;
const withSettings = (patch: (s: MomentumSettings) => void): MomentumSettings => {
  const s = structuredClone(S);
  patch(s);
  return s;
};

describe("configuration", () => {
  test("every candidate model's weights sum to 1 per role and cover every component", () => {
    for (const id of MODEL_IDS) {
      const m = MOMENTUM_MODELS[id];
      for (const role of ["hitter", "pitcher"] as const) {
        const w = m[role] as Record<string, number>;
        assert.deepEqual(Object.keys(w).sort(), [...COMPONENTS_BY_ROLE[role]].sort());
        assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9, `${id} ${role}`);
        assert.ok(Object.values(w).every((x) => x >= 0));
      }
    }
    assert.equal(DEFAULT_MOMENTUM_MODEL, "balanced", "Balanced is the approved V1 model");
  });

  test("candidate models genuinely differ", () => {
    const h = MODEL_IDS.map((id) => JSON.stringify(MOMENTUM_MODELS[id].hitter));
    const p = MODEL_IDS.map((id) => JSON.stringify(MOMENTUM_MODELS[id].pitcher));
    assert.equal(new Set(h).size, MODEL_IDS.length);
    assert.equal(new Set(p).size, MODEL_IDS.length);
    // Pitcher candidates must favor skill indicators over ERA except the production-heavy one.
    assert.ok(MOMENTUM_MODELS["skills-heavy"].pitcher.runPrevention < MOMENTUM_MODELS["skills-heavy"].pitcher.strikeouts);
    assert.ok(MOMENTUM_MODELS.balanced.pitcher.runPrevention <= MOMENTUM_MODELS.balanced.pitcher.strikeouts);
  });

  test("every referenced metric exists and belongs to the right role", () => {
    for (const role of ["hitter", "pitcher"] as const) {
      for (const c of COMPONENTS_BY_ROLE[role])
        for (const { metric } of COMPONENT_METRICS[c]) assert.equal(metricDefinition(metric).role, role);
      for (const cat of PERCENTILE_CATEGORIES[role])
        for (const metric of cat.metrics) assert.equal(metricDefinition(metric).role, role);
      for (const metric of [...MAP_PERFORMANCE_METRICS[role], ...WHAT_CHANGED_METRICS[role], KEY_METRIC[role]])
        assert.equal(metricDefinition(metric).role, role);
    }
    assert.throws(() => metricDefinition("exitVelocity"), /Unknown analytics metric/);
  });

  test("bands are ordered and cover the documented ranges", () => {
    for (let i = 1; i < MOMENTUM_BANDS.length; i++) assert.ok(MOMENTUM_BANDS[i].min < MOMENTUM_BANDS[i - 1].min);
    const cases: [number, string][] = [
      [100, "extreme-surge"], [75, "extreme-surge"], [74, "strong-up"], [40, "strong-up"],
      [39, "trending-up"], [15, "trending-up"], [14, "stable"], [0, "stable"], [-14, "stable"],
      [-15, "trending-down"], [-39, "trending-down"], [-40, "significant-slump"], [-74, "significant-slump"],
      [-75, "extreme-decline"], [-100, "extreme-decline"], [14.4, "stable"], [-14.4, "stable"],
    ];
    for (const [score, id] of cases) assert.equal(momentumBand(score).id, id, String(score));
  });
});

describe("numeric helpers", () => {
  test("empty and degenerate inputs never produce NaN", () => {
    assert.equal(mean([]), null);
    assert.equal(standardDeviation([]), null);
    assert.equal(standardDeviation([1]), null);
    assert.equal(standardDeviation([2, 2, 2]), 0);
    assert.equal(mean([1, NaN, 3]), 2);
    assert.equal(percentileRank(1, []), null);
    assert.equal(percentileRank(NaN, [1, 2]), null);
    assert.equal(clamp(5, -3, 3), 3);
    assert.equal(clamp(-5, -3, 3), -3);
  });

  test("standard deviation is the sample (n − 1) estimate", () => {
    assert.ok(Math.abs(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])! - 2.138089935) < 1e-6);
  });

  test("percentile rank uses mid-ranks and honors direction", () => {
    const pop = [10, 20, 30, 40];
    assert.equal(percentileRank(40, pop), 87.5);
    assert.equal(percentileRank(10, pop), 12.5);
    assert.equal(percentileRank(10, pop, -1), 87.5); // lower is better
    assert.equal(percentileRank(25, pop), 50);
    assert.equal(percentileRank(5, [5, 5, 5]), 50);
  });

  test("date helpers", () => {
    assert.equal(addDays("2026-10-31", 1), "2026-11-01");
    assert.equal(addDays("2026-11-01", -7), "2026-10-25");
    assert.equal(daysBetween("2026-10-06", "2026-11-01"), 26);
  });

  test("Spearman rank correlation", () => {
    assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
    assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
    assert.equal(spearman([1, 2], [1, 2]), null);
    assert.equal(spearman([1, 1, 1], [1, 2, 3]), null);
  });
});

describe("metrics", () => {
  const b = aggregateBatting([bl(4, 4, 2, { hr: 1, k: 1 }), bl(4, 3, 1, { d: 1, bb: 1 })]);
  test("hitter metrics are derived from summed counts", () => {
    // 3 H, 1 2B, 1 HR in 7 AB → SLG 7/7, AVG 3/7, ISO 4/7
    assert.ok(Math.abs(metricValue("iso", b)! - 4 / 7) < 1e-12);
    assert.equal(metricValue("hitterKPct", b), 12.5);
    assert.equal(metricValue("hitterBbPct", b), 12.5);
    assert.equal(metricValue("hrPct", b), 12.5);
    assert.equal(metricValue("bbPerK", b), 1);
  });

  test("division by zero yields null, not 0 or Infinity", () => {
    const zero = aggregateBatting([bl(0, 0, 0)]);
    for (const id of ["ops", "iso", "hitterKPct", "hitterBbPct", "hrPct", "bbPerK", "avg"])
      assert.equal(metricValue(id, zero), null, id);
    const noOuts = aggregatePitching([pl(0, 3, { bb: 2, h: 1 })]);
    assert.equal(metricValue("k9", noOuts), null);
    assert.equal(metricValue("bb9", noOuts), null);
    assert.equal(metricValue("era", noOuts), null);
    assert.equal(metricValue("whip", noOuts), null);
    assert.ok(Math.abs(metricValue("pitcherBbPct", noOuts)! - 200 / 3) < 1e-9);
    const empty = aggregatePitching([pl(0, 0)]);
    assert.equal(metricValue("kMinusBbPct", empty), null);
    assert.equal(metricValue("ops", null), null);
    assert.equal(opportunities("hitter", null), 0);
  });

  test("pitcher rate metrics", () => {
    const p = aggregatePitching([pl(9, 12, { h: 2, er: 1, bb: 1, k: 6 })]);
    assert.equal(metricValue("k9", p), 18);
    assert.equal(metricValue("bb9", p), 3);
    assert.equal(metricValue("kMinusBbPct", p), 50 - 100 / 12);
  });

  test("formatting", () => {
    assert.equal(formatMetric("ops", 0.904), ".904");
    assert.equal(formatMetric("ops", 1.104), "1.104");
    assert.equal(formatMetric("hitterKPct", 21.44), "21.4%");
    assert.equal(formatMetric("era", null), "—");
    assert.equal(formatMetricChange("ops", 0.193), "+.193");
    assert.equal(formatMetricChange("hitterKPct", -6.7), "−6.7");
    assert.equal(formatMetricChange("whip", 0), "±0.00");
    assert.equal(formatMetricChange("ops", null), "—");
  });
});

describe("normalized component changes", () => {
  const scales = {
    ops: { scale: 0.1, n: 20, source: "population" as const },
    iso: { scale: 0.05, n: 20, source: "population" as const },
    hitterKPct: { scale: 5, n: 20, source: "population" as const },
    hitterBbPct: { scale: 0.0, n: 20, source: "population" as const },
  };
  const before = aggregateBatting(Array(6).fill(WEAK[0]));
  const after = aggregateBatting(Array(6).fill(STRONG[1]));

  test("improvement is positive regardless of the metric's direction", () => {
    const k = metricChange("hitterKPct", before, after, scales, S);
    assert.ok(k.delta! < 0, "K% fell");
    assert.ok(k.z! > 0, "falling K% is an improvement");
    const ops = metricChange("ops", before, after, scales, S);
    assert.ok(ops.delta! > 0 && ops.z! > 0);
    const reverse = metricChange("ops", after, before, scales, S);
    assert.ok(reverse.z! < 0);
  });

  test("standardization divides by the population scale and clamps", () => {
    const ops = metricChange("ops", before, after, scales, S);
    assert.equal(ops.z, clamp(ops.delta! / 0.1, -S.scoring.zClamp, S.scoring.zClamp));
    assert.ok(Math.abs(ops.z!) <= S.scoring.zClamp);
  });

  test("a zero population scale falls back to the metric floor (no division by zero)", () => {
    const bb = metricChange("hitterBbPct", before, aggregateBatting([bl(4, 3, 0, { bb: 1 })]), scales, S);
    assert.equal(bb.scale, metricDefinition("hitterBbPct").minScale);
    assert.ok(Number.isFinite(bb.z!));
  });

  test("missing values produce null components, not zeros", () => {
    const zero = aggregateBatting([bl(0, 0, 0)]);
    const parts = componentChanges("hitter", zero, after, scales, S);
    assert.ok(parts.every((p) => p.z === null));
    const none = componentChanges("hitter", null, after, scales, S);
    assert.ok(none.every((p) => p.z === null));
  });

  test("weights renormalize over available components", () => {
    const changes = [
      { component: "production" as const, z: 1, metrics: [] },
      { component: "power" as const, z: null, metrics: [] },
      { component: "contact" as const, z: -1, metrics: [] },
      { component: "discipline" as const, z: null, metrics: [] },
    ];
    const r = combineComponents("hitter", changes, MOMENTUM_MODELS.balanced);
    assert.equal(r.z, 0);
    assert.deepEqual(r.contributions.map((c) => c.weight), [0.5, 0.5]);
    const prod = combineComponents("hitter", changes, MOMENTUM_MODELS["production-heavy"]);
    // 0.55 vs 0.125 renormalized → production dominates
    assert.ok(prod.z! > 0.6);
    const empty = combineComponents("hitter", changes.map((c) => ({ ...c, z: null })), MOMENTUM_MODELS.balanced);
    assert.equal(empty.z, null);
    assert.deepEqual(empty.contributions, []);
  });

  test("within-component metric weights apply (pitcher strikeouts = K% and K/9)", () => {
    const pScales = Object.fromEntries(
      ["pitcherKPct", "k9", "pitcherBbPct", "bb9", "whip", "era"].map((m) => [m, { scale: metricDefinition(m).fallbackScale, n: 0, source: "fallback" as const }]),
    );
    const early = aggregatePitching([pl(6, 10, { h: 3, er: 2, bb: 2, k: 1 })]);
    const late = aggregatePitching([pl(6, 7, { h: 1, bb: 0, k: 4 })]);
    const parts = componentChanges("pitcher", early, late, pScales, S);
    const so = parts.find((p) => p.component === "strikeouts")!;
    const [kp, k9] = so.metrics;
    assert.ok(Math.abs(so.z! - (0.7 * kp.z! + 0.3 * k9.z!)) < 1e-12);
    assert.ok(parts.every((p) => p.z! > 0), "every pitcher component improved");
  });
});

describe("sample-size reliability", () => {
  test("zero opportunities on either side give zero reliability", () => {
    assert.equal(reliability("hitter", 0, 100, S), 0);
    assert.equal(reliability("hitter", 100, 0, S), 0);
  });
  test("uses the effective sample of a recent-vs-baseline difference", () => {
    // n_eff = 50·50/100 = 25; k = 25 → 0.5
    assert.equal(reliability("hitter", 50, 50, S), 0.5);
    assert.equal(reliability("hitter", 30, 60, S), reliability("hitter", 60, 30, S));
  });
  test("increases with either sample and stays below 1", () => {
    let prev = 0;
    for (const n of [5, 10, 20, 40, 80, 160, 1000]) {
      const r = reliability("pitcher", n, 100, S);
      assert.ok(r > prev && r < 1);
      prev = r;
    }
    assert.ok(reliability("hitter", 40, 10, S) < reliability("hitter", 40, 80, S));
  });
  test("confidence labels follow the configured thresholds", () => {
    const c = S.confidence;
    assert.equal(confidenceLevel("hitter", 0.1, 40, 40, S), "low");
    assert.equal(confidenceLevel("hitter", c.levels.medium, 40, 40, S), "medium");
    assert.equal(confidenceLevel("hitter", c.levels.high, 40, 40, S), "high");
    const strict = withSettings((s) => (s.confidence.levels = { medium: 0.8, high: 0.9 }));
    assert.equal(confidenceLevel("hitter", 0.6, 40, 40, strict), "low");
  });

  test("AFL calibration: tiny samples Low, normal AFL samples Medium, High is hard", () => {
    const label = (role: "hitter" | "pitcher", recent: number, baseline: number) =>
      confidenceLevel(role, reliability(role, recent, baseline, S), recent, baseline, S);
    // Genuinely tiny: a couple of games recently, or almost no earlier games.
    assert.equal(label("hitter", 8, 60), "low");
    assert.equal(label("hitter", 12, 80), "low", "below the recent-PA floor despite a big baseline");
    assert.equal(label("hitter", 30, 8), "low");
    assert.equal(label("hitter", 60, 12), "low", "almost no earlier games");
    assert.equal(label("pitcher", 6, 40), "low");
    // Normal AFL 14D samples (≈25–40 recent PA/BF against a similar baseline): Medium.
    for (const [r, b] of [[25, 25], [30, 30], [35, 28], [40, 35], [28, 40]])
      assert.equal(label("hitter", r, b), "medium", `${r}/${b} PA`);
    assert.equal(label("pitcher", 25, 30), "medium");
    assert.equal(label("pitcher", 15, 25), "medium", "a typical reliever");
    // High needs near-everyday samples on both sides.
    assert.equal(label("hitter", 40, 40), "high");
    assert.equal(label("hitter", 45, 60), "high");
    assert.equal(label("hitter", 25, 200), "medium", "High also needs ≥30 PA on each side");
    assert.equal(label("hitter", 200, 25), "medium");
    assert.equal(label("pitcher", 20, 100), "medium", "relievers rarely reach High");
    assert.equal(label("pitcher", 40, 45), "high");
  });

  test("confidence is display-only: the score is still shrunk by reliability", () => {
    const ctx = createAnalyticsContext(trajectorySnapshot());
    const r = momentum(ctx, IDS.improver, "hitter", "14d", "balanced");
    assert.ok(r.reliability > 0 && r.reliability < 1);
    assert.equal(r.reliabilityAdjusted, Math.round(r.rawScore! * r.reliability * 10) / 10);
    assert.equal(effectiveSample(50, 50), 25);
    assert.equal(effectiveSample(0, 50), 0);
  });
  test("display mapping is bounded, odd and monotone", () => {
    assert.equal(zToScore(0, S), 0);
    assert.ok(zToScore(100, S) <= 100 && zToScore(-100, S) >= -100);
    assert.ok(Math.abs(zToScore(1, S) + zToScore(-1, S)) < 1e-12);
    assert.ok(zToScore(1, S) < zToScore(1.5, S));
  });
});

describe("direction-aware persistence wording", () => {
  test("declines never read as improvement", () => {
    for (const state of ["emerging", "strengthening", "sustained", "fading", "reversed"] as const) {
      const up = persistenceLabel({ state, direction: 1 });
      const down = persistenceLabel({ state, direction: -1 });
      assert.notEqual(up, down, state);
      assert.match(up, /upward|improvement|rising/i, up);
      assert.match(down, /decline|declining|downward/i, down);
      assert.doesNotMatch(down, /upward|improv|rising|strengthening/i, down);
    }
  });
  test("exact wording", () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(PERSISTENCE_LABELS).map(([k, v]) => [k, [v.up, v.down]])),
      {
        insufficient: ["Not enough data", "Not enough data"],
        neutral: ["No clear trend", "No clear trend"],
        emerging: ["New upward move", "New downward move"],
        strengthening: ["Strengthening upward trend", "Deepening decline"],
        sustained: ["Sustained upward trend", "Sustained decline"],
        fading: ["Fading improvement", "Easing decline"],
        reversed: ["Reversed — now rising", "Reversed — now declining"],
      },
    );
    assert.equal(persistenceLabel({ state: "neutral", direction: 0 }), "No clear trend");
  });
  test("engine outputs carry the direction-aware label", () => {
    const ctx = createAnalyticsContext(trajectorySnapshot());
    const down = risersAndFallers(ctx, "hitter", "14d", "balanced", "overall", 50).fallers.find(
      (f) => f.playerId === IDS.decliner,
    )!;
    assert.equal(down.persistenceDirection, -1);
    assert.match(down.persistenceLabel, /decline/i);
    const cmp = compareModels(ctx, "14d", 3);
    for (const e of cmp.models[0].hitters.bottom) assert.doesNotMatch(e.persistence.label, /upward|improvement/);
    const tl = playerTimeline(ctx, IDS.decliner, "hitter", "14d", "balanced");
    assert.match(tl.points.at(-1)!.persistenceLabel, /decline/i);
  });
});

describe("trend persistence", () => {
  const cp = (...zs: (number | null)[]): Checkpoint[] =>
    zs.map((z, i) => ({ end: addDays("2026-11-01", -7 * i), z, reliability: 0.5 }));

  test("a one-window spike is 'emerging' and keeps only the floor multiplier", () => {
    const r = trendPersistence(cp(1.2, 0, 0.05, -0.1), 7, [null, null], S);
    assert.equal(r.state, "emerging");
    assert.equal(r.runLength, 1);
    assert.equal(r.trendLengthDays, 7);
    assert.equal(r.score, 0);
    assert.equal(r.level, "low");
    assert.equal(r.multiplier, S.persistence.multiplierFloor);
  });

  test("improvement sustained across consecutive windows earns full credit", () => {
    const r = trendPersistence(cp(0.8, 0.8, 0.75, 0.7), 14, [0.6, 0.5], S);
    assert.equal(r.state, "sustained");
    assert.equal(r.runLength, 4);
    assert.equal(r.trendLengthDays, 3 * 7 + 14);
    assert.equal(r.crossWindowAgreement, 1);
    assert.equal(r.score, 1);
    assert.equal(r.level, "high");
    assert.equal(r.multiplier, 1);
  });

  test("persistent signal beats a spike of the same size", () => {
    const spike = trendPersistence(cp(1, 0, 0), 14, [0.5, null], S);
    const steady = trendPersistence(cp(1, 0.9, 0.8), 14, [0.5, null], S);
    assert.ok(steady.multiplier > spike.multiplier);
    assert.ok(steady.trendLengthDays > spike.trendLengthDays);
  });

  test("strengthening, fading and reversed are detected", () => {
    assert.equal(trendPersistence(cp(1.2, 0.5), 14, [], S).state, "strengthening");
    assert.equal(trendPersistence(cp(0.5, 1.2), 14, [], S).state, "fading");
    assert.equal(trendPersistence(cp(-0.8, -0.8), 14, [], S).state, "sustained");
    const rev = trendPersistence(cp(0.9, -0.9, -0.9), 14, [], S);
    assert.equal(rev.state, "reversed");
    assert.equal(rev.runLength, 1);
    assert.equal(rev.direction, 1);
  });

  test("declines persist symmetrically", () => {
    const r = trendPersistence(cp(-1, -1, -1), 7, [-0.5, -0.5], S);
    assert.equal(r.direction, -1);
    assert.equal(r.level, "high");
  });

  test("neutral and missing signals", () => {
    assert.equal(trendPersistence(cp(0.1, 1, 1), 14, [], S).state, "neutral");
    assert.equal(trendPersistence(cp(null), 14, [], S).state, "insufficient");
    assert.equal(trendPersistence([], 14, [], S).state, "insufficient");
  });

  test("unreliable or missing checkpoints break the run", () => {
    const xs = cp(1, 1, 1);
    xs[1].reliability = 0.05;
    assert.equal(trendPersistence(xs, 14, [], S).runLength, 1);
    assert.equal(trendPersistence(cp(1, null, 1), 14, [], S).runLength, 1);
  });

  test("cross-window disagreement lowers persistence", () => {
    const agree = trendPersistence(cp(1, 1), 14, [0.6, 0.6], S);
    const disagree = trendPersistence(cp(1, 1), 14, [-0.6, 0.1], S);
    assert.ok(agree.score > disagree.score);
    assert.equal(disagree.crossWindowAgreement, 0);
  });
});

describe("comparison windows over the read model", () => {
  const snap = trajectorySnapshot();
  const ds = buildDataset(snap);

  test("as-of is the latest completed game; excluded games never enter windows", () => {
    assert.equal(ds.asOf, dayDate(26));
    assert.equal(ds.completedDates.length, 27);
    const season = sampleInRange(ds, "hitter", IDS.star, { from: "2026-01-01", to: ds.asOf! }) as HitterSample;
    assert.equal(season!.plateAppearances, 27 * 4);
    assert.equal(season!.homeRuns, 18); // 2 HR per 3-game strong cycle; the 10-HR leak lines are excluded
  });

  test("recent window matches the read model's bounds and baseline is everything before", () => {
    const r = comparisonRanges(ds, ds.asOf!, "14d");
    assert.deepEqual(r.recent, { from: dayDate(13), to: dayDate(26) });
    assert.deepEqual(r.baseline, { from: "2026-01-01", to: dayDate(12) });
    const r7 = comparisonRanges(ds, ds.asOf!, "7d");
    assert.equal(daysBetween(r7.recent.from, r7.recent.to), 6);
  });

  test("a window starting at the season boundary has no baseline", () => {
    const early = syntheticSnapshot([{ id: u(50), name: "Jan", batting: () => WEAK[0] }], 1, { extraGames: false });
    early.games[0].date = "2026-01-03";
    const d = buildDataset(early);
    assert.equal(comparisonRanges(d, "2026-01-03", "7d").baseline, null);
  });

  test("roles: two-way players have both", () => {
    assert.deepEqual(playerRoles(ds, IDS.twoWay), ["hitter", "pitcher"]);
    assert.deepEqual(playerRoles(ds, IDS.star), ["hitter"]);
    assert.deepEqual(playerRoles(ds, IDS.pSteady), ["pitcher"]);
    assert.deepEqual(playerRoles(ds, u(99999)), []);
  });

  test("windows agree with buildPlayerRows' 14d aggregates", () => {
    const row = buildPlayerRows(snap, "14d").find((r) => r.id === IDS.improver)!;
    const recent = sampleInRange(ds, "hitter", IDS.improver, comparisonRanges(ds, ds.asOf!, "14d").recent);
    assert.deepEqual(recent, row.batting);
  });
});

describe("normalization populations", () => {
  const ds = buildDataset(trajectorySnapshot());
  test("qualified population respects the opportunity threshold", () => {
    const pop = rolePopulation(ds, "hitter", 30);
    assert.ok(!pop.qualified.includes(IDS.tiny));
    assert.ok(pop.qualified.includes(IDS.star));
    assert.ok(pop.season.has(IDS.tiny));
  });
  test("level-sd and change-sd scales are finite and floored", () => {
    for (const method of ["level-sd", "change-sd"] as const) {
      const s = withSettings((x) => (x.normalization.method = method));
      for (const role of ["hitter", "pitcher"] as const) {
        const scales = normalizationScales(ds, role, s, "14d");
        for (const [metric, v] of Object.entries(scales)) {
          assert.ok(Number.isFinite(v.scale) && v.scale >= metricDefinition(metric).minScale, `${method} ${metric}`);
        }
      }
    }
  });
  test("too small a population uses the explicit fallback scale", () => {
    const small = buildDataset(syntheticSnapshot([{ id: u(60), name: "Solo", batting: () => STRONG[0] }]));
    const scales = normalizationScales(small, "hitter", S, "14d");
    assert.equal(scales.ops.source, "fallback");
    assert.equal(scales.ops.scale, metricDefinition("ops").fallbackScale);
  });
});

describe("hitter Momentum on synthetic trajectories", () => {
  const ctx = createAnalyticsContext(trajectorySnapshot());
  const m = (id: string, w: "7d" | "14d" | "30d" = "14d", model = "balanced" as const) =>
    momentum(ctx, id, "hitter", w, model);

  test("0 means 'like the player's own baseline': a steady star is near zero", () => {
    const star = m(IDS.star);
    assert.equal(star.status, "ok");
    assert.ok(Math.abs(star.score!) <= 14, String(star.score));
    assert.equal(star.band!.id, "stable");
  });

  test("an improving player is positive and a declining one negative", () => {
    assert.ok(m(IDS.improver).score! >= 15);
    assert.ok(m(IDS.decliner).score! <= -15);
    assert.equal(m(IDS.decliner).band!.direction, "down");
  });

  test("progressive improvement outranks a late one-window spike", () => {
    const steady = m(IDS.improver), spike = m(IDS.spike);
    assert.ok(steady.persistence.score > spike.persistence.score);
    assert.equal(spike.persistence.state, "emerging");
    assert.ok(steady.score! > spike.score!);
  });

  test("final score = raw · reliability · persistence multiplier", () => {
    const r = m(IDS.improver);
    const expected = zToScore(r.combinedZ!, S) * r.reliability * r.persistence.multiplier;
    assert.equal(r.score, Math.round(expected));
    assert.ok(Math.abs(r.score!) < Math.abs(r.rawScore!), "shrunk toward zero");
    const sum = r.contributions.reduce((a, c) => a + c.points, 0);
    assert.ok(Math.abs(sum - expected) < 1e-9, "contributions decompose the score");
  });

  test("component decomposition explains the change", () => {
    const r = m(IDS.decliner);
    assert.deepEqual(r.contributions.map((c) => c.component), ["production", "power", "contact", "discipline"]);
    assert.ok(r.contributions.every((c) => c.points < 0));
    assert.match(r.explanation, /driving the decline\./);
  });

  test("What-changed metrics show before / now / change in display units", () => {
    const r = m(IDS.improver);
    assert.deepEqual(r.metrics.map((x) => x.label), ["OPS", "ISO", "K%", "BB%"]);
    for (const x of r.metrics) assert.equal(x.delta, x.now! - x.before!);
    const k = r.metrics.find((x) => x.metric === "hitterKPct")!;
    assert.ok(k.delta! < 0 && k.z! > 0);
  });

  test("small samples shrink instead of disappearing", () => {
    const newcomer = m(IDS.newcomer, "7d");
    assert.equal(newcomer.status, "ok");
    assert.equal(newcomer.confidence, "low");
    assert.ok(newcomer.reliability < m(IDS.improver, "7d").reliability);
  });

  test("below the hard floor or without earlier games there is no score", () => {
    assert.equal(m(IDS.tiny).status, "insufficient-recent");
    assert.equal(m(IDS.tiny).score, null);
    assert.equal(m(IDS.newcomer, "14d").status, "no-baseline");
    // The 30D window covers this whole 27-day season, so nobody has an earlier baseline.
    assert.equal(m(IDS.improver, "30d").status, "no-baseline");
    assert.equal(m(u(99999)).status, "no-recent");
    assert.match(m(IDS.newcomer, "14d").explanation, /^Unavailable — no earlier AFL games/);
  });

  test("models are configuration: different weights give different scores", () => {
    const zs = MODEL_IDS.map((id) => m(IDS.spike, "14d", id as "balanced").combinedZ);
    assert.ok(new Set(zs).size === MODEL_IDS.length, JSON.stringify(zs));
    // Component changes are model-independent; only their weighting differs.
    assert.deepEqual(m(IDS.spike, "14d", "skills-heavy" as "balanced").components, m(IDS.spike).components);
  });

  test("results are memoized and serializable", () => {
    assert.equal(m(IDS.improver), m(IDS.improver));
    const json = JSON.parse(JSON.stringify(m(IDS.improver)));
    assert.equal(json.score, m(IDS.improver).score);
  });

  test("settings are injectable (e.g. change-sd normalization, no persistence floor)", () => {
    const alt = createAnalyticsContext(trajectorySnapshot(), withSettings((s) => {
      s.normalization.method = "change-sd";
      s.persistence.multiplierFloor = 1;
    }));
    const r = momentum(alt, IDS.spike, "hitter", "14d", "balanced");
    assert.equal(r.persistence.multiplier, 1);
    assert.ok(r.score! > 0);
  });
});

describe("pitcher Momentum", () => {
  const ctx = createAnalyticsContext(trajectorySnapshot());
  test("uses its own components and BF opportunities", () => {
    const r = momentum(ctx, IDS.pImprover, "pitcher", "14d", "balanced");
    assert.equal(r.sample.unit, "BF");
    assert.deepEqual(r.contributions.map((c) => c.component), ["strikeouts", "command", "baserunners", "runPrevention"]);
    assert.ok(r.score! > 15);
    assert.ok(momentum(ctx, IDS.pDecliner, "pitcher", "14d", "balanced").score! < -15);
    assert.ok(Math.abs(momentum(ctx, IDS.pSteady, "pitcher", "14d", "balanced").score!) <= 14);
    assert.deepEqual(r.metrics.map((x) => x.label), ["K%", "BB%", "K/9", "BB/9", "WHIP", "ERA"]);
  });

  test("two-way players get independent hitter and pitcher signals", () => {
    const all = playerMomentumByWindow(ctx, IDS.twoWay, "hitter", "balanced");
    const hit = all["14d"];
    const pitch = momentum(ctx, IDS.twoWay, "pitcher", "14d", "balanced");
    assert.ok(hit.score! > 0, "hitting improved");
    assert.ok(pitch.score! < 0, "pitching declined");
  });
});

describe("no completed games", () => {
  const empty = syntheticSnapshot([{ id: u(70), name: "Nobody", batting: () => null }], 0);
  const ctx = createAnalyticsContext(empty);
  test("everything degrades to explicit empty states", () => {
    assert.equal(ctx.ds.asOf, null);
    const r = momentum(ctx, u(70), "hitter", "14d", "balanced");
    assert.equal(r.status, "no-games");
    assert.equal(r.score, null);
    assert.deepEqual(risersAndFallers(ctx, "hitter", "14d", "balanced"), { risers: [], fallers: [] });
    assert.deepEqual(performanceMap(ctx, "hitter", "14d", "balanced", "ops"), []);
    assert.deepEqual(playerTimeline(ctx, u(70), "hitter", "14d", "balanced").points, []);
    const cmp = compareModels(ctx, "14d");
    assert.equal(cmp.models.length, MODEL_IDS.length);
    assert.ok(cmp.models.every((x) => x.hitters.top.length === 0 && x.pitchers.bottom.length === 0));
    const fp = fingerprint(ctx, u(70), "hitter", "14d", "balanced");
    assert.equal(fp.populationSize, 0);
    assert.ok(fp.categories.every((c) => c.percentile === null));
  });
});

describe("discovery views", () => {
  const ctx = createAnalyticsContext(trajectorySnapshot());

  test("Risers / Fallers rank change relative to baseline, not raw production", () => {
    const { risers, fallers } = risersAndFallers(ctx, "hitter", "14d", "balanced", "overall", 50);
    const min = S.sample.leaderboardMinMagnitude;
    assert.ok(risers.every((e) => e.value >= min) && fallers.every((e) => e.value <= -min));
    // Tiny moves (the steady star is ~0) are neither risers nor fallers.
    assert.ok(!fallers.some((f) => f.playerId === IDS.star));
    for (let i = 1; i < risers.length; i++) assert.ok(risers[i - 1].value >= risers[i].value);
    for (let i = 1; i < fallers.length; i++) assert.ok(fallers[i - 1].value <= fallers[i].value);
    const ids = risers.map((r) => r.playerId);
    assert.ok(ids.includes(IDS.improver));
    // The steady star has the best raw line but is not a riser.
    assert.ok(!ids.includes(IDS.star));
    assert.ok(fallers.some((f) => f.playerId === IDS.decliner));
    // Unqualified samples are excluded.
    assert.ok(![...ids, ...fallers.map((f) => f.playerId)].includes(IDS.tiny));
  });

  test("component lists and role validation", () => {
    const power = risersAndFallers(ctx, "hitter", "14d", "balanced", "power", 50);
    assert.ok(power.risers.length > 0);
    assert.throws(() => risersAndFallers(ctx, "hitter", "14d", "balanced", "command"), /does not apply/);
    const k = risersAndFallers(ctx, "pitcher", "14d", "balanced", "strikeouts", 50);
    assert.ok(k.risers.some((e) => e.playerId === IDS.pImprover));
  });

  test("leaderboard minimums are enforced", () => {
    const strict = createAnalyticsContext(trajectorySnapshot(), withSettings((s) => {
      s.sample.leaderboardMinRecent.hitter["14d"] = 1000;
    }));
    assert.deepEqual(risersAndFallers(strict, "hitter", "14d", "balanced"), { risers: [], fallers: [] });
  });

  test("Performance × Momentum quadrants", () => {
    assert.equal(quadrantOf(80, 30), "surging-star");
    assert.equal(quadrantOf(20, 30), "breakout");
    assert.equal(quadrantOf(80, -5), "established-cooling");
    assert.equal(quadrantOf(20, -30), "struggling");
    const points = performanceMap(ctx, "hitter", "14d", "balanced", "ops");
    assert.ok(points.length > 0);
    for (const p of points) {
      assert.ok(p.x >= 0 && p.x <= 100);
      assert.equal(p.quadrant, quadrantOf(p.x, p.y));
    }
    const star = points.find((p) => p.playerId === IDS.star)!;
    assert.ok(star.x > 50 && star.quadrant === "established-cooling");
    assert.throws(() => performanceMap(ctx, "hitter", "14d", "balanced", "era"), /not a hitter metric/);
    // Lower-is-better x metrics are ranked so higher percentile = better.
    const kpts = performanceMap(ctx, "hitter", "14d", "balanced", "hitterKPct");
    const kStar = kpts.find((p) => p.playerId === IDS.star)!;
    assert.ok(kStar.x > 50);
  });

  test("AFL-relative fingerprint percentiles", () => {
    const fp = fingerprint(ctx, IDS.star, "hitter", "14d", "balanced");
    assert.ok(fp.qualified);
    assert.equal(fp.populationSize, ctx.percentilePopulations.hitter.qualified.length);
    const power = fp.categories.find((c) => c.id === "power")!;
    assert.ok(power.percentile! > 50);
    assert.equal(power.percentile, mean(power.metrics.map((x) => x.percentile!)));
    const contact = fp.categories.find((c) => c.id === "contact")!;
    assert.ok(contact.metrics.find((x) => x.metric === "hitterKPct")!.percentile! > 50, "low K% ranks high");
    assert.notEqual(fp.momentum.percentile, null);
    const tiny = fingerprint(ctx, IDS.tiny, "hitter", "14d", "balanced");
    assert.equal(tiny.qualified, false);
    assert.equal(tiny.momentum.percentile, null);
    const arm = fingerprint(ctx, IDS.pSteady, "pitcher", "14d", "balanced");
    assert.deepEqual(arm.categories.map((c) => c.id), ["strikeouts", "command", "kbb", "runPrevention"]);
  });

  test("development timeline", () => {
    const tl = playerTimeline(ctx, IDS.improver, "hitter", "14d", "balanced");
    assert.equal(tl.points.length, 27);
    assert.deepEqual(tl.events, [], "no events are fabricated");
    assert.equal(tl.points.at(-1)!.score, momentum(ctx, IDS.improver, "hitter", "14d", "balanced").score);
    // Before day 13 there is no baseline for a 14-day window.
    assert.equal(tl.points[5].score, null);
    assert.ok(tl.points.every((p) => p.topComponents.length <= 2));
    const late = playerTimeline(ctx, IDS.newcomer, "hitter", "7d", "balanced");
    assert.equal(late.points[0].date, dayDate(17));
  });

  test("model comparison output", () => {
    const cmp = compareModels(ctx, "14d", 3);
    assert.deepEqual(cmp.models.map((x) => x.model.id), MODEL_IDS);
    for (const x of cmp.models) {
      for (const list of [x.hitters, x.pitchers]) {
        assert.ok(list.top.length <= 3 && list.bottom.length <= 3);
        for (let i = 1; i < list.top.length; i++) assert.ok(list.top[i - 1].score >= list.top[i].score);
        for (let i = 1; i < list.bottom.length; i++) assert.ok(list.bottom[i - 1].score <= list.bottom[i].score);
        for (const e of list.top) {
          assert.ok(e.contributions.length > 0);
          assert.ok(e.metrics.length > 0);
          assert.ok(e.sample.recent > 0 && e.sample.baseline > 0);
        }
      }
    }
    assert.equal(cmp.agreement.length, 3 * 2);
    for (const a of cmp.agreement) if (a.spearman !== null) assert.ok(a.spearman >= -1 && a.spearman <= 1);
    assert.ok(cmp.qualified.hitter > 0 && cmp.qualified.pitcher > 0);
  });
});

describe("deterministic explanations", () => {
  const c = (component: "power" | "contact" | "discipline" | "production", weighted: number) => ({
    component, z: weighted * 4, weight: 0.25, weighted,
  });
  test("names the largest same-direction drivers", () => {
    const text = explainMomentum({
      combinedZ: 0.9,
      contributions: [c("power", 0.4), c("contact", 0.35), c("discipline", 0.05), c("production", 0.1)],
      confidence: "high", persistence: "sustained", settings: S,
    });
    assert.equal(text, "Power and contact are driving the rise.");
  });
  test("spike, decline, offsets and low confidence", () => {
    assert.equal(
      explainMomentum({ combinedZ: 0.6, contributions: [c("discipline", 0.6)], confidence: "medium", persistence: "emerging", settings: S }),
      "Plate discipline is driving the recent spike.",
    );
    assert.equal(
      explainMomentum({
        combinedZ: -0.5, contributions: [c("contact", -0.7), c("power", 0.3)], confidence: "low", persistence: "sustained", settings: S,
      }),
      "Contact is driving the decline. Power has moved the other way. Small sample — treat with caution.",
    );
    assert.match(
      explainMomentum({ combinedZ: 0.1, contributions: [], confidence: "high", persistence: "neutral", settings: S }),
      /close to the player's earlier AFL baseline/,
    );
    assert.match(
      explainMomentum({ combinedZ: null, contributions: [], confidence: "low", persistence: "insufficient", settings: S }),
      /Not enough/,
    );
  });
  test("drivers ignore a zero total", () => {
    assert.deepEqual(drivers([c("power", 0.2), c("contact", -0.2)], 0), { drivers: [], offsets: [] });
  });
  test("identical inputs give identical text", () => {
    const ctx = createAnalyticsContext(trajectorySnapshot());
    const a = momentum(ctx, IDS.improver, "hitter", "14d", "balanced").explanation;
    const b = momentum(createAnalyticsContext(trajectorySnapshot()), IDS.improver, "hitter", "14d", "balanced").explanation;
    assert.equal(a, b);
  });
});

describe("incomplete windows", () => {
  test("a player missing the recent window has no score but keeps the baseline", () => {
    const snap = syntheticSnapshot([
      { id: u(80), name: "Shut Down", batting: (d) => (d < 15 ? STRONG[d % 3] : null) },
      ...Array.from({ length: 9 }, (_, i) => ({ id: u(400 + i), name: `F${i}`, batting: (d: number) => (i % 2 ? STRONG : WEAK)[d % 3] })),
    ]);
    const ctx = createAnalyticsContext(snap);
    const r = momentum(ctx, u(80), "hitter", "7d", "balanced");
    assert.equal(r.status, "no-recent");
    assert.ok(r.sample.baseline > 0);
    const snapAt = changeSnapshot(ctx, u(80), "hitter", "7d", ctx.ds.asOf!);
    assert.equal(snapAt.recent, null);
  });
});

describe("30D in a short season", () => {
  const ctx = createAnalyticsContext(trajectorySnapshot());
  test("no 30D score is fabricated without a valid earlier baseline; 7D/14D still work", () => {
    for (const id of [IDS.improver, IDS.decliner, IDS.star]) {
      const m30 = momentum(ctx, id, "hitter", "30d", "balanced");
      assert.equal(m30.status, "no-baseline");
      assert.equal(m30.score, null);
      assert.equal(m30.band, null);
      assert.deepEqual(m30.contributions, []);
      assert.match(m30.explanation, /^Unavailable/);
      assert.equal(momentum(ctx, id, "hitter", "7d", "balanced").status, "ok");
      assert.equal(momentum(ctx, id, "hitter", "14d", "balanced").status, "ok");
    }
    assert.deepEqual(risersAndFallers(ctx, "hitter", "30d", "balanced"), { risers: [], fallers: [] });
    assert.deepEqual(performanceMap(ctx, "hitter", "30d", "balanced", "ops"), []);
    assert.ok(playerTimeline(ctx, IDS.improver, "hitter", "30d", "balanced").points.every((p) => p.score === null));
  });
  test("a valid 30D baseline (longer season) is scored normally", () => {
    const long = createAnalyticsContext(trajectorySnapshot(45));
    const m30 = momentum(long, IDS.improver, "hitter", "30d", "balanced");
    assert.equal(m30.status, "ok");
    assert.notEqual(m30.score, null);
  });
  test("sample distribution reports confidence counts", () => {
    const d = sampleDistribution(ctx, "hitter", "14d");
    assert.equal(d.confidence.low + d.confidence.medium + d.confidence.high, d.players);
    assert.equal(d.recent.length, 5);
    assert.equal(sampleDistribution(ctx, "hitter", "30d").players, 0);
    assert.ok(compareModels(ctx, "14d").samples.pitcher.players > 0);
  });
});
