import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MOMENTUM_MODEL,
  MOMENTUM_WINDOW_IDS,
} from "../src/analytics/config";
import { momentum, risersAndFallers } from "../src/analytics/engine";
import { analyticsContextFor } from "../src/analytics/views";
import {
  directoryOptions,
  filterDirectory,
  momentumWindowFor,
  positionGroup,
  rowsForRole,
  sortPositionGroups,
} from "../src/services/players/directory";
import { aflDirectoryRows } from "../src/services/players/afl-adapter";
import { LEVELS, isLevelId } from "../src/services/players/levels";
import {
  coverageSummary,
  latestTopLines,
  trendingSets,
} from "../src/services/home";
import { getTopProspects } from "../src/services/rankings";
import { buildPlayerRows } from "../src/services/afl/read-model";
import {
  IDS,
  T1,
  T2,
  bl,
  dayDate,
  pl,
  syntheticSnapshot,
  trajectorySnapshot,
  u,
} from "./analytics-test-support";

describe("player directory model", () => {
  test("position groups map source abbreviations without inventing positions", () => {
    assert.equal(positionGroup("CF"), "OF");
    assert.equal(positionGroup("lf"), "OF");
    assert.equal(positionGroup("SS"), "SS");
    assert.equal(positionGroup("P"), "P");
    assert.equal(positionGroup("TWP"), "TWP");
    assert.equal(positionGroup("IF"), "UT");
    assert.deepEqual(sortPositionGroups(["P", "OF", "C", "SS", "C"]), [
      "C",
      "SS",
      "OF",
      "P",
    ]);
  });

  test("level registry covers MiLB levels and AFL; only AFL rows exist today", () => {
    assert.deepEqual(
      LEVELS.map((l) => l.id),
      ["aaa", "aa", "high-a", "single-a", "afl"],
    );
    assert.ok(isLevelId("afl") && !isLevelId("rookie"));
    const rows = aflDirectoryRows(trajectorySnapshot());
    assert.ok(rows.every((r) => r.level === "afl"));
    assert.deepEqual([...directoryOptions(rows).levels], ["afl"]);
  });

  test("rows carry the read-model aggregates and V1 Momentum unchanged", () => {
    const s = trajectorySnapshot();
    const ctx = analyticsContextFor(s);
    for (const window of ["season", "7d", "14d", "30d"] as const) {
      const base = new Map(buildPlayerRows(s, window).map((r) => [r.id, r]));
      const mw = momentumWindowFor(window);
      for (const row of aflDirectoryRows(s, window)) {
        assert.deepEqual(row.batting, base.get(row.id)!.batting);
        assert.deepEqual(row.pitching, base.get(row.id)!.pitching);
        for (const role of ["hitter", "pitcher"] as const) {
          const cell = row.momentum[role];
          if (!cell) continue;
          const m = momentum(ctx, row.id, role, mw, DEFAULT_MOMENTUM_MODEL);
          assert.equal(cell.score, m.score);
          assert.equal(cell.band, m.band?.label ?? null);
        }
      }
    }
    assert.equal(momentumWindowFor("season"), "14d");
  });

  test("two-way players appear in both role lists; filters combine", () => {
    const s = trajectorySnapshot();
    const rows = aflDirectoryRows(s);
    const hitters = rowsForRole(rows, "hitter");
    const pitchers = rowsForRole(rows, "pitcher");
    assert.ok(hitters.some((r) => r.id === IDS.twoWay));
    assert.ok(pitchers.some((r) => r.id === IDS.twoWay));
    assert.ok(hitters.every((r) => r.batting !== null));
    assert.ok(pitchers.every((r) => r.pitching !== null));

    const improver = rows.find((r) => r.id === IDS.improver)!;
    assert.deepEqual(
      filterDirectory(rows, { query: improver.name.toUpperCase() }).map(
        (r) => r.id,
      ),
      [IDS.improver],
    );
    assert.equal(filterDirectory(rows, { query: "no such player" }).length, 0);
    assert.equal(filterDirectory(rows, { level: "aaa" }).length, 0);
    assert.equal(filterDirectory(rows, { level: "afl" }).length, rows.length);
    const ss = filterDirectory(rows, { position: "SS" });
    assert.ok(ss.length > 0 && ss.every((r) => r.positionGroup === "SS"));
    assert.equal(
      filterDirectory(rows, { position: "SS", query: "no such player" }).length,
      0,
    );
  });
});

describe("homepage view models", () => {
  test("trending lists are exactly the V1 risers/fallers for each role and window", () => {
    const s = trajectorySnapshot();
    const ctx = analyticsContextFor(s);
    const sets = trendingSets(s, 5);
    for (const role of ["hitter", "pitcher"] as const)
      for (const w of MOMENTUM_WINDOW_IDS) {
        const expected = risersAndFallers(
          ctx,
          role,
          w,
          DEFAULT_MOMENTUM_MODEL,
          "overall",
          5,
        );
        assert.deepEqual(
          sets.lists[role][w].risers.map((e) => [e.playerId, e.score]),
          expected.risers.map((e) => [e.playerId, e.score]),
        );
        assert.deepEqual(
          sets.lists[role][w].fallers.map((e) => [e.playerId, e.score]),
          expected.fallers.map((e) => [e.playerId, e.score]),
        );
      }
    assert.ok(
      sets.lists.hitter["14d"].risers.some((e) => e.playerId === IDS.improver),
    );
    assert.ok(
      sets.lists.hitter["14d"].fallers.some((e) => e.playerId === IDS.decliner),
    );
    assert.doesNotThrow(() => JSON.stringify(sets));
  });

  test("latest top lines use only the latest completed date, ordered descriptively", () => {
    const a = u(501),
      b = u(502),
      c = u(503),
      p1 = u(511),
      p2 = u(512);
    const s = syntheticSnapshot(
      [
        { id: a, name: "Line Alpha", batting: () => bl(4, 4, 1, { hr: 1 }) },
        {
          id: b,
          name: "Line Bravo",
          batting: (d) => (d === 2 ? bl(4, 4, 3, { d: 1 }) : bl(4, 4, 0)),
        },
        {
          id: c,
          name: "Line Charlie",
          batting: (d) => (d === 1 ? bl(5, 5, 5, { hr: 3 }) : null),
        },
        { id: p1, name: "Arm One", pitching: () => pl(9, 12, { k: 4 }) },
        {
          id: p2,
          name: "Arm Two",
          pitching: () => pl(15, 20, { k: 4, er: 1 }),
        },
      ],
      3,
    );
    const lines = latestTopLines(s);
    assert.equal(lines.date, dayDate(2));
    // Bravo: 3 hits incl. a double = 4 TB; Alpha: 1 HR = 4 TB, fewer hits. Charlie did not play.
    assert.deepEqual(
      lines.hitters.map((l) => l.playerId),
      [b, a],
    );
    assert.equal(lines.hitters[0].line, "3-4, 2B");
    assert.equal(lines.hitters[1].line, "1-4, HR");
    // Equal strikeouts: more outs first.
    assert.deepEqual(
      lines.pitchers.map((l) => l.playerId),
      [p2, p1],
    );
    assert.equal(lines.pitchers[0].line, "5.0 IP, 0 H, 1 ER, 0 BB, 4 K");
    assert.equal(lines.hitters[0].team?.id, T1);
    assert.equal(lines.hitters[0].opponent?.id, T2);
    assert.deepEqual(latestTopLines(syntheticSnapshot([], 0)), {
      date: null,
      hitters: [],
      pitchers: [],
    });
  });

  test("coverage counts final, scheduled and excluded games separately", () => {
    const s = trajectorySnapshot();
    const c = coverageSummary(s);
    assert.equal(c.gamesFinal, 27);
    assert.equal(c.gamesScheduled, 1);
    assert.equal(c.gamesOther, 1); // final but incomplete box score
    assert.equal(c.asOf, dayDate(26));
    assert.ok(c.hitters > 0 && c.pitchers > 0);
    assert.match(c.leagueOps, /^\d?\.\d{3}$/);
  });

  test("top prospects are unavailable rather than fabricated", async () => {
    const r = await getTopProspects();
    assert.equal(r.status, "unavailable");
  });
});
