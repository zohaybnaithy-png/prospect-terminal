/**
 * Phase 3 frontend regressions: server-side directory query (one page instead of every row),
 * compact Trends / profile view models (display unchanged, payload smaller), and level moves
 * observed in box scores.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MOMENTUM_WINDOW_IDS, type MomentumWindow, type Role } from "../src/analytics/config";
import { TrendDataStore } from "../src/components/analytics/trend-data-store";
import type { LevelId } from "../src/services/players/levels";
import { formatMetric, metricDefinition } from "../src/analytics/metrics";
import { persistenceLabel } from "../src/analytics/persistence";
import { analyticsContextFor, mapSets, playerAnalyticsView, requestContext, riserSets } from "../src/analytics/views";
import { createAnalyticsContext, momentum, playerTimeline } from "../src/analytics/engine";
import { DEFAULT_MOMENTUM_MODEL } from "../src/analytics/config";
import {
  mapPointsView,
  riserListsView,
  timelinePoints,
  timelineView,
} from "../src/analytics/trend-views";
import { aflDirectoryRows } from "../src/services/players/adapter";
import { directoryOptions, filterDirectory, type PlayerDirectoryRow } from "../src/services/players/directory";
import {
  DEFAULT_PAGE_SIZE,
  DIRECTORY_SORTS,
  battingBabip,
  battingIso,
  directorySearch,
  hasActiveFilters,
  parseAge,
  parseStatFilter,
  opportunities,
  pageList,
  parseDirectoryScope,
  parseDirectoryState,
  queryDirectory,
  type DirectoryState,
} from "../src/services/players/directory-query";
import { sortByValue } from "../src/lib/table-sort";
import { aggregateBatting, type BattingCounts } from "../src/statistics/aggregate";
import { formatRate } from "../src/services/afl/format";
import { levelMoves } from "../src/services/competition/moves";
import type { LevelSnapshot } from "../src/services/competition/types";
import { IDS, STRONG, bl, dayDate, syntheticSnapshot, trajectorySnapshot, u } from "./analytics-test-support";

const state = (patch: Partial<DirectoryState> = {}): DirectoryState => ({
  role: "hitter",
  level: "",
  window: "season",
  query: "",
  teamId: "",
  organizationId: "",
  position: "",
  minSample: 0,
  minAge: null,
  maxAge: null,
  statFilter: null,
  sort: null,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  ...patch,
});

/** Many rows: every trajectory player cloned under new ids, so pagination has several pages. */
function manyRows(copies = 30): PlayerDirectoryRow[] {
  const base = aflDirectoryRows(trajectorySnapshot()).filter((r) => r.batting);
  return Array.from({ length: copies }, (_, c) =>
    base.map((r, i) => ({ ...r, id: u(10_000 + c * 100 + i), name: `${r.name} ${c}` })),
  ).flat();
}

describe("directory query (server-side filter, sort, pagination)", () => {
  test("returns one page of the same order the client used to compute over all rows", () => {
    const rows = manyRows();
    const s = state({ sort: { key: "ops", direction: "desc" }, pageSize: 50, page: 2 });
    const result = queryDirectory(rows, s);
    // Reference: the previous client-side algorithm, over every row.
    const base = [...filterDirectory(rows, s)].sort(
      (a, b) => opportunities(b, "hitter") - opportunities(a, "hitter") || a.name.localeCompare(b.name),
    );
    const expected = sortByValue(base, (r) => r.batting?.ops ?? null, "desc");
    assert.equal(result.matched, rows.length);
    assert.equal(result.total, rows.length);
    assert.equal(result.rows.length, 50);
    assert.equal(result.offset, 50);
    assert.equal(result.pageCount, Math.ceil(rows.length / 50));
    assert.deepEqual(
      result.rows.map((r) => r.id),
      expected.slice(50, 100).map((r) => r.id),
    );
  });

  test("default order is Momentum with unavailable scores last; unknown sort keys fall back", () => {
    const rows = manyRows(2);
    const { rows: page, sort } = queryDirectory(rows, state({ sort: { key: "era", direction: "asc" } }));
    assert.deepEqual(sort, { key: "mom", direction: "desc" });
    const scores = page.map((r) => r.momentum.hitter?.score ?? null);
    const firstNull = scores.indexOf(null);
    if (firstNull >= 0) assert.ok(scores.slice(firstNull).every((s) => s === null));
    const known = scores.filter((s): s is number => s !== null);
    assert.deepEqual(known, [...known].sort((a, b) => b - a));
  });

  test("filters, minimum sample and page clamping", () => {
    const rows = manyRows();
    const q = queryDirectory(rows, state({ query: "steady star" }));
    assert.ok(q.matched > 0 && q.rows.every((r) => r.name.startsWith("Steady Star")));
    const none = queryDirectory(rows, state({ query: "no such player" }));
    assert.deepEqual([none.matched, none.rows.length, none.page, none.pageCount], [0, 0, 1, 1]);
    const min = queryDirectory(rows, state({ minSample: 50, pageSize: 250 }));
    assert.ok(min.rows.every((r) => (r.batting?.plateAppearances ?? 0) >= 50));
    const far = queryDirectory(rows, state({ page: 999, pageSize: 50 }));
    assert.equal(far.page, far.pageCount);
    assert.ok(far.rows.length > 0);
  });

  test("URL state parses defensively and round-trips", () => {
    const rows = manyRows(1);
    const options = directoryOptions(rows);
    const team = options.teams[0].id;
    const params = {
      q: "  Star  ",
      role: "pitchers",
      level: "aaa",
      team,
      org: "not-a-uuid",
      pos: "XX",
      min: "25",
      window: "14d",
      sort: "era",
      dir: "asc",
      page: "3",
      size: "250",
    };
    const scope = parseDirectoryScope(params, ["afl"]);
    assert.deepEqual(scope.role, "pitcher");
    assert.equal(scope.level, "", "a level without data is not selected");
    const s = parseDirectoryState(params, scope, options);
    assert.equal(s.query, "Star");
    assert.equal(s.teamId, team);
    assert.equal(s.organizationId, "");
    assert.equal(s.position, "");
    assert.equal(s.minSample, 25);
    assert.deepEqual(s.sort, { key: "era", direction: "asc" });
    assert.deepEqual([s.page, s.pageSize], [3, 250]);
    const again = parseDirectoryState(
      Object.fromEntries(new URLSearchParams(directorySearch(s))),
      parseDirectoryScope(Object.fromEntries(new URLSearchParams(directorySearch(s))), ["afl"]),
      options,
    );
    assert.deepEqual(again, s);
    // Junk falls back to defaults instead of erroring.
    const junk = parseDirectoryState({ page: "-4", size: "7", min: "13", sort: "<script>" }, scope, options);
    assert.deepEqual([junk.page, junk.pageSize, junk.minSample, junk.sort], [1, DEFAULT_PAGE_SIZE, 0, null]);
    assert.equal(directorySearch(state()), "");
  });

  test("page list keeps first, last and neighbours with gaps", () => {
    assert.deepEqual(pageList(1, 1), [1]);
    assert.deepEqual(pageList(1, 5), [1, 2, 3, 4, 5]);
    assert.deepEqual(pageList(10, 25), [1, null, 8, 9, 10, 11, 12, null, 25]);
    assert.deepEqual(pageList(4, 25), [1, 2, 3, 4, 5, 6, null, 25]);
    assert.deepEqual(pageList(1, 7), [1, 2, 3, null, 7]);
    assert.deepEqual(pageList(25, 25), [1, null, 23, 24, 25]);
  });
});

const counts = (patch: Partial<BattingCounts>): BattingCounts => ({
  plateAppearances: 0,
  atBats: 0,
  hits: 0,
  doubles: 0,
  triples: 0,
  homeRuns: 0,
  walks: 0,
  strikeouts: 0,
  hitByPitch: 0,
  sacrificeFlies: 0,
  stolenBases: 0,
  ...patch,
});

describe("directory depth: ISO and BABIP", () => {
  test("hand-computed values from counting fields (summed over game lines)", () => {
    // Totals: 100 AB, 30 H (6 2B, 1 3B, 5 HR), 25 SO, 3 SF.
    // AVG 30/100 = .300; SLG (30 + 6 + 2·1 + 3·5)/100 = .530; ISO .230.
    // BABIP (30 − 5)/(100 − 25 − 5 + 3) = 25/73 = .342.
    const b = aggregateBatting([
      counts({ plateAppearances: 68, atBats: 60, hits: 18, doubles: 4, homeRuns: 3, strikeouts: 15, walks: 6, sacrificeFlies: 1 }),
      counts({ plateAppearances: 48, atBats: 40, hits: 12, doubles: 2, triples: 1, homeRuns: 2, strikeouts: 10, walks: 4, hitByPitch: 2, sacrificeFlies: 2 }),
    ]);
    assert.ok(Math.abs(battingIso(b)! - 0.23) < 1e-12);
    assert.equal(battingBabip(b), 25 / 73);
    assert.equal(formatRate(battingIso(b)), ".230");
    assert.equal(formatRate(battingBabip(b)), ".342");
  });

  test("sacrifice flies count as balls in play", () => {
    // 2 AB, 2 SO, 1 SF: denominator 2 − 2 − 0 + 1 = 1, no hits → .000 (not missing).
    const b = aggregateBatting([counts({ plateAppearances: 3, atBats: 2, strikeouts: 2, sacrificeFlies: 1 })]);
    assert.equal(battingBabip(b), 0);
    assert.equal(formatRate(battingBabip(b)), ".000");
    // Without the SF the same line has no balls in play.
    const noSf = aggregateBatting([counts({ plateAppearances: 2, atBats: 2, strikeouts: 2 })]);
    assert.equal(battingBabip(noSf), null);
  });

  test("zero denominators are missing, shown as —", () => {
    // 3 AB: 1 HR, 2 SO, no SF → no balls in play. ISO is defined (SLG 4/3 − AVG 1/3 = 1).
    const tto = aggregateBatting([counts({ plateAppearances: 3, atBats: 3, hits: 1, homeRuns: 1, strikeouts: 2 })]);
    assert.equal(battingBabip(tto), null);
    assert.equal(formatRate(battingBabip(tto)), "—");
    assert.ok(Math.abs(battingIso(tto)! - 1) < 1e-12);
    // Walks only: AB 0 → AVG/SLG and so ISO are missing; BABIP denominator 0 too.
    const walks = aggregateBatting([counts({ plateAppearances: 4, walks: 4 })]);
    assert.equal(battingIso(walks), null);
    assert.equal(formatRate(battingIso(walks)), "—");
    assert.equal(battingBabip(walks), null);
  });

  test("columns are sortable hitter keys with unavailable values last", () => {
    assert.ok(DIRECTORY_SORTS.hitter.iso && DIRECTORY_SORTS.hitter.babip);
    assert.ok(!DIRECTORY_SORTS.pitcher.iso && !DIRECTORY_SORTS.pitcher.babip);
    const rows = manyRows(2);
    for (const key of ["iso", "babip"]) {
      const { rows: page, sort } = queryDirectory(rows, state({ sort: { key, direction: "desc" }, pageSize: 250 }));
      assert.deepEqual(sort, { key, direction: "desc" });
      const values = page.map((r) => DIRECTORY_SORTS.hitter[key](r) as number | null);
      const firstNull = values.indexOf(null);
      if (firstNull >= 0) assert.ok(values.slice(firstNull).every((v) => v === null));
      const known = values.filter((v): v is number => v !== null);
      assert.ok(known.length > 0);
      assert.deepEqual(known, [...known].sort((a, b) => b - a));
    }
  });
});

describe("directory depth: age and stat-threshold filters", () => {
  /** Ages 18–29 by position; every fifth row has an unknown age. */
  const aged = () => manyRows(2).map((r, i) => ({ ...r, age: i % 5 === 0 ? null : 18 + (i % 12) }));

  test("age parsing: whole years 15–45, everything else dropped", () => {
    assert.deepEqual(
      ["15", "45", " 22 ", "14", "46", "20.5", "-20", "abc", "", "1e1", "100"].map(parseAge),
      [15, 45, 22, null, null, null, null, null, null, null, null],
    );
  });

  test("age bounds are inclusive; unknown ages are excluded only when a bound is set", () => {
    const rows = aged();
    assert.ok(rows.some((r) => r.age === null));
    assert.equal(queryDirectory(rows, state({ pageSize: 250 })).matched, rows.length);
    const band = queryDirectory(rows, state({ minAge: 20, maxAge: 23, pageSize: 250 }));
    assert.equal(band.matched, rows.filter((r) => r.age !== null && r.age >= 20 && r.age <= 23).length);
    assert.ok(band.rows.every((r) => r.age !== null && r.age >= 20 && r.age <= 23));
    assert.ok(band.rows.some((r) => r.age === 20) && band.rows.some((r) => r.age === 23));
    const min = queryDirectory(rows, state({ minAge: 27, pageSize: 250 }));
    assert.equal(min.matched, rows.filter((r) => r.age !== null && r.age >= 27).length);
    const max = queryDirectory(rows, state({ maxAge: 19, pageSize: 250 }));
    assert.equal(max.matched, rows.filter((r) => r.age !== null && r.age <= 19).length);
    assert.equal(queryDirectory(rows, state({ minAge: 30, maxAge: 20 })).matched, 0);
  });

  test("stat parsing: per-role allow-list, gte|lte, finite plain decimals in range", () => {
    assert.deepEqual(parseStatFilter("hitter", "ops", "gte", "0.800"), { stat: "ops", op: "gte", value: 0.8 });
    assert.deepEqual(parseStatFilter("hitter", "ops", "lte", ".750"), { stat: "ops", op: "lte", value: 0.75 });
    assert.deepEqual(parseStatFilter("hitter", "kp", "lte", "25"), { stat: "kp", op: "lte", value: 25 });
    assert.deepEqual(parseStatFilter("hitter", "babip", "gte", "0.3"), { stat: "babip", op: "gte", value: 0.3 });
    assert.deepEqual(parseStatFilter("pitcher", "kbb", "gte", "-5"), { stat: "kbb", op: "gte", value: -5 });
    assert.deepEqual(parseStatFilter("pitcher", "era", "lte", "3.50"), { stat: "era", op: "lte", value: 3.5 });
    for (const stat of ["avg", "obp", "slg", "ops", "iso", "babip", "bbp", "kp"])
      assert.ok(parseStatFilter("hitter", stat, "gte", "0.2"), stat);
    for (const stat of ["era", "whip", "kp", "bbp", "kbb"])
      assert.ok(parseStatFilter("pitcher", stat, "gte", "1"), stat);
    for (const [role, stat, op, value] of [
      ["hitter", "era", "lte", "3"], // pitcher-only column
      ["pitcher", "ops", "gte", ".8"], // hitter-only column
      ["hitter", "hr", "gte", "5"], // counting column, not a rate
      ["hitter", "mom", "gte", "10"],
      ["hitter", "constructor", "gte", "1"],
      ["hitter", "ops", "gt", ".8"],
      ["hitter", "ops", "", ".8"],
      ["hitter", "ops", "gte", ""],
      ["hitter", "ops", "gte", "abc"],
      ["hitter", "ops", "gte", "Infinity"],
      ["hitter", "ops", "gte", "NaN"],
      ["hitter", "ops", "gte", "1e3"],
      ["hitter", "kp", "gte", "0x10"],
      ["hitter", "avg", "gte", "1.5"], // above range
      ["hitter", "ops", "gte", "-0.1"], // below range
      ["hitter", "kp", "gte", "101"],
      ["pitcher", "kbb", "gte", "-101"],
      ["hitter", "ops", "gte", "0.80000000000001"], // too long
    ] as const)
      assert.equal(parseStatFilter(role, stat, op, value), null, `${role} ${stat} ${op} ${value}`);
  });

  test("threshold keeps rows at or beyond the value; undefined values are excluded", () => {
    const rows = manyRows(2);
    const ops = (r: PlayerDirectoryRow) => r.batting?.ops ?? null;
    const known = rows.map(ops).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const mid = known[Math.floor(known.length / 2)];
    const gte = queryDirectory(rows, state({ statFilter: { stat: "ops", op: "gte", value: mid }, pageSize: 250 }));
    assert.equal(gte.matched, known.filter((v) => v >= mid).length);
    assert.ok(gte.rows.every((r) => ops(r) !== null && ops(r)! >= mid));
    const lte = queryDirectory(rows, state({ statFilter: { stat: "ops", op: "lte", value: mid }, pageSize: 250 }));
    assert.equal(lte.matched, known.filter((v) => v <= mid).length);
    assert.ok(lte.rows.every((r) => ops(r) !== null && ops(r)! <= mid));
    // A row without the stat (BABIP with no balls in play) never passes an active filter.
    const noBip = rows.map((r, i) =>
      i === 0 ? { ...r, batting: { ...r.batting!, ...counts({ plateAppearances: 2, walks: 2 }) } } : r,
    );
    assert.equal(battingBabip(noBip[0].batting!), null);
    const babip = queryDirectory(noBip, state({ statFilter: { stat: "babip", op: "gte", value: 0 }, pageSize: 250 }));
    assert.ok(!babip.rows.some((r) => r.id === noBip[0].id));
    assert.equal(babip.matched, noBip.filter((r) => battingBabip(r.batting!) !== null).length);
  });

  test("percent thresholds are in percent units (25 = 25%)", () => {
    const rows = manyRows(2);
    const res = queryDirectory(rows, state({ statFilter: { stat: "kp", op: "lte", value: 25 }, pageSize: 250 }));
    assert.equal(res.matched, rows.filter((r) => r.batting!.kPct !== null && r.batting!.kPct <= 25).length);
    assert.ok(res.rows.every((r) => r.batting!.kPct! <= 25));
  });

  test("combines with minimum sample and the other filters", () => {
    const rows = aged();
    const res = queryDirectory(
      rows,
      state({ statFilter: { stat: "obp", op: "gte", value: 0.3 }, minSample: 25, minAge: 19, pageSize: 250 }),
    );
    const expected = rows.filter(
      (r) =>
        r.batting!.plateAppearances >= 25 &&
        r.age !== null &&
        r.age >= 19 &&
        r.batting!.obp !== null &&
        r.batting!.obp >= 0.3,
    );
    assert.equal(res.matched, expected.length);
    assert.deepEqual(new Set(res.rows.map((r) => r.id)), new Set(expected.map((r) => r.id)));
  });

  test("new params round-trip with sort, pagination and every existing param", () => {
    const rows = manyRows(1);
    const options = directoryOptions(rows);
    const params = {
      q: "star",
      team: options.teams[0].id,
      min: "10",
      window: "30d",
      minAge: "19",
      maxAge: "24",
      stat: "ops",
      op: "gte",
      value: "0.800",
      sort: "babip",
      dir: "asc",
      page: "2",
      size: "50",
    };
    const s = parseDirectoryState(params, parseDirectoryScope(params, ["afl"]), options);
    assert.deepEqual([s.minAge, s.maxAge], [19, 24]);
    assert.deepEqual(s.statFilter, { stat: "ops", op: "gte", value: 0.8 });
    assert.deepEqual(s.sort, { key: "babip", direction: "asc" });
    assert.deepEqual([s.page, s.pageSize, s.minSample, s.window], [2, 50, 10, "30d"]);
    assert.ok(hasActiveFilters(s));
    const sp = new URLSearchParams(directorySearch(s));
    assert.deepEqual(
      [sp.get("minAge"), sp.get("maxAge"), sp.get("stat"), sp.get("op"), sp.get("value"), sp.get("page")],
      ["19", "24", "ops", "gte", "0.8", "2"],
    );
    const back = Object.fromEntries(sp);
    assert.deepEqual(parseDirectoryState(back, parseDirectoryScope(back, ["afl"]), options), s);
    // Page links keep the new filters (the component builds them from state with a new page).
    const next = new URLSearchParams(directorySearch({ ...s, page: 3 }));
    assert.deepEqual(
      [next.get("minAge"), next.get("stat"), next.get("value"), next.get("sort"), next.get("page")],
      ["19", "ops", "0.8", "babip", "3"],
    );
    // Invalid values are dropped silently, and a stat from the other role does not apply.
    const junk = { minAge: "12", maxAge: "x", stat: "era", op: "lte", value: "3" };
    const j = parseDirectoryState(junk, parseDirectoryScope(junk, ["afl"]), options);
    assert.deepEqual([j.minAge, j.maxAge, j.statFilter], [null, null, null]);
    assert.equal(directorySearch(j), "");
    const pit = { role: "pitchers", stat: "era", op: "lte", value: "3" };
    assert.deepEqual(parseDirectoryState(pit, parseDirectoryScope(pit, ["afl"]), options).statFilter, {
      stat: "era",
      op: "lte",
      value: 3,
    });
    assert.ok(!hasActiveFilters(state()));
  });
});

describe("compact Trends and profile views keep what is displayed", () => {
  const snapshot = trajectorySnapshot();

  test("risers: formatted change and persistence equal the previous component output", () => {
    const sets = riserSets(snapshot);
    const view = riserListsView(sets);
    assert.deepEqual(view.comparable, sets.comparable);
    let checked = 0;
    for (const role of ["hitter", "pitcher"] as const)
      for (const w of MOMENTUM_WINDOW_IDS)
        for (const [cat, lists] of Object.entries(sets.lists[role][w])) {
          const compact = view.lists[role][w][cat as keyof typeof view.lists.hitter["7d"]]!;
          for (const side of ["risers", "fallers"] as const)
            lists![side].forEach((e, i) => {
              const c = compact[side][i];
              assert.equal(c.playerId, e.playerId);
              assert.equal(
                c.keyChange,
                `${metricDefinition(e.keyMetric).label} ${formatMetric(e.keyMetric, e.keyBefore)} → ${formatMetric(e.keyMetric, e.keyNow)}`,
              );
              const label = persistenceLabel({ state: e.persistenceState, direction: e.persistenceDirection });
              assert.equal(
                c.persistence,
                e.persistenceState === "insufficient" || e.persistenceState === "neutral"
                  ? label
                  : `${label} · ${e.trendLengthDays} days`,
              );
              assert.deepEqual([c.value, c.score, c.confidence], [e.value, e.score, e.confidence]);
              checked++;
            });
        }
    assert.ok(checked > 0);
    assert.ok(JSON.stringify(view).length < JSON.stringify(sets).length);
  });

  test("map points: same players, percentiles and formatted values", () => {
    const sets = mapSets(snapshot);
    for (const role of ["hitter", "pitcher"] as const)
      for (const w of MOMENTUM_WINDOW_IDS) {
        const full = sets[role][w];
        const compact = mapPointsView(sets, role, w);
        assert.deepEqual(compact.map((p) => p.id), full.map((p) => p.playerId));
        compact.forEach((p, i) => {
          assert.equal(p.y, full[i].y);
          for (const [metric, [pctl, value]] of Object.entries(full[i].xs))
            assert.deepEqual(p.xs[metric], [pctl, formatMetric(metric, value)]);
        });
      }
  });

  test("timelines: columnar form restores every displayed field", () => {
    const view = playerAnalyticsView(snapshot, IDS.improver);
    assert.ok(view.roles.length > 0);
    for (const r of view.roles)
      for (const w of MOMENTUM_WINDOW_IDS) {
        const t = r.timelines[w];
        const compact = timelineView(t);
        assert.deepEqual(
          timelinePoints(compact),
          t.points.map(({ rawScore: _r, reliability: _l, persistenceState: _p, ...rest }) => {
            void _r;
            void _l;
            void _p;
            return rest;
          }),
        );
        assert.ok(JSON.stringify(compact).length < JSON.stringify(t).length);
      }
  });
});

describe("level moves observed in box scores", () => {
  const A = u(501),
    B = u(502),
    C = u(503);
  const hit = () => STRONG[0];
  const levels: LevelSnapshot[] = [
    {
      level: "aa",
      snapshot: syntheticSnapshot([
        { id: A, name: "Promoted Player", batting: (d) => (d < 15 ? hit() : null) },
        { id: B, name: "Stays Put", batting: hit },
        { id: C, name: "Sent Down", batting: (d) => (d >= 10 ? hit() : null) },
      ]),
    },
    {
      level: "aaa",
      snapshot: syntheticSnapshot([
        { id: A, name: "Promoted Player", batting: (d) => (d >= 15 ? hit() : null) },
        { id: C, name: "Sent Down", batting: (d) => (d < 10 ? hit() : null) },
      ]),
    },
    // AFL assignments are not level moves.
    { level: "afl", snapshot: syntheticSnapshot([{ id: B, name: "Stays Put", batting: (d) => (d > 20 ? bl(4, 1, 1) : null) }]) },
  ];

  test("finds promotions and demotions at the first game at the new level", () => {
    const moves = levelMoves(levels);
    assert.deepEqual(
      moves.map((m) => [m.name, m.from, m.to, m.date, m.up]),
      [
        ["Promoted Player", "aa", "aaa", dayDate(15), true],
        ["Sent Down", "aaa", "aa", dayDate(10), false],
      ],
    );
    // Lines from the non-final and incomplete synthetic games are not counted as games.
    assert.equal(moves[0].games, 27 - 15);
    assert.equal(moves[0].team?.abbreviation, "SSG");
  });

  test("scopes to a level and limits", () => {
    assert.equal(levelMoves(levels, { involving: "high-a" }).length, 0);
    assert.equal(levelMoves(levels, { involving: "aaa" }).length, 2);
    assert.equal(levelMoves(levels, { limit: 1 }).length, 1);
    assert.deepEqual(levelMoves([levels[0]]), []);
  });
});

describe("Trends on-demand data cache (per level × role × window)", () => {
  type Pending = { url: string; resolve: (v: unknown) => void; reject: (e: Error) => void };
  const setup = () => {
    const pending: Pending[] = [];
    const store = new TrendDataStore<string>("risers", (url) => new Promise((resolve, reject) => pending.push({ url, resolve, reject })));
    let renders = 0;
    store.subscribe(() => renders++);
    const param = (p: Pending, k: string) => new URL(p.url, "http://x").searchParams.get(k);
    return { store, pending, param, renders: () => renders };
  };
  const sel = (level: LevelId, role: Role = "hitter", window: MomentumWindow = "14d") => ({ level, role, window });
  const flush = () => new Promise((r) => setImmediate(r));

  test("switching level never shows another level's data; the new page's embedded data is used at once", async () => {
    const { store, pending, param } = setup();
    const aaa = { ...sel("aaa"), data: "AAA hitters 14d" };
    // On AAA the user opens pitchers 30D: fetched for AAA.
    store.ensure(sel("aaa", "pitcher", "30d"), aaa);
    assert.deepEqual([param(pending[0], "level"), param(pending[0], "role"), param(pending[0], "window")], ["aaa", "pitcher", "30d"]);
    pending[0].resolve("AAA pitchers 30d");
    await flush();
    assert.deepEqual(store.state(sel("aaa", "pitcher", "30d"), aaa), { status: "ok", data: "AAA pitchers 30d" });
    // Navigate to AA (component state survives): same role × window is NOT the AAA entry.
    const aa = { ...sel("aa"), data: "AA hitters 14d" };
    assert.deepEqual(store.state(sel("aa", "pitcher", "30d"), aa), { status: "loading" });
    store.ensure(sel("aa", "pitcher", "30d"), aa);
    assert.equal(param(pending[1], "level"), "aa");
    // The default selection comes from the new page's props, not from the first level's.
    assert.deepEqual(store.state(sel("aa"), aa), { status: "ok", data: "AA hitters 14d" });
    pending[1].resolve("AA pitchers 30d");
    await flush();
    assert.deepEqual(store.state(sel("aa", "pitcher", "30d"), aa), { status: "ok", data: "AA pitchers 30d" });
    // Back on AAA, its own cached entry and its own embedded data.
    assert.deepEqual(store.state(sel("aaa", "pitcher", "30d"), aaa), { status: "ok", data: "AAA pitchers 30d" });
    assert.deepEqual(store.state(sel("aaa"), aaa), { status: "ok", data: "AAA hitters 14d" });
  });

  test("rapid switching: one request per selection, and late responses fill only their own entry", async () => {
    const { store, pending } = setup();
    const initial = { ...sel("aa"), data: "embedded" };
    store.ensure(sel("aa", "hitter", "7d"), initial);
    store.ensure(sel("aa", "hitter", "30d"), initial);
    store.ensure(sel("aa", "hitter", "7d"), initial); // back again while in flight: no duplicate
    store.ensure(sel("aa"), initial); // the embedded selection is never fetched
    assert.equal(pending.length, 2);
    // The user is now on 30D; the 30D answer arrives first, the stale 7D answer last.
    pending[1].resolve("30d");
    await flush();
    pending[0].resolve("7d");
    await flush();
    assert.deepEqual(store.state(sel("aa", "hitter", "30d"), initial), { status: "ok", data: "30d" });
    assert.deepEqual(store.state(sel("aa", "hitter", "7d"), initial), { status: "ok", data: "7d" });
    // Same role × window at another level is a separate request.
    store.ensure(sel("high-a", "hitter", "30d"), sel("high-a"));
    assert.equal(pending.length, 3);
  });

  test("a failed request shows an error for that selection only, and retry requests it again", async () => {
    const { store, pending, renders } = setup();
    const initial = { ...sel("single-a"), data: "embedded" };
    store.ensure(sel("single-a", "pitcher", "7d"), initial);
    store.ensure(sel("single-a", "pitcher", "14d"), initial);
    pending[0].reject(new Error("503"));
    pending[1].resolve("pitchers 14d");
    await flush();
    const failed = store.state(sel("single-a", "pitcher", "7d"), initial);
    assert.equal(failed.status, "error");
    assert.deepEqual(store.state(sel("single-a", "pitcher", "14d"), initial), { status: "ok", data: "pitchers 14d" });
    assert.deepEqual(store.state(sel("aa", "pitcher", "7d"), { ...sel("aa"), data: "y" }), { status: "loading" });
    // A failure is not re-requested on its own (no retry loop)…
    store.ensure(sel("single-a", "pitcher", "7d"), initial);
    assert.equal(pending.length, 2);
    // …only when the user retries.
    const before = renders();
    if (failed.status === "error") failed.retry();
    assert.ok(renders() > before);
    assert.deepEqual(store.state(sel("single-a", "pitcher", "7d"), initial), { status: "loading" });
    store.ensure(sel("single-a", "pitcher", "7d"), initial);
    assert.equal(pending.length, 3);
    pending[2].resolve("pitchers 7d");
    await flush();
    assert.deepEqual(store.state(sel("single-a", "pitcher", "7d"), initial), { status: "ok", data: "pitchers 7d" });
    // An unavailable window is neither requested by the hook nor reported from the cache.
    assert.deepEqual(store.state(sel("single-a", "pitcher", "7d"), initial, true), { status: "loading" });
  });
});

describe("profile analytics do not grow the shared per-snapshot caches", () => {
  test("same view as computing on the shared context, and the shared caches stay the same size", () => {
    const snapshot = trajectorySnapshot();
    const shared = analyticsContextFor(snapshot);
    // Warm the shared context like the server does (current-date Momentum for every player).
    for (const p of snapshot.players)
      for (const role of ["hitter", "pitcher"] as const)
        for (const w of MOMENTUM_WINDOW_IDS) momentum(shared, p.id, role, w, DEFAULT_MOMENTUM_MODEL);
    const sizes = () => [shared.changeCache.size, shared.momentumCache.size];
    const before = sizes();
    const views = snapshot.players.map((p) => playerAnalyticsView(snapshot, p.id));
    assert.deepEqual(sizes(), before, "profile timelines are request-scoped");
    // Reference: the same computation written into a separate, ordinary context.
    const reference = createAnalyticsContext(snapshot);
    snapshot.players.forEach((p, i) => {
      for (const r of views[i].roles)
        for (const w of MOMENTUM_WINDOW_IDS) {
          assert.deepEqual(r.timelines[w], playerTimeline(reference, p.id, r.role, w, DEFAULT_MOMENTUM_MODEL));
          assert.deepEqual(r.momentum[w], momentum(reference, p.id, r.role, w, DEFAULT_MOMENTUM_MODEL));
        }
    });
    assert.ok(views.some((v) => v.roles.some((r) => r.timelines["14d"].points.length > 0)));
  });

  test("a request context reads shared entries but writes only to itself", () => {
    const shared = analyticsContextFor(trajectorySnapshot());
    shared.momentumCache.set("probe", { probe: true } as never);
    const req = requestContext(shared);
    assert.deepEqual(req.momentumCache.get("probe"), { probe: true });
    assert.ok(req.momentumCache.has("probe"));
    req.momentumCache.set("mine", { mine: true } as never);
    assert.equal(shared.momentumCache.has("mine"), false);
    assert.equal(req.ds, shared.ds);
    assert.equal(req.scaleCache, shared.scaleCache);
  });
});
