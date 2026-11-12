/**
 * Precomputed view models (src/services/competition/views-*.ts) and the fast snapshot unpacker.
 *
 * Parity is checked three ways for every page-facing view model, across fixtures: strictly
 * deep-equal values, identical JSON (key order), and an identical reference graph (which objects
 * are shared, within a level and across parts, and with the snapshot). Page-level byte parity of
 * HTML and RSC payloads, and 404 statuses, are checked end to end by
 * scripts/precomputed-views.e2e.ts.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { snapshotSource, writeSnapshotDir } from "../src/services/competition/snapshot-store";
import { packSnapshot, packValue, unpackChecked, unpackValue, SnapshotFormatError } from "../src/services/competition/snapshot-format";
import { writeSnapshotViews, encodeLevelParts, levelViewParts } from "../src/services/competition/views-build";
import {
  checkViews,
  precomputedPart,
  resetViewsLog,
  viewsCounters,
  viewsSwitch,
} from "../src/services/competition/views-store";
import {
  ViewsEncodeError,
  ViewsFormatError,
  decodeGraph,
  encodeLevelGraph,
  mathProbes,
  runtimeCompatible,
  snapshotPaths,
} from "../src/services/competition/views-format";
import { sourceFingerprint } from "../src/services/competition/views-fingerprint";
import {
  homeTopLines,
  homeTrending,
  levelCoverageSummary,
  trendComparable,
  trendMapPoints,
  trendRiserLists,
} from "../src/services/competition/prepare";
import { levelMoves } from "../src/services/competition/moves";
import { playerLevels } from "../src/services/competition/model";
import { recentPerformers } from "../src/services/afl/read-model";
import { directoryRows, levelDirectoryRows } from "../src/services/players/adapter";
import { STAT_WINDOWS } from "../src/services/players/directory";
import { LEVEL_IDS, type LevelId } from "../src/services/players/levels";
import { playerAnalyticsView } from "../src/analytics/views";
import { MOMENTUM_WINDOW_IDS } from "../src/analytics/config";
import type { AflSnapshot } from "../src/services/afl/types";
import type { LevelSnapshot } from "../src/services/competition/types";
import { scaleSnapshot } from "./milb-scale-support";
import { trajectorySnapshot } from "./analytics-test-support";
import { edgeSnapshot } from "./momentum-golden-support";

const FP = "f".repeat(64);
const SEASON = 2026;
const ROLES = ["hitter", "pitcher"] as const;

/** The per-snapshot analytics context memo: present only if something computed Momentum live. */
const contexts = () =>
  (globalThis as unknown as Record<symbol, WeakMap<object, unknown> | undefined>)[Symbol.for("prospect-terminal.analytics-context")] ??
  new WeakMap();

const fixtures: Record<string, () => Map<LevelId, AflSnapshot | null>> = {
  ladder: () =>
    new Map<LevelId, AflSnapshot | null>([
      ["afl", trajectorySnapshot()],
      ["aaa", scaleSnapshot({ ns: 1, level: "aaa", teams: 6, days: 40, seed: 1 })],
      ["aa", scaleSnapshot({ ns: 2, level: "aa", teams: 6, days: 40, seed: 2 })],
      ["high-a", scaleSnapshot({ ns: 3, level: "high-a", teams: 6, days: 40, seed: 3 })],
      ["single-a", null],
    ]),
  edges: () =>
    new Map<LevelId, AflSnapshot | null>([
      ["afl", edgeSnapshot()],
      ["aaa", null],
      ["aa", scaleSnapshot({ ns: 5, level: "aa", teams: 4, days: 30, seed: 9 })],
      ["high-a", null],
      ["single-a", scaleSnapshot({ ns: 6, level: "single-a", teams: 4, days: 25, seed: 4 })],
    ]),
};

const tmpRoot = mkdtempSync(path.join(tmpdir(), "pt-views-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

/** A snapshot directory with views, per fixture (built once). */
const dirs: Record<string, string> = {};
before(async () => {
  for (const [name, make] of Object.entries(fixtures)) {
    const dir = path.join(tmpRoot, name);
    await writeSnapshotDir(dir, { season: SEASON, ingestionVersion: `views-${name}`, levels: make() });
    await writeSnapshotViews(dir, { season: SEASON, fingerprint: FP });
    dirs[name] = dir;
  }
});

/** Fresh copy of a fixture directory (for tampering). */
function copyDir(name: string) {
  const dir = mkdtempSync(path.join(tmpRoot, `${name}-copy-`));
  cpSync(dirs[name], dir, { recursive: true });
  return dir;
}

/** Fingerprint argument meaning "a server built without one". */
const NO_FINGERPRINT = "none";
async function loadLevels(dir: string, views: boolean, fingerprint: string = FP): Promise<LevelSnapshot[]> {
  const src = snapshotSource(dir, SEASON, views ? { views: { fingerprint: fingerprint === NO_FINGERPRINT ? undefined : fingerprint } } : {});
  const out: LevelSnapshot[] = [];
  for (const level of LEVEL_IDS) {
    const snapshot = await src.load(level);
    if (snapshot) out.push({ level, snapshot });
  }
  return out;
}

/** Every precomputable view model of one level, through the page functions. */
function levelModels(s: AflSnapshot, level: LevelId): [string, unknown][] {
  return [
    ...STAT_WINDOWS.map((w): [string, unknown] => [`rows ${w}`, levelDirectoryRows(s, level, w)]),
    ["trending", homeTrending(s)],
    ["topLines", homeTopLines(s)],
    ["coverage", levelCoverageSummary(s)],
    ["comparable", trendComparable(s)],
    ...ROLES.flatMap((r) => MOMENTUM_WINDOW_IDS.map((w): [string, unknown] => [`risers ${r} ${w}`, trendRiserLists(s, r, w)])),
    ...ROLES.flatMap((r) => MOMENTUM_WINDOW_IDS.map((w): [string, unknown] => [`map ${r} ${w}`, trendMapPoints(s, r, w)])),
  ];
}

/**
 * What each page response renders (RSC dedupes shared objects per response, so the reference graph
 * must match per response; across responses it is irrelevant). Mirrors the src/app page files.
 */
function pageResponses(levels: LevelSnapshot[]): [string, [string, unknown][]][] {
  const out: [string, [string, unknown][]][] = [];
  for (const { level, snapshot: s } of levels) {
    out.push([
      `home ${level}`,
      [
        ["trending", homeTrending(s)],
        ["topLines", homeTopLines(s)],
        ["moves", levelMoves(levels, { limit: 10, involving: level === "afl" ? undefined : level })],
        ["performers", (["7d", "14d", "30d"] as const).map((w) => ["hitters", "pitchers"].map((r) => recentPerformers(s, w, r as "hitters")))],
        ["coverage", levels.map((l) => levelCoverageSummary(l.snapshot))],
      ],
    ]);
    out.push([`trends ${level}`, [["comparable", trendComparable(s)], ["risers", trendRiserLists(s, "hitter", "14d")], ["map", trendMapPoints(s, "hitter", "14d")]]]);
    for (const r of ROLES)
      for (const w of MOMENTUM_WINDOW_IDS) {
        out.push([`trends/data risers ${level} ${r} ${w}`, [["risers", trendRiserLists(s, r, w)]]]);
        out.push([`trends/data map ${level} ${r} ${w}`, [["map", trendMapPoints(s, r, w)]]]);
      }
    for (const w of STAT_WINDOWS)
      for (const role of ROLES) out.push([`players ${level} ${w} ${role}`, [["rows", directoryRows(levels, { level, window: w, role })]]]);
    const id = s.players[0].id;
    out.push([`profile ${level} ${id}`, [["presence", playerLevels(levels, id)], ["analytics", playerAnalyticsView(s, id)]]]);
  }
  for (const w of STAT_WINDOWS) for (const role of ROLES) out.push([`players all ${w} ${role}`, [["rows", directoryRows(levels, { window: w, role })]]]);
  out.push(["moves (all)", [["moves", levelMoves(levels, { limit: 50 })]]]);
  return out;
}

/** Paths of every snapshot object, prefixed by level (reference graphs across levels). */
function allPaths(levels: LevelSnapshot[]) {
  const m = new Map<object, (string | number)[]>();
  for (const { level, snapshot } of levels) for (const [o, p] of snapshotPaths(snapshot)) m.set(o, [level, ...p]);
  return m;
}

function assertSame(label: string, live: [string, unknown][], viewed: [string, unknown][], paths: [Map<object, (string | number)[]>, Map<object, (string | number)[]>]) {
  assert.equal(viewed.length, live.length);
  live.forEach(([name, v], i) => {
    assert.ok(isDeepStrictEqual(viewed[i][1], v), `${label}: ${name} values differ`);
    assert.equal(JSON.stringify(viewed[i][1]), JSON.stringify(v), `${label}: ${name} key order differs`);
  });
  // One joint encoding: identical output means identical sharing, within and across models.
  assert.equal(JSON.stringify(encodeLevelGraph(viewed, paths[1])), JSON.stringify(encodeLevelGraph(live, paths[0])), `${label}: reference graph differs`);
}

describe("parity: precomputed views give exactly the live view models", () => {
  for (const name of Object.keys(fixtures))
    test(`fixture "${name}": every level and cross-level model, values, key order and reference graph`, async () => {
      const live = await loadLevels(dirs[name], false);
      const viewed = await loadLevels(dirs[name], true);
      const decodedBefore = viewsCounters.decoded;
      const fallbacksBefore = viewsCounters.fallbacks;
      for (let i = 0; i < live.length; i++) {
        const { level } = live[i];
        assertSame(`${name}/${level}`, levelModels(live[i].snapshot, level), levelModels(viewed[i].snapshot, level), [
          snapshotPaths(live[i].snapshot),
          snapshotPaths(viewed[i].snapshot),
        ]);
        assert.equal(contexts().has(viewed[i].snapshot), false, `${name}/${level}: no Momentum was computed live`);
      }
      assert.ok(viewsCounters.decoded > decodedBefore, "views were used");
      assert.equal(viewsCounters.fallbacks, fallbacksBefore, "no memo asked for a part that does not exist");
      const livePages = pageResponses(live);
      const viewedPages = pageResponses(viewed);
      const paths: [Map<object, (string | number)[]>, Map<object, (string | number)[]>] = [allPaths(live), allPaths(viewed)];
      livePages.forEach(([page, models], i) => assertSame(`${name}/${page}`, models, viewedPages[i][1], paths));
    });

  test("sharing across parts is preserved: Season and 14-day rows share their Momentum samples", async () => {
    for (const views of [false, true]) {
      const [, aaa] = await loadLevels(dirs.ladder, views);
      const season = levelDirectoryRows(aaa.snapshot, "aaa", "season");
      const d14 = levelDirectoryRows(aaa.snapshot, "aaa", "14d");
      const i = season.findIndex((r) => r.momentum.hitter?.sample);
      assert.ok(i >= 0);
      const j = d14.findIndex((r) => r.id === season[i].id);
      assert.equal(season[i].momentum.hitter!.sample, d14[j].momentum.hitter!.sample, `views=${views}`);
      assert.equal(season[i].team, aaa.snapshot.teams.find((t) => t.id === season[i].team?.id), "team is the snapshot's own object");
    }
  });

  test("lazy: loading decodes no view; a page decodes only the parts it uses", async () => {
    const before = viewsCounters.decoded;
    const levels = await loadLevels(dirs.ladder, true);
    assert.equal(viewsCounters.decoded, before, "nothing decoded at load");
    const aa = levels.find((l) => l.level === "aa")!.snapshot;
    homeTrending(aa);
    homeTrending(aa);
    assert.equal(viewsCounters.decoded, before + 1, "one part, once (memoized)");
    trendRiserLists(aa, "hitter", "14d");
    assert.equal(viewsCounters.decoded, before + 3, "riser lists + comparable");
  });
});

describe("safe fallback: anything wrong means live computation, identical output", () => {
  const liveModels = async (name: string) => {
    const l = await loadLevels(dirs[name], false);
    return l.map(({ level, snapshot }) => levelModels(snapshot, level));
  };
  const viewedModels = async (dir: string, fingerprint: string = FP) => {
    const l = await loadLevels(dir, true, fingerprint);
    return { levels: l, models: l.map(({ level, snapshot }) => levelModels(snapshot, level)) };
  };

  const quiet = <T>(f: () => Promise<T>) => async () => {
    const orig = console.error;
    const lines: string[] = [];
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    resetViewsLog();
    try {
      return { value: await f(), lines };
    } finally {
      console.error = orig;
    }
  };

  test("a missing part file", async () => {
    const dir = copyDir("ladder");
    rmSync(path.join(dir, "views", "aa", "home-trending.json.gz"));
    const { value, lines } = await quiet(() => viewedModels(dir))();
    assert.ok(isDeepStrictEqual(value.models, await liveModels("ladder")));
    assert.ok(lines.some((l) => /aa precomputed home-trending: missing file; computing live/.test(l)), lines.join("\n"));
  });

  test("a tampered part (same size, different bytes) and a tampered manifest hash", async () => {
    const dir = copyDir("ladder");
    const f = path.join(dir, "views", "aaa", "directory-rows.aaa.season.json.gz");
    const b = readFileSync(f);
    b[b.length - 5] ^= 0xff;
    writeFileSync(f, b);
    const m = JSON.parse(readFileSync(path.join(dir, "views", "manifest.json"), "utf8"));
    m.levels.aa["trend-comparable"].sha256 = "0".repeat(64);
    writeFileSync(path.join(dir, "views", "manifest.json"), JSON.stringify(m));
    const { value, lines } = await quiet(() => viewedModels(dir))();
    assert.ok(isDeepStrictEqual(value.models, await liveModels("ladder")));
    assert.ok(lines.some((l) => /aaa precomputed directory-rows\|aaa\|season: integrity check failed/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /aa precomputed trend-comparable: integrity check failed/.test(l)), lines.join("\n"));
  });

  test("a corrupt shared pool falls back for the parts that need it", async () => {
    const dir = copyDir("ladder");
    const f = path.join(dir, "views", "aaa", "shared.json.gz");
    writeFileSync(f, Buffer.alloc(readFileSync(f).length, 7));
    const { value, lines } = await quiet(() => viewedModels(dir))();
    assert.ok(isDeepStrictEqual(value.models, await liveModels("ladder")));
    assert.ok(lines.some((l) => /aaa precomputed .*: integrity check failed/.test(l)), lines.join("\n"));
  });

  test("views off: malformed manifest, other snapshot, other source, no build fingerprint, switch off", async () => {
    const cases: [string, (dir: string) => void, string, RegExp][] = [
      ["malformed", (d) => writeFileSync(path.join(d, "views", "manifest.json"), "{"), FP, /views manifest is malformed/],
      ["schema", (d) => writeFileSync(path.join(d, "views", "manifest.json"), JSON.stringify({ format: "x" })), FP, /views manifest is malformed/],
      ["absent", (d) => rmSync(path.join(d, "views"), { recursive: true }), FP, /has no precomputed views/],
      ["other snapshot", (d) => cpSync(path.join(dirs.edges, "views"), path.join(d, "views"), { recursive: true, force: true }), FP, /different data snapshot/],
      ["other source", () => {}, "e".repeat(64), /different source code/],
      ["no fingerprint", () => {}, NO_FINGERPRINT, /no build fingerprint/],
    ];
    for (const [label, mutate, fp, why] of cases) {
      const dir = copyDir("ladder");
      mutate(dir);
      const before = viewsCounters.decoded;
      const { value, lines } = await quiet(() => viewedModels(dir, fp))();
      assert.ok(isDeepStrictEqual(value.models, await liveModels("ladder")), label);
      assert.equal(viewsCounters.decoded, before, `${label}: no part decoded`);
      assert.ok(lines.some((l) => why.test(l) && /computing live/.test(l)), `${label}: ${lines.join("\n")}`);
    }
    const prev = process.env.PT_PRECOMPUTED_VIEWS;
    try {
      process.env.PT_PRECOMPUTED_VIEWS = "off";
      const before = viewsCounters.decoded;
      const { value, lines } = await quiet(() => viewedModels(dirs.ladder))();
      assert.ok(isDeepStrictEqual(value.models, await liveModels("ladder")));
      assert.equal(viewsCounters.decoded, before);
      assert.ok(lines.some((l) => /PT_PRECOMPUTED_VIEWS is not on/.test(l)));
    } finally {
      if (prev === undefined) delete process.env.PT_PRECOMPUTED_VIEWS;
      else process.env.PT_PRECOMPUTED_VIEWS = prev;
    }
  });

  test("the switch: unset or on enables; off and anything else disable", () => {
    assert.equal(viewsSwitch({}), true);
    assert.equal(viewsSwitch({ PT_PRECOMPUTED_VIEWS: "on" }), true);
    assert.equal(viewsSwitch({ PT_PRECOMPUTED_VIEWS: " ON " }), true);
    assert.equal(viewsSwitch({ PT_PRECOMPUTED_VIEWS: "off" }), false);
    assert.equal(viewsSwitch({ PT_PRECOMPUTED_VIEWS: "yes" }), false);
  });

  test("runtime compatibility: other V8 major.minor or other Math results turn views off", async () => {
    const m = JSON.parse(readFileSync(path.join(dirs.ladder, "views", "manifest.json"), "utf8"));
    const snap = JSON.parse(readFileSync(path.join(dirs.ladder, "manifest.json"), "utf8"));
    const base = { snapshotId: snap.snapshotId, fingerprint: FP, env: {} };
    assert.equal((await checkViews(dirs.ladder, base)).on, true);
    const [maj, min, patch] = process.versions.v8.split(".");
    assert.equal((await checkViews(dirs.ladder, { ...base, v8: `${maj}.${min}.${Number(patch) + 1}` })).on, true, "patch differences are fine");
    assert.deepEqual(await checkViews(dirs.ladder, { ...base, v8: `${maj}.${Number(min) + 1}.0` }), { on: false, reason: "v8-mismatch" });
    const probes = mathProbes();
    probes[3][0] = probes[3][0] + Number.EPSILON;
    assert.deepEqual(await checkViews(dirs.ladder, { ...base, probes }), { on: false, reason: "math-mismatch" });
    assert.deepEqual(runtimeCompatible({ v8: m.v8, mathProbes: m.mathProbes }), { ok: true });
  });

  test("database mode never uses views: only snapshotSource with `views` links a level", async () => {
    const [level] = await loadLevels(dirs.ladder, false);
    assert.equal(precomputedPart(level.snapshot, "home-trending"), undefined);
    const index = readFileSync(new URL("../src/services/competition/index.ts", import.meta.url), "utf8");
    const dbBranch = index.slice(index.indexOf("return competitionLevelCache({\n    ...common,\n    load: dbLevelLoader"));
    assert.doesNotMatch(dbBranch.slice(0, dbBranch.indexOf("});")), /views|snapshotSource/);
    for (const f of ["load.ts", "cache.ts", "source-cache.ts"])
      assert.doesNotMatch(readFileSync(new URL(`../src/services/competition/${f}`, import.meta.url), "utf8"), /views-store|linkLevelViews/, f);
  });
});

describe("the views build refuses anything it cannot reproduce exactly", () => {
  const s = () => scaleSnapshot({ ns: 8, level: "aa", teams: 2, days: 12, seed: 8 });
  for (const [label, value, why] of [
    ["undefined property", { a: 1, b: undefined }, /does not decode to an equal value/],
    ["negative zero", { a: -0 }, /does not decode to an equal value/],
    ["NaN", { a: Number.NaN }, /non-finite/],
    ["reserved key", { $s: 1 }, /reserved key \$s/],
  ] as const)
    test(label, () => assert.throws(() => encodeLevelParts(s(), [["x", value]]), why));

  test("a cycle and the reserved part name", () => {
    const c: Record<string, unknown> = { a: 1 };
    c.self = c;
    assert.throws(() => encodeLevelParts(s(), [["x", c]]), ViewsEncodeError);
    assert.throws(() => encodeLevelParts(s(), [["shared", {}]]), /reserved/);
  });

  test("shared objects, snapshot pointers and key order survive a round trip", () => {
    const snap = s();
    const team = snap.teams[0];
    const inner = { k: 1 };
    const parts: [string, unknown][] = [
      ["a", { rows: [{ team, x: inner }, { team, x: inner }], z: 1, a: 2 }],
      ["b", { again: inner, t: team }],
    ];
    const enc = encodeLevelParts(snap, parts);
    assert.deepEqual(enc.map((e) => e.name), ["a", "b", "shared"]);
    assert.ok(enc.every((e) => e.file.length > 0));
  });

  test("a failed build leaves no views (the snapshot is then served live)", async () => {
    const dir = copyDir("ladder");
    writeFileSync(path.join(dir, "manifest.json"), "{}");
    await assert.rejects(writeSnapshotViews(dir, { season: SEASON, fingerprint: FP }));
    assert.equal(existsSync(path.join(dir, "views")), false);
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("views")), []);
  });

  test("decoder rejects malformed input instead of guessing", () => {
    const snap = s();
    for (const bad of [{ $p: ["nope"] }, { $p: "teams" }, { $r: 3 }, { $s: 0 }, { $d: 1, v: {}, extra: 1 }, { $p: ["teams", 0, "name"] }])
      assert.throws(() => decodeGraph(bad, snap), ViewsFormatError, JSON.stringify(bad));
  });

  test("the part list matches what the runtime asks for", () => {
    const snap = s();
    const names = levelViewParts(snap, "aa").map(([n]) => n);
    for (const n of ["home-trending", "home-top-lines", "coverage", "trend-comparable", "trend-riser-lists", "level-move-spans"]) assert.ok(names.includes(n), n);
    for (const w of STAT_WINDOWS) assert.ok(names.includes(`directory-rows|aa|${w}`));
    for (const r of ROLES) for (const w of MOMENTUM_WINDOW_IDS) assert.ok(names.includes(`trend-map-points|${r}|${w}`));
    for (const f of ["prepare.ts", "moves.ts"]) {
      const code = readFileSync(new URL(`../src/services/competition/${f}`, import.meta.url), "utf8");
      assert.match(code, /precomputedPart/, f);
    }
  });
});

describe("fast unpacker: same objects and the exact same errors", () => {
  test("decodes every fixture level exactly like the checked unpacker", () => {
    for (const make of Object.values(fixtures))
      for (const snap of make().values()) {
        if (!snap) continue;
        const packed = JSON.parse(JSON.stringify(packSnapshot(snap)));
        const fast = unpackValue(packed);
        const checked = unpackChecked(packed);
        assert.ok(isDeepStrictEqual(fast, checked));
        assert.equal(JSON.stringify(fast), JSON.stringify(checked), "same key order");
      }
  });

  test("malformed input: identical error type and message, with the path", () => {
    const cases: unknown[] = [
      { $t: ["a"], r: [[1, 2]] },
      { $t: ["a", "a"], r: [] },
      { $t: [1], r: [] },
      { $t: ["a"], r: [[1]], x: 1 },
      { $t: ["a"], r: "no" },
      { $t: ["a"], r: [1] },
      { ok: [1, { deep: { $t: ["a"], r: [[1], [2, 3]] } }] },
      { n: Number.POSITIVE_INFINITY },
      { u: undefined },
      [1, () => 1],
      { d: new Date(0) },
    ];
    for (const bad of cases) {
      let fast: unknown, checked: unknown;
      try {
        unpackValue(bad);
      } catch (e) {
        fast = e;
      }
      try {
        unpackChecked(bad);
      } catch (e) {
        checked = e;
      }
      assert.ok(checked instanceof SnapshotFormatError, `checked rejects ${String(JSON.stringify(bad))}`);
      assert.ok(fast instanceof SnapshotFormatError);
      assert.equal((fast as Error).message, (checked as Error).message);
    }
    assert.throws(() => unpackValue({ ok: [1, { deep: { $t: ["a"], r: [[1], [2, 3]] } }] }), { message: "$.ok[1].deep[1]: row has the wrong number of values" });
  });

  test("edge cases behave like the checked unpacker: sparse arrays, __proto__ keys, empty tables", () => {
    const sparse = [1, , 3];
    for (const v of [sparse, JSON.parse('{"__proto__":{"x":1},"y":2}'), { $t: ["a"], r: [] }, packValue([{ a: 1 }, { a: 2 }])]) {
      const a = unpackValue(v);
      const b = unpackChecked(v);
      assert.ok(isDeepStrictEqual(a, b), JSON.stringify(v));
      assert.ok(isDeepStrictEqual(Object.getPrototypeOf(a), Object.getPrototypeOf(b)), "same prototype");
    }
  });
});

describe("source fingerprint and the build guard", () => {
  test("deterministic, and any change under src/ or in the lockfile changes it", () => {
    const root = mkdtempSync(path.join(tmpRoot, "fp-"));
    mkdirSync(path.join(root, "src", "a"), { recursive: true });
    writeFileSync(path.join(root, "src", "a", "x.ts"), "export const x = 1;\n");
    writeFileSync(path.join(root, "package-lock.json"), "{}");
    const a = sourceFingerprint(root);
    assert.equal(sourceFingerprint(root), a);
    writeFileSync(path.join(root, "src", "a", "x.ts"), "export const x = 2;\n");
    const b = sourceFingerprint(root);
    assert.notEqual(b, a);
    writeFileSync(path.join(root, "package-lock.json"), "{ }");
    assert.notEqual(sourceFingerprint(root), b);
    writeFileSync(path.join(root, "src", "a", "y.ts"), "");
    assert.notEqual(sourceFingerprint(root), b);
  });

  test("next.config: a snapshot build carries the fingerprint and refuses views from other source", async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(path.join(cwd, ".pt-test-views-"));
    const prev = { ...process.env };
    try {
      writeFileSync(path.join(dir, "manifest.json"), "{}");
      process.env.PT_DATA_SOURCE = "snapshot";
      process.env.PT_SNAPSHOT_DIR = path.relative(cwd, dir);
      const build = (await import("../next.config")).default;
      const fp = sourceFingerprint(cwd);
      assert.deepEqual(build("phase-production-build").env, { PT_SOURCE_FINGERPRINT: fp }, "no views yet: fine, computed live");
      mkdirSync(path.join(dir, "views"));
      writeFileSync(path.join(dir, "views", "manifest.json"), JSON.stringify({ sourceFingerprint: "0".repeat(64) }));
      assert.throws(() => build("phase-production-build"), /computed from different source code: rerun npm run snapshot:views/);
      writeFileSync(path.join(dir, "views", "manifest.json"), "{");
      assert.throws(() => build("phase-production-build"), /unreadable/);
      writeFileSync(path.join(dir, "views", "manifest.json"), JSON.stringify({ sourceFingerprint: fp }));
      assert.deepEqual(build("phase-production-build").env, { PT_SOURCE_FINGERPRINT: fp });
      assert.equal(build("phase-production-server").env, undefined, "nothing recomputed at server start");
      delete process.env.PT_DATA_SOURCE;
      assert.equal(build("phase-production-build").env, undefined, "the default build carries nothing");
    } finally {
      process.env = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
