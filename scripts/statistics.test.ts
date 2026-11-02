import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateBatting,
  aggregatePitching,
  windowBounds,
} from "../src/statistics/aggregate";
const batting = {
  plateAppearances: 5,
  atBats: 4,
  hits: 2,
  doubles: 1,
  triples: 0,
  homeRuns: 0,
  walks: 1,
  strikeouts: 1,
  hitByPitch: 0,
  sacrificeFlies: 0,
  stolenBases: 1,
};
const pitching = {
  outsRecorded: 17,
  battersFaced: 22,
  hitsAllowed: 4,
  earnedRuns: 3,
  walks: 2,
  strikeouts: 7,
  homeRunsAllowed: 1,
};
const near = (a: number | null, b: number) =>
  assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);
test("hitting derived metrics use summed raw counts, with OBP/SLG/PA denominators kept distinct", () => {
  const r = aggregateBatting([batting, batting]);
  assert.equal(r.hits, 4);
  assert.equal(r.gameLines, 2);
  near(r.avg, 0.5);
  near(r.obp, 0.6);
  near(r.slg, 0.75);
  near(r.ops, 1.35);
  near(r.bbPct, 20);
  near(r.kPct, 20);
  assert.equal(r.runs, null);
  const walk = aggregateBatting([
    {
      ...batting,
      atBats: 0,
      hits: 0,
      doubles: 0,
      plateAppearances: 2,
      walks: 1,
      hitByPitch: 1,
      strikeouts: 0,
    },
  ]);
  assert.equal(walk.avg, null);
  near(walk.obp, 1);
});
test("pitching rates use outs instead of decimal innings and batters faced for percentages", () => {
  const r = aggregatePitching([pitching]);
  near(r.era, 81 / 17);
  near(r.whip, 18 / 17);
  near(r.kPct, 700 / 22);
  near(r.bbPct, 200 / 22);
  assert.equal(r.outsRecorded, 17);
  assert.equal(r.pitches, null);
});
test("zero samples never return NaN or Infinity", () => {
  const b = aggregateBatting([]),
    p = aggregatePitching([]);
  assert.equal(b.plateAppearances, 0);
  for (const key of ["avg", "obp", "slg", "ops", "bbPct", "kPct"] as const)
    assert.equal(b[key], null);
  for (const key of ["era", "whip", "kPct", "bbPct"] as const)
    assert.equal(p[key], null);
});
test("rolling windows are inclusive calendar dates and remain scoped to season", () => {
  const base = {
    season: 2026,
    asOf: "2026-11-01",
    leagueId: "00000000-0000-4000-8000-000000000001",
  };
  assert.deepEqual(windowBounds({ ...base, window: "7d" }), {
    from: "2026-10-26",
    to: "2026-11-01",
  });
  assert.deepEqual(windowBounds({ ...base, window: "14d" }), {
    from: "2026-10-19",
    to: "2026-11-01",
  });
  assert.deepEqual(windowBounds({ ...base, window: "30d" }), {
    from: "2026-10-03",
    to: "2026-11-01",
  });
  assert.deepEqual(windowBounds({ ...base, window: "season" }), {
    from: "2026-01-01",
    to: "2026-11-01",
  });
  assert.deepEqual(
    windowBounds({ ...base, asOf: "2026-01-03", window: "7d" }),
    { from: "2026-01-01", to: "2026-01-03" },
  );
  assert.deepEqual(
    windowBounds({ ...base, window: { from: "2026-10-01", to: "2026-10-24" } }),
    { from: "2026-10-01", to: "2026-10-24" },
  );
  assert.throws(() =>
    windowBounds({ ...base, window: { from: "2026-10-25", to: "2026-10-24" } }),
  );
});
