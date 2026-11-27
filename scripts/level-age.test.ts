/**
 * Age relative to level (T-401): decimal age, median, the level population rule, the minimum
 * sample, the sign convention, rounding and formatting, and the directory column/sort. Hand-computed
 * fixtures; fictional players only.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AflSnapshot } from "../src/services/afl/types";
import {
  MIN_LEVEL_AGE_SAMPLE,
  ageVsLevel,
  decimalAge,
  formatAgeVsLevel,
  levelAgeContext,
  levelAgesVsMedian,
  median,
} from "../src/services/players/level-age";
import { directoryRows, levelDirectoryRows } from "../src/services/players/adapter";
import { DIRECTORY_SORTS } from "../src/services/players/directory-query";
import { scaleSnapshot } from "./milb-scale-support";

describe("decimalAge and median", () => {
  test("decimal years on the as-of date (365.2425-day years)", () => {
    assert.equal(decimalAge("2000-01-01", "2000-01-01"), 0);
    assert.equal(decimalAge("2000-01-01", "2001-01-01"), 366 / 365.2425); // 2000 is a leap year
    assert.ok(Math.abs(decimalAge("2004-06-15", "2026-06-15")! - 22) < 0.01);
    assert.equal(decimalAge("2026-06-16", "2026-06-15"), null, "born after the as-of date");
    assert.equal(decimalAge("06/15/2004", "2026-06-15"), null, "not an ISO date");
    assert.equal(decimalAge("2004-06-15", "2026-06-15T19:05:00Z")! > 21.99, true, "a timestamp as-of uses its date");
  });

  test("median: odd, even, unsorted input untouched, empty", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    const v = [5, 1, 4];
    median(v);
    assert.deepEqual(v, [5, 1, 4]);
    assert.equal(median([]), null);
  });

  test("rounded to 0.1; sign and formatting (true minus, no −0.0)", () => {
    const ctx = { asOf: "2026-06-15", median: 22, sample: 30 };
    assert.equal(ageVsLevel("2004-06-15", ctx), 0);
    assert.equal(ageVsLevel("2002-06-15", ctx), 2);
    assert.equal(ageVsLevel("2005-12-15", ctx), -1.5);
    assert.equal(ageVsLevel(null, ctx), null);
    assert.equal(ageVsLevel("2004-06-15", { ...ctx, median: null }), null);
    assert.equal(formatAgeVsLevel(2), "+2.0");
    assert.equal(formatAgeVsLevel(-1.5), "−1.5");
    assert.equal(formatAgeVsLevel(0), "0.0");
    assert.equal(formatAgeVsLevel(null), "—");
  });
});

describe("levelAgeContext", () => {
  // scaleSnapshot birth dates: `${2000 + (k % 6)}-05-0${1 + (k % 9)}`, k = 0..12 per team and role.
  const s = scaleSnapshot({ ns: 2, level: "aa", teams: 2, days: 10, seed: 2 });

  test("median over players with a completed-game line and a known birth date, on the level's as-of date", () => {
    const ctx = levelAgeContext(s);
    const complete = new Set(s.games.filter((g) => g.status === "final" && g.boxscoreComplete).map((g) => g.id));
    const withLines = new Set([...s.batting, ...s.pitching].filter((l) => complete.has(l.gameId)).map((l) => l.playerId));
    const ages = s.players.filter((p) => withLines.has(p.id) && p.birthDate).map((p) => decimalAge(p.birthDate!, ctx.asOf!)!);
    assert.equal(ctx.sample, ages.length);
    assert.ok(ctx.sample >= MIN_LEVEL_AGE_SAMPLE);
    assert.equal(ctx.median, median(ages));
    assert.equal(levelAgeContext(s), ctx, "memoized per snapshot object");
  });

  test("players without lines or birth dates are left out; a small level has no median", () => {
    const players = s.players.map((p, i) => (i % 2 ? { ...p, birthDate: null } : p));
    const half = levelAgeContext({ ...s, players });
    const lined = new Set([...s.batting, ...s.pitching].map((l) => l.playerId));
    const removed = s.players.filter((p, i) => i % 2 && lined.has(p.id) && p.birthDate).length;
    assert.ok(removed > 0);
    assert.equal(half.sample, levelAgeContext(s).sample - removed);
    const extra: AflSnapshot = { ...s, players: [...s.players, { ...s.players[0], id: "00000000-0000-4000-8000-0000000000ff", birthDate: "1980-01-01" }] };
    assert.equal(levelAgeContext(extra).sample, levelAgeContext(s).sample, "a player with no lines does not count");
    const few = s.players.slice(0, MIN_LEVEL_AGE_SAMPLE - 1).map((p) => p.id);
    const tiny: AflSnapshot = { ...s, batting: s.batting.filter((l) => few.includes(l.playerId)), pitching: s.pitching.filter((l) => few.includes(l.playerId)) };
    const t = levelAgeContext(tiny);
    assert.ok(t.sample < MIN_LEVEL_AGE_SAMPLE);
    assert.equal(t.median, null);
    assert.equal(ageVsLevel(s.players[0].birthDate, t), null);
  });

  test("no completed games: no as-of date, no median", () => {
    const none = levelAgeContext({ ...s, games: s.games.map((g) => ({ ...g, status: "scheduled" })) });
    assert.deepEqual(none, { asOf: null, median: null, sample: 0 });
  });
});

describe("directory column", () => {
  test("directoryRows carry ageVsLevel from the row's own level; agerel sorts on it; levelDirectoryRows unchanged", () => {
    const s = scaleSnapshot({ ns: 3, level: "aa", teams: 2, days: 10, seed: 3 });
    const ctx = levelAgeContext(s);
    const born = new Map(s.players.map((p) => [p.id, p.birthDate]));
    for (const role of ["hitter", "pitcher"] as const) {
      const rows = directoryRows([{ level: "aa", snapshot: s }], { level: "aa", window: "season", role });
      assert.ok(rows.length > 0);
      for (const r of rows) assert.equal(r.ageVsLevel, ageVsLevel(born.get(r.id) ?? null, ctx), r.name);
      assert.ok(rows.some((r) => r.ageVsLevel! > 0) && rows.some((r) => r.ageVsLevel! < 0), "both signs present");
      assert.equal(DIRECTORY_SORTS[role].agerel(rows[0]), rows[0].ageVsLevel);
    }
    // The memoized/precomputed per-level rows (recorded by the Momentum golden file) do not carry it.
    for (const r of levelDirectoryRows(s, "aa")) assert.equal("ageVsLevel" in r, false);
    assert.deepEqual(levelAgesVsMedian(s).get(s.players[0].id), ageVsLevel(s.players[0].birthDate, ctx));
  });
});
