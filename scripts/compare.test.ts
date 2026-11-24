/**
 * Player comparison (/compare, T-201): URL parsing, the comparison view model over fictional
 * fixture snapshots, best-value direction logic, per-player notices and the table markup.
 * No database, no real players.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_MOMENTUM_MODEL, DEFAULT_MOMENTUM_WINDOW, PERCENTILE_CATEGORIES } from "../src/analytics/config";
import { momentum } from "../src/analytics/engine";
import { formatMetric, metricValue } from "../src/analytics/metrics";
import { analyticsContextFor, playerAnalyticsView } from "../src/analytics/views";
import { CompareTable } from "../src/components/compare/compare-table";
import { SEASON_ROWS, bestIndexes, compareView, type CompareView } from "../src/services/compare/model";
import {
  COMPARE_MAX,
  addToCompareLink,
  compareHref,
  existingCompareIds,
  parseCompareQuery,
} from "../src/services/compare/query";
import type { LevelSnapshot } from "../src/services/competition/types";
import { aflDirectoryRows, levelDirectoryRows } from "../src/services/players/adapter";
import { IDS, trajectorySnapshot, u } from "./analytics-test-support";
import { playerId, scaleSnapshot } from "./milb-scale-support";

const A = u(31),
  B = u(32),
  C = u(33),
  D = u(34),
  E = u(35);

describe("parseCompareQuery", () => {
  test("valid input: level, ids in order, role defaults to hitters", () => {
    const q = parseCompareQuery({ level: "aa", ids: `${A},${B}` });
    assert.deepEqual(q, { level: "aa", levelProblem: null, role: "hitter", ids: [A, B], notices: [] });
    assert.equal(parseCompareQuery({ level: "aa", ids: `${A},${B}`, role: "pitchers" }).role, "pitcher");
    assert.equal(parseCompareQuery({ level: "aa", ids: `${A},${B}`, role: "goalies" }).role, "hitter");
  });

  test("ids are trimmed and lower-cased; duplicates are dropped with a notice", () => {
    const q = parseCompareQuery({ level: "afl", ids: ` ${A.toUpperCase()} ,${B},${A},,${B}` });
    assert.deepEqual(q.ids, [A, B]);
    assert.deepEqual(q.notices, ["2 duplicate player ids were ignored."]);
  });

  test(`more than ${COMPARE_MAX} ids: the first ${COMPARE_MAX} are kept`, () => {
    const q = parseCompareQuery({ level: "afl", ids: [A, B, C, D, E].join(",") });
    assert.deepEqual(q.ids, [A, B, C, D]);
    assert.deepEqual(q.notices, [`Up to ${COMPARE_MAX} players can be compared; 1 more was left out.`]);
  });

  test("malformed ids are dropped, never fatal", () => {
    const q = parseCompareQuery({ level: "afl", ids: `${A},not-a-uuid,${B.slice(0, -1)},'; drop table` });
    assert.deepEqual(q.ids, [A]);
    assert.deepEqual(q.notices, ["3 invalid player ids were ignored."]);
  });

  test("unknown or missing level", () => {
    const unknown = parseCompareQuery({ level: "mlb", ids: `${A},${B}` });
    assert.equal(unknown.level, null);
    assert.equal(unknown.levelProblem, "unknown");
    assert.match(unknown.notices[0], /not recognised/);
    const missing = parseCompareQuery({ ids: `${A},${B}` });
    assert.equal(missing.level, null);
    assert.equal(missing.levelProblem, "missing");
    assert.deepEqual(missing.notices, [], "no level is an instruction, not an error");
  });

  test("repeated (array) parameters are ignored rather than guessed", () => {
    const q = parseCompareQuery({ level: ["aa", "aaa"], ids: [A, B], role: ["pitchers"] });
    assert.deepEqual([q.level, q.ids, q.role], [null, [], "hitter"]);
  });

  test("the add field accepts a pasted profile link or a bare id", () => {
    assert.deepEqual(parseCompareQuery({ level: "aa", ids: A, add: `https://example.test/players/${B}?level=aa` }).ids, [A, B]);
    assert.deepEqual(parseCompareQuery({ level: "aa", add: B.toUpperCase() }).ids, [B]);
    const junk = parseCompareQuery({ level: "aa", ids: A, add: "Steady Star" });
    assert.deepEqual(junk.ids, [A]);
    assert.match(junk.notices[0], /Couldn't find a player id/);
    assert.deepEqual(parseCompareQuery({ level: "aa", ids: `${A},${B}`, add: A }).notices, ["1 duplicate player id was ignored."]);
  });

  test("compareHref is canonical and round-trips", () => {
    assert.equal(compareHref({ level: "aa", ids: [A, B] }), `/compare?level=aa&ids=${A},${B}`);
    assert.equal(compareHref({ level: "aa", ids: [A], role: "pitcher" }), `/compare?level=aa&ids=${A}&role=pitchers`);
    assert.equal(compareHref({ level: null, ids: [] }), "/compare");
    const href = compareHref({ level: "high-a", ids: [A, B, C], role: "pitcher" });
    const q = parseCompareQuery(Object.fromEntries(new URL(href, "https://x.test").searchParams));
    assert.deepEqual([q.level, q.ids, q.role, q.notices], ["high-a", [A, B, C], "pitcher", []]);
  });

  test("profile 'Add to compare': new list, append, already included, full", () => {
    assert.deepEqual(addToCompareLink(A, "aa", "hitter"), { href: `/compare?level=aa&ids=${A}`, included: false, full: false });
    assert.equal(addToCompareLink(B, "aa", "pitcher", [A]).href, `/compare?level=aa&ids=${A},${B}&role=pitchers`);
    assert.deepEqual(addToCompareLink(A, "aa", "hitter", [A, B]), { href: `/compare?level=aa&ids=${A},${B}`, included: true, full: false });
    const full = addToCompareLink(E, "aa", "hitter", [A, B, C, D]);
    assert.equal(full.full, true);
    assert.equal(full.href, `/compare?level=aa&ids=${[A, B, C, D].join(",")}`, "a full list is shown unchanged");
    assert.deepEqual(existingCompareIds({ ids: `${A},bad,${A}` }), [A]);
    assert.deepEqual(existingCompareIds({}), []);
  });
});

describe("bestIndexes (direction from the metric registry)", () => {
  test("higher is better / lower is better", () => {
    assert.deepEqual([...bestIndexes([0.3, 0.25, null], 1)], [0]);
    assert.deepEqual([...bestIndexes([4.5, 2.1, 3.0], -1, 2)], [1]);
  });
  test("ties for best are all marked; all-equal, single value and no direction mark nothing", () => {
    assert.deepEqual([...bestIndexes([0.3, 0.3, 0.2], 1)], [0, 1]);
    assert.deepEqual([...bestIndexes([0.3, 0.3], 1)], []);
    assert.deepEqual([...bestIndexes([0.3, null, null], 1)], []);
    assert.deepEqual([...bestIndexes([10, 20], null)], []);
  });
  test("values equal at the displayed precision are ties", () => {
    assert.deepEqual([...bestIndexes([0.3001, 0.2999], 1, 3)], [], ".300 vs .300");
    assert.deepEqual([...bestIndexes([12.04, 12.01, 9], 1, 1)], [0, 1], "12.0% vs 12.0%");
  });
  test("metric directions used by the compare rows", () => {
    const view = okView([IDS.star, IDS.improver], "hitter");
    const dir = Object.fromEntries(view.groups[0].rows.map((r) => [r.id, r.direction]));
    assert.deepEqual(dir, { g: null, pa: null, avg: 1, obp: 1, slg: 1, ops: 1, iso: 1, bbPct: 1, kPct: -1, hr: null, sb: null });
    const p = okView([IDS.pSteady, IDS.pDecliner], "pitcher");
    const pdir = Object.fromEntries(p.groups[0].rows.map((r) => [r.id, r.direction]));
    assert.deepEqual(pdir, { g: null, ip: null, bf: null, era: -1, whip: -1, kPct: 1, bbPct: -1, kbb: 1, hr: null });
  });
});

// ---- view model -------------------------------------------------------------------------------

const afl = trajectorySnapshot();
const aa = scaleSnapshot({ ns: 2, level: "aa", teams: 4, days: 20, seed: 2 });
const LEVELS: LevelSnapshot[] = [
  { level: "aa", snapshot: aa },
  { level: "afl", snapshot: afl },
];
const view = (params: Record<string, string>) => compareView(LEVELS, parseCompareQuery(params));
function okView(ids: string[], role: "hitter" | "pitcher", level: "afl" | "aa" = "afl") {
  const v = view({ level, ids: ids.join(","), ...(role === "pitcher" ? { role: "pitchers" } : {}) });
  assert.equal(v.status, "ok");
  return v as Extract<CompareView, { status: "ok" }>;
}
const row = (v: Extract<CompareView, { status: "ok" }>, id: string) =>
  v.groups.flatMap((g) => g.rows).find((r) => r.id === id)!;

describe("compareView", () => {
  test("hitters: season line equals the directory rows; best OPS / K% by direction", () => {
    const ids = [IDS.star, IDS.improver, IDS.decliner];
    const v = okView(ids, "hitter");
    assert.deepEqual(v.players.map((p) => p.name), ["Steady Star", "Steady Improver", "Late Decliner"]);
    assert.deepEqual(v.players.map((p) => p.notice), [null, null, null]);
    const dir = new Map(aflDirectoryRows(afl).map((r) => [r.id, r]));
    for (const [i, id] of ids.entries()) {
      const b = dir.get(id)!.batting!;
      assert.equal(row(v, "pa").cells[i]!.text, String(b.plateAppearances));
      assert.equal(v.players[i].opportunities, b.plateAppearances, "sample size shown per player");
      assert.equal(row(v, "g").cells[i]!.text, String(b.gameLines));
      assert.equal(row(v, "ops").cells[i]!.text, formatMetric("ops", b.ops));
      assert.equal(row(v, "iso").cells[i]!.value, metricValue("iso", b), "ISO from the analytics registry");
      assert.equal(row(v, "kPct").cells[i]!.text, formatMetric("hitterKPct", b.kPct));
    }
    const ops = row(v, "ops").cells.map((c) => c!.value!);
    assert.deepEqual(row(v, "ops").cells.map((c) => c!.best), ops.map((x) => x === Math.max(...ops)));
    const k = row(v, "kPct").cells.map((c) => c!.value!);
    assert.deepEqual(row(v, "kPct").cells.map((c) => c!.best), k.map((x) => x === Math.min(...k)), "lower K% is better for hitters");
    for (const id of ["g", "pa", "hr", "sb", "momentum", "confidence", "pct-sample"])
      assert.ok(row(v, id).cells.every((c) => !c!.best), `${id} is never emphasized`);
    assert.equal(v.groups[0].rows.length, SEASON_ROWS.hitter.length);
  });

  test("percentiles are the profile's fingerprint categories; Momentum is the default-window result", () => {
    const ids = [IDS.star, IDS.improver];
    const v = okView(ids, "hitter");
    const pct = v.groups.find((g) => g.id === "percentiles")!;
    assert.deepEqual(
      pct.rows.map((r) => r.label),
      [...PERCENTILE_CATEGORIES.hitter.map((c) => c.label), "Percentile sample"],
    );
    const ctx = analyticsContextFor(afl);
    for (const [i, id] of ids.entries()) {
      const fp = playerAnalyticsView(afl, id).roles.find((r) => r.role === "hitter")!.fingerprint;
      fp.categories.forEach((c, ci) => assert.equal(pct.rows[ci].cells[i]!.value, c.percentile, `${id} ${c.id}`));
      assert.equal(pct.rows.at(-1)!.cells[i]!.text, fp.qualified ? "Qualified" : `Below ${fp.minOpportunities} PA`);
      const m = momentum(ctx, id, "hitter", DEFAULT_MOMENTUM_WINDOW, DEFAULT_MOMENTUM_MODEL);
      assert.equal(row(v, "momentum").cells[i]!.value, m.score);
      assert.equal(row(v, "momentum").cells[i]!.detail, m.band?.label ?? "Not enough data");
      if (m.status === "ok") {
        assert.equal(row(v, "confidence").cells[i]!.text, { low: "Low", medium: "Medium", high: "High" }[m.confidence]);
        assert.equal(row(v, "confidence").cells[i]!.detail, `${m.sample.recent} recent / ${m.sample.baseline} earlier PA`);
      }
    }
    assert.equal(v.momentumWindowLabel, "Last 14 days");
    assert.ok(v.percentilePopulation && v.percentilePopulation.minOpportunities === 30);
  });

  test("pitchers: lower ERA / WHIP / BB% is best; K−BB% from the registry", () => {
    const ids = [IDS.pSteady, IDS.pDecliner, IDS.pImprover];
    const v = okView(ids, "pitcher");
    const dir = new Map(aflDirectoryRows(afl).map((r) => [r.id, r]));
    for (const [i, id] of ids.entries()) {
      const p = dir.get(id)!.pitching!;
      assert.equal(row(v, "bf").cells[i]!.text, String(p.battersFaced));
      assert.equal(row(v, "era").cells[i]!.text, formatMetric("era", p.era));
      assert.equal(row(v, "kbb").cells[i]!.value, metricValue("kMinusBbPct", p));
    }
    const era = row(v, "era").cells.map((c) => Math.round(c!.value! * 100));
    assert.deepEqual(row(v, "era").cells.map((c) => c!.best), era.map((x) => x === Math.min(...era)));
    assert.ok(row(v, "era").cells.some((c) => c!.best));
  });

  test("players missing at the level or lacking the role get a notice, never values", () => {
    const otherLevel = levelDirectoryRows(aa, "aa").find((r) => r.batting)!;
    const unknown = "00000000-0000-4000-8000-00000000abcd";
    const v = okView([IDS.star, IDS.pSteady, otherLevel.id, unknown], "hitter");
    assert.deepEqual(
      v.players.map((p) => [p.name, p.available, p.notice]),
      [
        ["Steady Star", true, null],
        ["Arm Steady", false, "No Arizona Fall League batting line"],
        [otherLevel.name, false, "No Arizona Fall League batting line"],
        [null, false, "Player not found in the 2026 data"],
      ],
    );
    for (const g of v.groups) for (const r of g.rows) assert.deepEqual(r.cells.slice(1), [null, null, null], `${r.id}: no fabricated values`);
    assert.ok(v.groups[0].rows.every((r) => !r.cells[0]!.best), "one value is never 'best'");
    // The same pitcher compared as a pitcher has a line.
    const p = okView([IDS.pSteady, IDS.twoWay], "pitcher");
    assert.deepEqual(p.players.map((x) => x.available), [true, true]);
    // A two-way player has both lines; the role chooses which one is compared.
    assert.equal(okView([IDS.twoWay, IDS.star], "hitter").players[0].available, true);
  });

  test("statistics are from the requested level only", () => {
    const aaHitters = levelDirectoryRows(aa, "aa").filter((r) => r.batting).slice(0, 2);
    const v = okView(aaHitters.map((r) => r.id), "hitter", "aa");
    assert.deepEqual(row(v, "pa").cells.map((c) => c!.text), aaHitters.map((r) => String(r.batting!.plateAppearances)));
    assert.equal(v.seasonName, aa.season.name);
    // A shared-identity fixture: one player at two levels shows each level's own line.
    const shared = playerId(9, 1);
    const lvlA = scaleSnapshot({ ns: 4, level: "aa", teams: 2, days: 10, seed: 4, sharedPlayers: [{ id: shared, name: "Shared Mover", role: "hitter", toDay: 4 }] });
    const lvlB = scaleSnapshot({ ns: 5, level: "aaa", teams: 2, days: 10, seed: 5, sharedPlayers: [{ id: shared, name: "Shared Mover", role: "hitter", fromDay: 5 }] });
    const both: LevelSnapshot[] = [{ level: "aaa", snapshot: lvlB }, { level: "aa", snapshot: lvlA }];
    const other = (s: typeof lvlA, lvl: "aa" | "aaa") => levelDirectoryRows(s, lvl).find((r) => r.batting && r.id !== shared)!.id;
    const pa = (lvl: "aa" | "aaa", s: typeof lvlA) => {
      const v2 = compareView(both, parseCompareQuery({ level: lvl, ids: `${shared},${other(s, lvl)}` }));
      assert.equal(v2.status, "ok");
      return (v2 as Extract<CompareView, { status: "ok" }>).groups[0].rows.find((r) => r.id === "pa")!.cells[0]!.text;
    };
    assert.equal(pa("aa", lvlA), String(levelDirectoryRows(lvlA, "aa").find((r) => r.id === shared)!.batting!.plateAppearances));
    assert.equal(pa("aaa", lvlB), String(levelDirectoryRows(lvlB, "aaa").find((r) => r.id === shared)!.batting!.plateAppearances));
    assert.notEqual(pa("aa", lvlA), pa("aaa", lvlB), "never blended");
  });

  test("instructional states: no level, level not loaded, fewer than two players", () => {
    assert.equal(view({ ids: `${IDS.star},${IDS.improver}` }).status, "no-level");
    assert.equal(view({ level: "mlb", ids: `${IDS.star},${IDS.improver}` }).status, "no-level");
    const notLoaded = view({ level: "single-a", ids: `${IDS.star},${IDS.improver}` });
    assert.equal(notLoaded.status, "level-unavailable");
    const one = view({ level: "afl", ids: IDS.star });
    assert.equal(one.status, "too-few");
    assert.deepEqual(one.status === "too-few" && one.players.map((p) => p.name), ["Steady Star"]);
    assert.equal(view({ level: "afl" }).status, "too-few");
    assert.equal(view({ level: "afl", ids: `${IDS.star},${IDS.star}` }).status, "too-few", "a duplicate is not a second player");
  });
});

describe("CompareTable markup", () => {
  test("one semantic table: players as columns, stats as rows, best values announced", () => {
    const v = okView([IDS.star, IDS.pSteady, IDS.improver], "hitter");
    const html = renderToStaticMarkup(createElement(CompareTable, { players: v.players, groups: v.groups, level: v.level, role: v.role }));
    assert.match(html, /^<div class="table-scroll compare-scroll" tabindex="0" role="region" aria-label="Arizona Fall League hitters compared: statistics as rows, players as columns">/);
    assert.match(html, /<caption class="sr-only">Arizona Fall League hitters compared/);
    assert.equal((html.match(/<th scope="col"/g) ?? []).length, 1 + v.players.length);
    assert.equal((html.match(/<th scope="row"/g) ?? []).length, v.groups.reduce((n, g) => n + g.rows.length, 0));
    assert.equal((html.match(/<th scope="rowgroup" colSpan="4">/g) ?? []).length, 3);
    assert.match(html, new RegExp(`<a class="player-name" href="/players/${IDS.star}\\?level=afl">Steady Star`));
    assert.match(html, /No Arizona Fall League batting line/);
    assert.match(html, /<td class="numeric best"><strong>[^<]+<\/strong><span class="sr-only"> \(best\)<\/span>/);
    assert.match(html, /<td class="numeric placeholder-value">—<span class="sr-only"> no line<\/span><\/td>/);
    // Remove links keep the other players, in order, and say whom they remove.
    assert.match(html, new RegExp(`href="/compare\\?level=afl&amp;ids=${IDS.pSteady},${IDS.improver}">Remove<span class="sr-only"> Steady Star from the comparison</span>`));
    assert.doesNotMatch(html, /prefetch/);
  });
});
