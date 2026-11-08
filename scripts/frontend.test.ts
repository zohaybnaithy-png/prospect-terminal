/**
 * Phase 3 frontend regressions: server-side directory query (one page instead of every row),
 * compact Trends / profile view models (display unchanged, payload smaller), and level moves
 * observed in box scores.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MOMENTUM_WINDOW_IDS } from "../src/analytics/config";
import { formatMetric, metricDefinition } from "../src/analytics/metrics";
import { persistenceLabel } from "../src/analytics/persistence";
import { mapSets, playerAnalyticsView, riserSets } from "../src/analytics/views";
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
  directorySearch,
  opportunities,
  pageList,
  parseDirectoryScope,
  parseDirectoryState,
  queryDirectory,
  type DirectoryState,
} from "../src/services/players/directory-query";
import { sortByValue } from "../src/lib/table-sort";
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
