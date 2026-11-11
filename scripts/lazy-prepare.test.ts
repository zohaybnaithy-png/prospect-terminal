/**
 * Snapshot-mode lazy analytics preparation (src/services/competition/source-cache.ts).
 * Database mode keeps eager preparation; snapshot mode prepares on first use. Outputs must be
 * identical either way, concurrent first requests must share one load and one computation, and
 * serving one level must not prepare the others.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { competitionLevelCache, preparesOnLoad } from "../src/services/competition/source-cache";
import { snapshotSource, writeSnapshotDir } from "../src/services/competition/snapshot-store";
import { loadCompetition } from "../src/services/competition/load";
import {
  homeTrending,
  levelCoverageSummary,
  prepareSnapshot,
  trendComparable,
  trendMapPoints,
  trendRiserLists,
} from "../src/services/competition/prepare";
import { playerAnalyticsView } from "../src/analytics/views";
import { levelDirectoryRows } from "../src/services/players/adapter";
import { STAT_WINDOWS } from "../src/services/players/directory";
import { LEVEL_IDS, type LevelId } from "../src/services/players/levels";
import type { AflSnapshot } from "../src/services/afl/types";
import { MOMENTUM_WINDOW_IDS } from "../src/analytics/config";
import { scaleSnapshot } from "./milb-scale-support";
import { trajectorySnapshot } from "./analytics-test-support";
import { canonical, edgeSnapshot } from "./momentum-golden-support";

/** The per-snapshot analytics context memo (src/analytics/views.ts, processWeakMap). */
const contexts = () =>
  (globalThis as unknown as Record<symbol, WeakMap<object, unknown> | undefined>)[Symbol.for("prospect-terminal.analytics-context")] ??
  new WeakMap();
const prepared = (s: AflSnapshot | null) => !!s && contexts().has(s);
const quiet = { checkMs: 60_000, onTrace: () => {} };

function levels(): Map<LevelId, AflSnapshot | null> {
  const small = { teams: 6, days: 40 };
  return new Map<LevelId, AflSnapshot | null>([
    ["afl", trajectorySnapshot()],
    ["aaa", scaleSnapshot({ ns: 1, level: "aaa", ...small, seed: 1 })],
    ["aa", scaleSnapshot({ ns: 2, level: "aa", ...small, seed: 2 })],
    ["high-a", scaleSnapshot({ ns: 3, level: "high-a", ...small, seed: 3 })],
    ["single-a", null],
  ]);
}

/** Every Momentum-derived view model a page serves for one level. */
function pageModels(s: AflSnapshot, level: LevelId) {
  const ids = s.players.slice(0, 12).map((p) => p.id);
  return canonical({
    trending: homeTrending(s),
    coverage: levelCoverageSummary(s),
    comparable: trendComparable(s),
    risers: Object.fromEntries((["hitter", "pitcher"] as const).flatMap((r) => MOMENTUM_WINDOW_IDS.map((w) => [`${r}/${w}`, trendRiserLists(s, r, w)]))),
    map: Object.fromEntries((["hitter", "pitcher"] as const).flatMap((r) => MOMENTUM_WINDOW_IDS.map((w) => [`${r}/${w}`, trendMapPoints(s, r, w)]))),
    directory: Object.fromEntries(STAT_WINDOWS.map((w) => [w, levelDirectoryRows(s, level, w)])),
    profiles: ids.map((id) => playerAnalyticsView(s, id)),
  });
}

describe("preparation policy", () => {
  test("database mode prepares on load; snapshot mode does not", () => {
    assert.equal(preparesOnLoad({ kind: "database", configured: true }), true);
    assert.equal(preparesOnLoad({ kind: "database", configured: false }), true);
    assert.equal(preparesOnLoad({ kind: "snapshot", dir: "/x" }), false);
    assert.equal(preparesOnLoad({ kind: "invalid" }), false);
  });

  test("the competition service passes the policy for both sources", () => {
    const index = readFileSync(new URL("../src/services/competition/index.ts", import.meta.url), "utf8");
    assert.match(index, /prepareOnLoad: preparesOnLoad\(source\)/);
    assert.equal((index.match(/competitionLevelCache\(\{/g) ?? []).length, 2, "both branches use the same cache wiring");
    assert.doesNotMatch(index, /prepareSnapshot/, "no direct eager preparation remains in index.ts");
  });

  test("eager (database mode): every level is prepared once on load, before it is served", async () => {
    const data = levels();
    const calls: AflSnapshot[] = [];
    const cache = competitionLevelCache({ ...quiet, load: async (l) => data.get(l) ?? null, version: async () => "v1", prepareOnLoad: true, prepare: (s) => calls.push(s) });
    for (const l of LEVEL_IDS) await cache.get(l);
    assert.equal(calls.length, [...data.values()].filter(Boolean).length, "one preparation per level with data");
  });

  test("eager mode with the real warm-up fills the analytics memo on load (unchanged single-server behaviour)", async () => {
    const s = scaleSnapshot({ ns: 4, level: "single-a", teams: 4, days: 30, seed: 4 });
    const cache = competitionLevelCache({ ...quiet, load: async () => s, version: async () => "v1", prepareOnLoad: true });
    assert.equal(prepared(s), false);
    await cache.get("single-a");
    assert.equal(prepared(s), true);
  });

  test("lazy (snapshot mode): loading never prepares", async () => {
    const data = levels();
    let calls = 0;
    const cache = competitionLevelCache({ ...quiet, load: async (l) => data.get(l) ?? null, version: async () => "v1", prepareOnLoad: false, prepare: () => calls++ });
    for (const l of LEVEL_IDS) await cache.get(l);
    assert.equal(calls, 0);
    for (const s of data.values()) assert.equal(prepared(s), false);
  });
});

describe("snapshot mode on real snapshot files", () => {
  test("serving one level prepares only that level; the others stay unprepared", async (t) => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "pt-lazy-")), "snap");
    t.after(() => rmSync(path.dirname(dir), { recursive: true, force: true }));
    await writeSnapshotDir(dir, { season: 2026, ingestionVersion: "lazy-test", levels: levels() });
    const files = snapshotSource(dir, 2026);
    const cache = competitionLevelCache({ ...quiet, load: files.load, version: files.version, prepareOnLoad: false });
    cache.warm(LEVEL_IDS); // what instrumentation does at boot
    const result = await loadCompetition((l) => cache.get(l));
    assert.equal(result.status, "ok");
    assert.ok(result.status === "ok");
    for (const ls of result.levels) assert.equal(prepared(ls.snapshot), false, `${ls.level} not prepared at load`);
    const aa = result.levels.find((l) => l.level === "aa")!;
    homeTrending(aa.snapshot); // the homepage at ?level=aa
    trendRiserLists(aa.snapshot, "hitter", "14d"); // /trends?level=aa
    for (const ls of result.levels) assert.equal(prepared(ls.snapshot), ls.level === "aa", ls.level);
    // A second "request" reuses the same snapshot objects and their memos.
    const again = await loadCompetition((l) => cache.get(l));
    assert.ok(again.status === "ok");
    assert.equal(again.levels.find((l) => l.level === "aa")!.snapshot, aa.snapshot);
    assert.equal(homeTrending(aa.snapshot), homeTrending(aa.snapshot), "memoized object reused");
  });

  test("health becomes ready once levels are decoded, without preparation", async (t) => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "pt-lazy-")), "snap");
    t.after(() => rmSync(path.dirname(dir), { recursive: true, force: true }));
    await writeSnapshotDir(dir, { season: 2026, ingestionVersion: "lazy-test", levels: levels() });
    const files = snapshotSource(dir, 2026);
    const cache = competitionLevelCache({ ...quiet, load: files.load, version: files.version, prepareOnLoad: false });
    for (const l of LEVEL_IDS) await cache.get(l);
    for (const l of LEVEL_IDS) assert.equal(cache.state(l).loaded, true, l);
  });
});

describe("identical outputs and concurrency", () => {
  test("every page view model is identical whether the snapshot was prepared eagerly or lazily", () => {
    for (const [make, level] of [
      [() => scaleSnapshot({ ns: 5, level: "aa", teams: 6, days: 60, seed: 9 }), "aa"],
      [() => edgeSnapshot(), "afl"],
      [() => trajectorySnapshot(), "afl"],
    ] as const) {
      const eager = make();
      const lazy = make();
      prepareSnapshot(eager);
      assert.equal(prepared(lazy), false);
      assert.equal(pageModels(lazy, level), pageModels(eager, level), level);
    }
  });

  test("concurrent first requests share one load and one computation", async () => {
    const s = scaleSnapshot({ ns: 6, level: "aa", teams: 4, days: 40, seed: 6 });
    let loads = 0;
    const cache = competitionLevelCache({
      ...quiet,
      load: async () => {
        loads++;
        await new Promise((r) => setTimeout(r, 20));
        return s;
      },
      version: async () => "v1",
      prepareOnLoad: false,
    });
    const snapshots = await Promise.all(Array.from({ length: 10 }, () => cache.get("aa")));
    assert.equal(loads, 1);
    assert.ok(snapshots.every((x) => x === s));
    const models = await Promise.all(Array.from({ length: 10 }, async () => homeTrending(snapshots[0]!)));
    assert.ok(models.every((m) => m === models[0]), "one computation, one shared result");
  });
});
