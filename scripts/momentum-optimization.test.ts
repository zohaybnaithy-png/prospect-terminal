/**
 * Contracts of the output-preserving Momentum optimizations in src/analytics/windows.ts
 * (memoized comparison ranges, binary-searched line ranges). The golden test
 * (scripts/momentum-golden.test.ts) proves the outputs are unchanged; these tests pin the
 * properties that make that true.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, comparisonRanges, linesInRange, type DatedLine } from "../src/analytics/windows";
import { edgeSnapshot } from "./momentum-golden-support";
import { trajectorySnapshot } from "./analytics-test-support";

/** The pre-optimization implementation, kept here as the reference. */
const reference = <T>(lines: DatedLine<T>[] | undefined, r: { from: string; to: string }) =>
  (lines ?? []).filter((l) => l.date >= r.from && l.date <= r.to).map((l) => l.line);

describe("comparisonRanges memo", () => {
  test("returns equal values but fresh objects on every call (no shared or mutable cached state)", () => {
    const ds = buildDataset(trajectorySnapshot());
    const a = comparisonRanges(ds, ds.asOf!, "14d");
    const b = comparisonRanges(ds, ds.asOf!, "14d");
    assert.deepEqual(a, b);
    assert.notEqual(a, b);
    assert.notEqual(a.recent, b.recent);
    assert.notEqual(a.baseline, b.baseline);
    a.recent.from = "mutated";
    assert.notEqual(comparisonRanges(ds, ds.asOf!, "14d").recent.from, "mutated", "a caller's mutation never reaches the cache");
    assert.deepEqual(Object.keys(b), ["recent", "baseline"]);
    assert.deepEqual(Object.keys(b.recent), ["from", "to"]);
  });

  test("keys every input: windows, end dates and datasets never share an entry", () => {
    const ds = buildDataset(trajectorySnapshot());
    const end = ds.asOf!;
    const r7 = comparisonRanges(ds, end, "7d");
    const r14 = comparisonRanges(ds, end, "14d");
    assert.notDeepEqual(r7, r14);
    assert.notDeepEqual(comparisonRanges(ds, "2026-10-20", "7d"), r7);
    const other = { seasonYear: 2026, leagueId: "00000000-0000-4000-9000-000000000999" };
    assert.deepEqual(comparisonRanges(other, end, "7d"), r7, "same inputs, different object: same value");
  });

  test("invalid input still throws on every call (failures are never cached)", () => {
    const ds = buildDataset(trajectorySnapshot());
    for (let i = 0; i < 3; i++) assert.throws(() => comparisonRanges(ds, "2025-10-01", "7d"), /season/);
    assert.throws(() => comparisonRanges({ seasonYear: 2026, leagueId: "not-a-uuid" }, "2026-10-10", "7d"));
  });

  test("a window starting at the season boundary still has no baseline", () => {
    assert.equal(comparisonRanges({ seasonYear: 2026, leagueId: "00000000-0000-4000-9000-000000000001" }, "2026-01-03", "7d").baseline, null);
  });
});

describe("linesInRange binary search", () => {
  test("selects exactly the reference rows, in the same order, for every player and many ranges (doubleheaders included)", () => {
    for (const snap of [edgeSnapshot(), trajectorySnapshot()]) {
      const ds = buildDataset(snap);
      const dates = ds.completedDates;
      const bounds = [`${snap.season.year}-01-01`, ...dates, "2026-12-31", "2026-10-05", "2026-10-50"];
      let checked = 0;
      for (const lists of [ds.batting, ds.pitching] as Map<string, DatedLine<unknown>[]>[])
        for (const lines of lists.values())
          for (let i = 0; i < bounds.length; i += 3)
            for (let j = 0; j < bounds.length; j += 2) {
              const r = { from: bounds[i], to: bounds[j] }; // includes from > to (empty)
              const got = linesInRange(lines, r);
              const want = reference(lines, r);
              assert.equal(got.length, want.length);
              got.forEach((line, k) => assert.equal(line, want[k], "same object, same order"));
              checked++;
            }
      assert.ok(checked > 500, `${checked} ranges checked`);
    }
  });

  test("the edge fixture really has doubleheaders (two lines on one date for one player)", () => {
    const ds = buildDataset(edgeSnapshot());
    const twoWay = ds.batting.get("00000000-0000-4000-9000-000000000501")!;
    const perDate = new Map<string, number>();
    for (const l of twoWay) perDate.set(l.date, (perDate.get(l.date) ?? 0) + 1);
    assert.ok([...perDate.values()].some((n) => n === 2));
  });

  test("lists not built by buildDataset (unverified order) use the linear filter and still match", () => {
    const unsorted: DatedLine<number>[] = [
      { date: "2026-05-03", line: 3 },
      { date: "2026-05-01", line: 1 },
      { date: "2026-05-02", line: 2 },
      { date: "2026-05-01", line: 4 },
    ];
    for (const r of [{ from: "2026-05-01", to: "2026-05-02" }, { from: "2026-05-02", to: "2026-05-03" }, { from: "2026-05-04", to: "2026-05-01" }])
      assert.deepEqual(linesInRange(unsorted, r), reference(unsorted, r));
    assert.deepEqual(linesInRange(undefined, { from: "2026-01-01", to: "2026-12-31" }), []);
  });

  test("returns a new array each time (callers may not affect the dataset)", () => {
    const ds = buildDataset(trajectorySnapshot());
    const lines = [...ds.batting.values()][0];
    const r = { from: "2026-01-01", to: ds.asOf! };
    const a = linesInRange(lines, r);
    a.length = 0;
    assert.ok(linesInRange(lines, r).length > 0);
  });
});
