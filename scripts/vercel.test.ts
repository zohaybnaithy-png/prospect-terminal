/**
 * Phase 6B: Vercel Hobby + Neon Free compatibility (docs/VERCEL.md).
 *
 * 1. Build-time data snapshot: exact round trip of level data (statistics and Momentum identical),
 *    strict integrity checks, fail-closed export.
 * 2. Prefetching off by default.
 * 3. CDN caching rules: only public pages, only snapshot builds, no RSC cache poisoning.
 * 4. Traffic protection on Vercel: platform identity header, immediate refusals, never cached.
 * 5. Vercel Web Analytics: Vercel only, path-only page views, CSP unchanged.
 * 6. Private staging: indexing off on every non-production Vercel deployment and by default.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import {
  SnapshotFormatError,
  packSnapshot,
  packValue,
  snapshotsEqual,
  unpackSnapshot,
  unpackValue,
} from "../src/services/competition/snapshot-format";
import {
  MANIFEST_FILE,
  SnapshotIntegrityError,
  decodeLevel,
  encodeLevel,
  readSnapshotManifest,
  snapshotId,
  snapshotSource,
  validateManifest,
  writeSnapshotDir,
  type SnapshotManifest,
} from "../src/services/competition/snapshot-store";
import { exportSnapshots } from "../src/services/competition/snapshot-export";
import { dataConfigured, dataSource } from "../src/services/competition/data-source";
import { LEVEL_IDS, type LevelId } from "../src/services/players/levels";
import type { AflSnapshot } from "../src/services/afl/types";
import { playerProfile } from "../src/services/afl/read-model";
import { playerAnalyticsView } from "../src/analytics/views";
import { homeTrending, trendMapPoints, trendRiserLists } from "../src/services/competition/prepare";
import { MOMENTUM_WINDOW_IDS } from "../src/analytics/config";
import { scaleSnapshot } from "./milb-scale-support";
import { trajectorySnapshot } from "./analytics-test-support";
import { CDN_CACHED_ROUTES, CDN_CACHE_HEADER, CDN_CACHE_VALUE, cdnCacheEnabled, cdnCacheRules } from "../src/lib/cdn-cache";
import { VERCEL_CLIENT_IP_HEADER, clientKey, identityConfig } from "../src/lib/traffic/client-identity";
import { refusalDelayMs } from "../src/lib/traffic/hold";
import { createLimiter, tooManyRequests } from "../src/lib/traffic/policy";
import { sharedTrafficState, trafficHealth } from "../src/lib/traffic/health";
import { isLocalHealthRequest } from "../src/lib/health-response";
import { indexingEnabled } from "../src/lib/indexing";
import { robotsFor } from "../src/lib/crawl-policy";
import { siteOrigin } from "../src/lib/site-url";
import { analyticsUrl, webAnalyticsEnabled } from "../src/lib/web-analytics";
import { onVercel, vercelEnvironment } from "../src/lib/platform";

const root = new URL("..", import.meta.url);
const src = (p: string) => readFileSync(new URL(p, root), "utf8");
const tmp = () => mkdtempSync(path.join(tmpdir(), "pt-snapshot-"));

/** The site's five levels, MiLB-shaped and AFL-shaped, from the existing fictional generators. */
function fixtureLevels(): Map<LevelId, AflSnapshot | null> {
  const small = { teams: 6, days: 40 };
  return new Map<LevelId, AflSnapshot | null>([
    ["afl", trajectorySnapshot()],
    ["aaa", scaleSnapshot({ ns: 1, level: "aaa", ...small, seed: 1 })],
    ["aa", scaleSnapshot({ ns: 2, level: "aa", ...small, seed: 2 })],
    ["high-a", scaleSnapshot({ ns: 3, level: "high-a", ...small, seed: 3 })],
    ["single-a", null], // a level not ingested yet
  ]);
}

describe("1a. snapshot format: exact round trip", () => {
  test("every fixture level round-trips exactly, and the packed form is smaller than plain JSON", () => {
    for (const [level, s] of fixtureLevels()) {
      if (!s) continue;
      const packed = packSnapshot(s);
      const back = unpackSnapshot(JSON.parse(JSON.stringify(packed)), s.season.year);
      assert.ok(snapshotsEqual(back, s), level);
      assert.ok(isDeepStrictEqual(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(s))), level);
      assert.ok(JSON.stringify(packed).length < JSON.stringify(s).length * 0.75, `${level}: tables save space`);
    }
  });

  test("statistics and Momentum computed from a round-tripped snapshot are identical", () => {
    for (const s of [trajectorySnapshot(), fixtureLevels().get("aa")!]) {
      const back = unpackSnapshot(JSON.parse(JSON.stringify(packSnapshot(s))), s.season.year);
      assert.notEqual(back, s, "a different object (no shared memoization)");
      for (const role of ["hitter", "pitcher"] as const)
        for (const w of MOMENTUM_WINDOW_IDS) {
          assert.deepEqual(trendRiserLists(back, role, w), trendRiserLists(s, role, w), `risers ${role} ${w}`);
          assert.deepEqual(trendMapPoints(back, role, w), trendMapPoints(s, role, w), `map ${role} ${w}`);
        }
      assert.deepEqual(homeTrending(back), homeTrending(s));
      for (const p of s.players.slice(0, 25)) {
        assert.deepEqual(playerProfile(back, p.id), playerProfile(s, p.id), `profile ${p.id}`);
        assert.deepEqual(playerAnalyticsView(back, p.id), playerAnalyticsView(s, p.id), `momentum ${p.id}`);
      }
    }
  });

  test("tables are used only for same-shaped objects; mixed arrays and nesting round-trip", () => {
    const v = {
      same: [{ a: 1, b: "x" }, { b: "y", a: 2 }],
      mixed: [{ a: 1 }, { a: 1, c: null }, 3, "s", null, [1, 2]],
      nested: [{ x: { y: [{ z: 1 }, { z: 2 }] } }, { x: { y: [] } }],
      one: [{ a: 1 }],
      empty: [],
      flags: [true, false],
    };
    const packed = packValue(v) as Record<string, unknown>;
    assert.deepEqual(Object.keys(packed.same as object).sort(), ["$t", "r"]);
    assert.ok(Array.isArray(packed.mixed), "mixed shapes stay plain");
    assert.deepEqual(unpackValue(JSON.parse(JSON.stringify(packed))), v);
  });

  test("undefined properties are dropped and compare equal to absent ones (nothing else is normalized)", () => {
    const v = { a: 1, b: undefined, rows: [{ x: 1, y: undefined }, { x: 2 }] };
    assert.deepEqual(unpackValue(packValue(v)), { a: 1, rows: [{ x: 1 }, { x: 2 }] });
    assert.ok(snapshotsEqual(unpackValue(packValue(v)), v));
    assert.ok(!snapshotsEqual({ a: 1 }, { a: 1, b: null }), "null is a value, not absence");
    assert.ok(!snapshotsEqual({ a: 0 }, { a: "0" }));
  });

  test("packing refuses anything JSON cannot carry exactly", () => {
    const bad: [string, unknown][] = [
      ["NaN", { a: Number.NaN }],
      ["Infinity", { a: [Infinity] }],
      ["Date", { a: new Date() }],
      ["Map", { a: new Map() }],
      ["Set", [new Set()]],
      ["bigint", { a: 1n }],
      ["function", { a: () => 1 }],
      ["class", { a: new (class Box {})() }],
      ["undefined element", [1, undefined]],
      ["reserved key", { $t: [] }],
      ["reserved key in table", [{ $t: 1 }, { $t: 2 }]],
    ];
    for (const [name, value] of bad) assert.throws(() => packValue(value), SnapshotFormatError, name);
  });

  test("unpacking rejects malformed tables and snapshots", () => {
    for (const bad of [
      { $t: ["a"], r: [[1, 2]] },
      { $t: ["a", "a"], r: [[1, 2]] },
      { $t: ["a"], r: [[1]], extra: 1 },
      { $t: "a", r: [] },
      { $t: [1], r: [[1]] },
      { $t: ["a"], r: [1] },
    ])
      assert.throws(() => unpackValue(bad), SnapshotFormatError, JSON.stringify(bad));
    const s = fixtureLevels().get("aaa")!;
    const packed = JSON.parse(JSON.stringify(packSnapshot(s)));
    assert.throws(() => unpackSnapshot(packed, 2025), /season 2026, expected 2025/);
    for (const key of ["players", "batting", "league", "season"]) {
      const broken = { ...packed, [key]: "nope" };
      assert.throws(() => unpackSnapshot(broken, 2026), SnapshotFormatError, key);
    }
    assert.throws(() => unpackSnapshot({ ...packed, lastIngestedAt: 5 }, 2026), SnapshotFormatError);
  });
});

describe("1b. snapshot files: integrity", () => {
  const write = async (dir: string, levels = fixtureLevels()) =>
    writeSnapshotDir(dir, { season: 2026, ingestionVersion: "3:2026-11-07T00:00:00.000Z", levels, now: new Date("2026-11-11T00:00:00Z") });

  test("writes one file per level with data, a manifest, and reads back exactly; empty levels stay empty", async (t) => {
    const dir = path.join(tmp(), "snap");
    t.after(() => rmSync(path.dirname(dir), { recursive: true, force: true }));
    const levels = fixtureLevels();
    const m = await write(dir, levels);
    assert.deepEqual(readdirSync(dir).sort(), ["aa.json.gz", "aaa.json.gz", "afl.json.gz", "high-a.json.gz", MANIFEST_FILE].sort());
    assert.deepEqual(m.levels["single-a"], { status: "empty" });
    const files = snapshotSource(dir, 2026);
    assert.equal(await files.version(), m.snapshotId);
    for (const level of LEVEL_IDS) assert.ok(snapshotsEqual(await files.load(level), levels.get(level)), level);
    assert.equal(await files.load("single-a"), null);
    const e = m.levels.aaa;
    assert.ok(e.status === "ok" && e.counts.batting === levels.get("aaa")!.batting.length && e.bytes === statSync(path.join(dir, "aaa.json.gz")).size);
    assert.ok(!readdirSync(path.dirname(dir)).some((n) => n.includes(".tmp-")), "no temporary directory left");
  });

  test("the snapshot id identifies the data, not the export time", async (t) => {
    const base = tmp();
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const a = await writeSnapshotDir(path.join(base, "a"), { season: 2026, ingestionVersion: "v1", levels: fixtureLevels(), now: new Date("2026-01-01T00:00:00Z") });
    const b = await writeSnapshotDir(path.join(base, "b"), { season: 2026, ingestionVersion: "v1", levels: fixtureLevels(), now: new Date("2026-06-01T00:00:00Z") });
    const c = await writeSnapshotDir(path.join(base, "c"), { season: 2026, ingestionVersion: "v2", levels: fixtureLevels() });
    assert.equal(a.snapshotId, b.snapshotId);
    assert.notEqual(a.snapshotId, c.snapshotId);
  });

  test("a changed, truncated or missing level file fails that level only, never serves other data", async (t) => {
    const dir = path.join(tmp(), "snap");
    t.after(() => rmSync(path.dirname(dir), { recursive: true, force: true }));
    await write(dir);
    const aaa = path.join(dir, "aaa.json.gz");
    const original = readFileSync(aaa);
    const flipped = Buffer.from(original);
    flipped[flipped.length - 5] ^= 0xff;
    writeFileSync(aaa, flipped);
    await assert.rejects(snapshotSource(dir, 2026).load("aaa"), SnapshotIntegrityError);
    assert.ok(await snapshotSource(dir, 2026).load("aa"), "other levels still load");
    writeFileSync(aaa, original.subarray(0, 100));
    await assert.rejects(snapshotSource(dir, 2026).load("aaa"), /does not match the manifest/);
    rmSync(aaa);
    await assert.rejects(snapshotSource(dir, 2026).load("aaa"), /is missing/);
  });

  test("the manifest is validated: schema, season, exactly the site's levels, id, file names", async (t) => {
    const dir = path.join(tmp(), "snap");
    t.after(() => rmSync(path.dirname(dir), { recursive: true, force: true }));
    const m = await write(dir);
    const clone = (): SnapshotManifest => structuredClone(m);
    assert.throws(() => validateManifest(m, 2025), /season 2026, the site shows 2025/);
    const missing = clone();
    delete (missing.levels as Record<string, unknown>).afl;
    missing.snapshotId = snapshotId(missing.season, missing.ingestionVersion, missing.levels);
    assert.throws(() => validateManifest(missing, 2026), /exactly the site's levels/);
    const extra = clone();
    (extra.levels as Record<string, unknown>).mlb = { status: "empty" };
    extra.snapshotId = snapshotId(extra.season, extra.ingestionVersion, extra.levels);
    assert.throws(() => validateManifest(extra, 2026), /exactly the site's levels/);
    const tampered = clone();
    tampered.ingestionVersion = "other";
    assert.throws(() => validateManifest(tampered, 2026), /id does not match/);
    const renamed = clone();
    (renamed.levels.aa as { file: string }).file = "aaa.json.gz";
    renamed.snapshotId = snapshotId(renamed.season, renamed.ingestionVersion, renamed.levels);
    assert.throws(() => validateManifest(renamed, 2026), /file name for aa/);
    for (const traversal of ["../aa.json.gz", "/etc/passwd", "aa.json"]) {
      const t2 = clone();
      (t2.levels.aa as { file: string }).file = traversal;
      assert.throws(() => validateManifest(t2, 2026), /malformed/, traversal);
    }
    assert.throws(() => validateManifest({ ...m, format: "other" }, 2026), /malformed/);
    assert.throws(() => validateManifest({ ...m, formatVersion: 2 }, 2026), /malformed/);
    assert.throws(() => validateManifest({ ...m, unknown: 1 }, 2026), /malformed/);
    writeFileSync(path.join(dir, MANIFEST_FILE), "{not json");
    await assert.rejects(readSnapshotManifest(dir, 2026), /not JSON/);
    rmSync(path.join(dir, MANIFEST_FILE));
    await assert.rejects(readSnapshotManifest(dir, 2026), /manifest is missing/);
    await assert.rejects(snapshotSource(dir, 2026).version(), /manifest is missing/);
  });

  test("a level file that is not a gzip of a packed snapshot is rejected", () => {
    const { entry } = encodeLevel("aa", fixtureLevels().get("aa")!);
    assert.equal(entry.status, "ok");
    const junk = gzipSync("not json");
    const e = { ...(entry as Extract<typeof entry, { status: "ok" }>), bytes: junk.length, sha256: createHash("sha256").update(junk).digest("hex") };
    assert.throws(() => decodeLevel(e, junk, 2026), /cannot be decoded/);
  });

  test("writing refuses an incomplete level set and keeps the existing snapshot", async (t) => {
    const dir = path.join(tmp(), "snap");
    t.after(() => rmSync(path.dirname(dir), { recursive: true, force: true }));
    const m = await write(dir);
    const partial = fixtureLevels();
    partial.delete("aa");
    await assert.rejects(write(dir, partial), /level aa was not exported/);
    assert.equal((await readSnapshotManifest(dir, 2026)).snapshotId, m.snapshotId);
    const unencodable = fixtureLevels();
    (unencodable.get("aaa")!.batting[0] as unknown as Record<string, unknown>).ab = Number.NaN;
    await assert.rejects(write(dir, unencodable), SnapshotFormatError);
    assert.equal((await readSnapshotManifest(dir, 2026)).snapshotId, m.snapshotId, "existing snapshot untouched");
    assert.ok(!readdirSync(path.dirname(dir)).some((n) => n.includes(".tmp-")), "temporary files removed");
  });
});

describe("1c. snapshot export: read-only, consistent, verified", () => {
  test("exports every level, reports counts and verifies the files against what was read", async (t) => {
    const dir = path.join(tmp(), "snap");
    t.after(() => rmSync(path.dirname(dir), { recursive: true, force: true }));
    const levels = fixtureLevels();
    const loaded: string[] = [];
    const lines: string[] = [];
    const report = await exportSnapshots({
      dir,
      season: 2026,
      load: async (l) => (loaded.push(l), levels.get(l) ?? null),
      version: async () => "7:2026-11-07T10:00:00.000Z",
      log: (l) => lines.push(l),
    });
    assert.deepEqual(loaded, [...LEVEL_IDS]);
    assert.equal(report.status, "ok");
    assert.deepEqual(report.levels["single-a"], { status: "empty" });
    const aaa = report.levels.aaa;
    assert.ok(aaa.status === "ok" && aaa.players === levels.get("aaa")!.players.length);
    assert.equal(report.snapshotId, (await readSnapshotManifest(dir, 2026)).snapshotId);
    assert.ok(lines.some((l) => l.startsWith("verified")));
    assert.ok(!lines.join("\n").includes("postgres"), "logs never contain connection details");
  });

  test("an ingestion run applied during the export fails it and writes nothing", async (t) => {
    const dir = path.join(tmp(), "snap");
    t.after(() => rmSync(path.dirname(dir), { recursive: true, force: true }));
    let v = 0;
    const levels = fixtureLevels();
    await assert.rejects(
      exportSnapshots({ dir, season: 2026, load: async (l) => levels.get(l) ?? null, version: async () => `v${v++}` }),
      /applied during the export/,
    );
    assert.equal(existsSync(dir), false);
  });

  test("a level that fails to load fails the export (no partial snapshot)", async (t) => {
    const dir = path.join(tmp(), "snap");
    t.after(() => rmSync(path.dirname(dir), { recursive: true, force: true }));
    const levels = fixtureLevels();
    await assert.rejects(
      exportSnapshots({
        dir,
        season: 2026,
        load: async (l) => {
          if (l === "high-a") throw new Error("connection reset");
          return levels.get(l) ?? null;
        },
        version: async () => "v",
      }),
      /connection reset/,
    );
    assert.equal(existsSync(dir), false);
  });

  test("the CLI exports through the site's read layer with the read-only role and never prints the URL", () => {
    const cli = src("scripts/export-snapshot.ts");
    assert.match(cli, /dbLevelLoader\(db, AFL\.defaultSeason\)/);
    assert.match(cli, /loadIngestionVersion\(db\)/);
    assert.match(cli, /redact\(/);
    assert.match(cli, /rm\(dir, \{ recursive: true, force: true \}\)/, "a failed export removes any earlier snapshot");
    assert.doesNotMatch(cli, /DATABASE_URL\}|console\.log\(process\.env/);
    // The loaders read each level in a READ ONLY transaction (the export can never write).
    assert.match(src("src/services/afl/queries.ts"), /accessMode: "read only"/);
  });
});

describe("1d. data source selection", () => {
  test("database by default (unchanged single-server behaviour), snapshot only when asked, anything else invalid", () => {
    assert.deepEqual(dataSource({}), { kind: "database", configured: false });
    assert.deepEqual(dataSource({ DATABASE_URL: "postgresql://x" }), { kind: "database", configured: true });
    assert.deepEqual(dataSource({ PT_DATA_SOURCE: "database", DATABASE_URL: "postgresql://x" }), { kind: "database", configured: true });
    assert.deepEqual(dataSource({ PT_DATA_SOURCE: "snapshot" }, "/app"), { kind: "snapshot", dir: "/app/.data-snapshot" });
    assert.deepEqual(dataSource({ PT_DATA_SOURCE: "snapshot", PT_SNAPSHOT_DIR: "data/snap" }, "/app"), { kind: "snapshot", dir: "/app/data/snap" });
    for (const v of ["Snapshot", "files", "db", "1"]) assert.deepEqual(dataSource({ PT_DATA_SOURCE: v }), { kind: "invalid" }, v);
    assert.equal(dataConfigured(dataSource({ PT_DATA_SOURCE: "snapshot" })), true, "snapshot mode needs no DATABASE_URL");
    assert.equal(dataConfigured(dataSource({})), false);
    assert.equal(dataConfigured({ kind: "invalid" }), false);
  });

  test("in snapshot mode the competition service never touches the database", () => {
    const index = src("src/services/competition/index.ts");
    const snapshotBranch = index.slice(index.indexOf('if (source.kind === "snapshot")'), index.indexOf("return createLevelCache({\n    load: traced(dbLevelLoader"));
    assert.match(snapshotBranch, /snapshotSource\(source\.dir, DATA_SEASON\)/);
    assert.doesNotMatch(snapshotBranch, /getDatabase|loadIngestionVersion/);
    // The database client is only created lazily inside the database branch.
    assert.doesNotMatch(index.slice(0, index.indexOf("function createSourceCache")), /getDatabase\(\)/);
    for (const f of ["snapshot-store.ts", "snapshot-format.ts", "data-source.ts"])
      assert.doesNotMatch(src(`src/services/competition/${f}`), /@\/db|from "pg"|drizzle/, f);
    assert.match(src("src/instrumentation.ts"), /PT_DATA_SOURCE !== "snapshot"/);
  });

  test("snapshot data is git-ignored and built only by the Vercel build", () => {
    assert.match(src(".gitignore"), /^\.data-snapshot\/$/m);
    const pkg = JSON.parse(src("package.json"));
    assert.equal(pkg.scripts["build:vercel"], "npm run -s snapshot:export && next build");
    assert.equal(pkg.scripts.build, "next build", "the single-server build is unchanged");
    const vercel = JSON.parse(src("vercel.json"));
    assert.equal(vercel.buildCommand, "npm run build:vercel");
    assert.deepEqual(vercel.regions, ["pdx1"], "same region as Neon us-west-2");
    assert.equal(vercel.crons, undefined, "no scheduled ingestion on Vercel");
  });
});

describe("1e. next.config: snapshot tracing and build guard", () => {
  const withEnv = async <T>(env: Record<string, string | undefined>, f: () => Promise<T> | T): Promise<T> => {
    const prev = { ...process.env };
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    try {
      return await f();
    } finally {
      process.env = prev;
    }
  };
  const config = async () => (await import("../next.config")).default;

  test("a snapshot build without a snapshot fails; with one, the files are traced into every function", async (t) => {
    const cwd = process.cwd();
    const dir = mkdtempSync(path.join(cwd, ".pt-test-snap-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const rel = path.relative(cwd, dir);
    const build = await config();
    await withEnv({ PT_DATA_SOURCE: "snapshot", PT_SNAPSHOT_DIR: rel }, () => {
      assert.throws(() => build("phase-production-build"), /manifest\.json is missing/);
      writeFileSync(path.join(dir, "manifest.json"), "{}");
      assert.deepEqual(build("phase-production-build").outputFileTracingIncludes, { "/**/*": [`./${rel}/**/*`] });
      assert.doesNotThrow(() => build("phase-production-server"), "the server phase never fails on files");
    });
    await withEnv({ PT_DATA_SOURCE: "snapshot", PT_SNAPSHOT_DIR: "/tmp/elsewhere" }, () =>
      assert.throws(() => build("phase-production-build"), /inside the project/),
    );
    await withEnv({ PT_DATA_SOURCE: undefined }, () => assert.equal(build("phase-production-build").outputFileTracingIncludes, undefined));
  });
});

describe("2. prefetching is off by default", () => {
  const files = (dir: string): string[] =>
    readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : [],
    );

  test("no file imports next/link except the wrapper, and ESLint enforces it", () => {
    const offenders = files("src").filter((f) => f !== "src/components/ui/app-link.tsx" && /from ["']next\/link["']/.test(src(f)));
    assert.deepEqual(offenders, []);
    const users = files("src").filter((f) => /from "@\/components\/ui\/app-link"/.test(src(f)));
    assert.ok(users.length >= 20, `${users.length} files use the wrapper`);
    const eslint = src("eslint.config.mjs");
    assert.match(eslint, /"no-restricted-imports"/);
    assert.match(eslint, /name: "next\/link"/);
  });

  test("the wrapper renders Next.js Link with prefetch false unless the caller opts in", async () => {
    const { default: Link } = await import("../src/components/ui/app-link");
    const off = Link({ href: "/players", children: "x" }) as { props: { prefetch: unknown; href: string } };
    assert.equal(off.props.prefetch, false);
    assert.equal(off.props.href, "/players");
    const on = Link({ href: "/", prefetch: true, children: "x" }) as { props: { prefetch: unknown } };
    assert.equal(on.props.prefetch, true);
    assert.equal((Link({ href: "/", prefetch: null, children: "x" }) as { props: { prefetch: unknown } }).props.prefetch, null);
  });

  test("programmatic navigation does not prefetch either", () => {
    for (const f of files("src")) assert.doesNotMatch(src(f), /router\.prefetch\(/, f);
  });
});

describe("3. CDN caching", () => {
  test("on only for snapshot builds, switchable off", () => {
    assert.equal(cdnCacheEnabled({}), false, "database mode: data can change under a cached page");
    assert.equal(cdnCacheEnabled({ PT_DATA_SOURCE: "snapshot" }), true);
    assert.equal(cdnCacheEnabled({ PT_DATA_SOURCE: "snapshot", PT_CDN_CACHE: "off" }), false);
    assert.deepEqual(cdnCacheRules(false), []);
  });

  test("only public data pages; never /health or development pages", () => {
    assert.deepEqual([...CDN_CACHED_ROUTES], ["/", "/players", "/players/:id", "/trends", "/trends/data", "/data", "/robots.txt", "/sitemap.xml"]);
    const sources = new Set(cdnCacheRules(true).map((r) => r.source));
    for (const never of ["/health", "/analytics/:path*", "/analytics/models", "/:path*"]) assert.ok(!sources.has(never), never);
    assert.equal(CDN_CACHE_HEADER, "Vercel-CDN-Cache-Control", "a header only Vercel's CDN acts on");
    assert.match(CDN_CACHE_VALUE, /^max-age=300, stale-while-revalidate=\d+$/);
    assert.doesNotMatch(CDN_CACHE_VALUE, /immutable|public/);
  });

  test("RSC payloads cannot be cached under a page's HTML URL", () => {
    for (const source of CDN_CACHED_ROUTES) {
      const rules = cdnCacheRules(true).filter((r) => r.source === source);
      assert.equal(rules.length, 2, source);
      // Plain requests: only without the RSC header.
      assert.deepEqual(rules[0].missing, [{ type: "header", key: "rsc" }]);
      assert.equal(rules[0].has, undefined);
      // Router requests: only with the _rsc cache-key parameter.
      assert.deepEqual(rules[1].has, [{ type: "query", key: "_rsc" }]);
      for (const r of rules) assert.deepEqual(r.headers, [{ key: CDN_CACHE_HEADER, value: CDN_CACHE_VALUE }]);
    }
  });

  test("next.config adds the rules only when the build is a snapshot build, after the security headers", async () => {
    const build = (await import("../next.config")).default;
    const prev = { ...process.env };
    try {
      delete process.env.PT_DATA_SOURCE;
      const plain = await build("phase-production-server").headers!();
      assert.equal(plain.length, 1);
      assert.equal(plain[0].source, "/:path*");
      process.env.PT_DATA_SOURCE = "snapshot";
      const cached = await build("phase-production-server").headers!();
      assert.equal(cached[0].source, "/:path*");
      assert.equal(cached.length, 1 + CDN_CACHED_ROUTES.length * 2);
      assert.ok(cached[0].headers.some((h) => h.key === "Content-Security-Policy"));
    } finally {
      process.env = prev;
    }
  });

  test("refusals and data-state errors are explicitly never stored by the CDN", () => {
    const r = tooManyRequests({ ok: false, retryAfterSec: 3 } as never);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("vercel-cdn-cache-control"), "no-store");
    assert.equal(r.headers.get("cache-control"), "no-store");
    const route = src("src/app/trends/data/route.ts");
    assert.match(route, /status: 503, headers: NOT_CACHED/);
    assert.match(route, /status: 404, headers: NOT_CACHED/);
    assert.match(route, /"Vercel-CDN-Cache-Control": "no-store"/);
  });

  test("no cached page reads cookies or request headers (content depends only on the URL)", () => {
    const pages = ["src/app/page.tsx", "src/app/players/page.tsx", "src/app/players/[id]/page.tsx", "src/app/trends/page.tsx", "src/app/data/page.tsx", "src/app/trends/data/route.ts", "src/app/layout.tsx", "src/app/sitemap.ts", "src/app/robots.ts"];
    for (const p of pages) assert.doesNotMatch(src(p), /next\/headers|cookies\(|headers\(\)/, p);
  });
});

describe("4. traffic protection on Vercel", () => {
  const VERCEL = { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "prospect-terminal.vercel.app" };

  test("platform detection", () => {
    assert.equal(onVercel({}), false);
    assert.equal(onVercel({ VERCEL: "1" }), true);
    assert.equal(vercelEnvironment({}), null);
    assert.equal(vercelEnvironment({ VERCEL: "1", VERCEL_ENV: "preview" }), "preview");
    assert.equal(vercelEnvironment({ VERCEL: "1", VERCEL_ENV: "weird" }), "preview", "unknown counts as non-production");
    assert.equal(vercelEnvironment({ VERCEL: "1" }), "preview");
  });

  test("on Vercel the identity is x-vercel-forwarded-for by default, and no other header is trusted", () => {
    assert.deepEqual(identityConfig({ VERCEL: "1" }), { header: VERCEL_CLIENT_IP_HEADER });
    assert.deepEqual(identityConfig({ VERCEL: "1", PT_CLIENT_IP_HEADER: "X-Vercel-Forwarded-For" }), { header: VERCEL_CLIENT_IP_HEADER });
    for (const h of ["x-pt-client-ip", "x-forwarded-for", "x-real-ip", "cf-connecting-ip"])
      assert.deepEqual(identityConfig({ VERCEL: "1", PT_CLIENT_IP_HEADER: h }), { header: null, reason: "refused" }, h);
    assert.deepEqual(identityConfig({ VERCEL: "1", PT_CLIENT_IP_HEADER: "bad header!" }), { header: null, reason: "invalid" });
  });

  test("off Vercel the Vercel header is client-controlled and refused; the Caddy setup is unchanged", () => {
    assert.deepEqual(identityConfig({ PT_CLIENT_IP_HEADER: "x-vercel-forwarded-for" }), { header: null, reason: "refused" });
    assert.deepEqual(identityConfig({ PT_CLIENT_IP_HEADER: "x-pt-client-ip" }), { header: "x-pt-client-ip" });
    assert.deepEqual(identityConfig({}), { header: null, reason: "unset" });
  });

  test("the Vercel header keys clients like the Caddy header (one address; lists rejected)", () => {
    const id = identityConfig({ VERCEL: "1" });
    assert.equal(clientKey(new Headers({ "x-vercel-forwarded-for": "203.0.113.7" }), id), "4:203.0.113.7");
    assert.equal(clientKey(new Headers({ "x-vercel-forwarded-for": "2001:db8:1:2:3:4:5:6" }), id), "6:2001:db8:1:2");
    assert.equal(clientKey(new Headers({ "x-vercel-forwarded-for": "203.0.113.7, 198.51.100.1" }), id), null);
    assert.equal(clientKey(new Headers({ "x-pt-client-ip": "203.0.113.7" }), id), null, "the Caddy header means nothing on Vercel");
  });

  test("refusals are immediate on Vercel by default (a held refusal is billed), explicit values still win", () => {
    assert.equal(refusalDelayMs({}), 1000, "single server unchanged");
    assert.equal(refusalDelayMs({ VERCEL: "1" }), 0);
    assert.equal(refusalDelayMs({ VERCEL: "1", PT_REFUSAL_DELAY_MS: "250" }), 250);
    assert.equal(refusalDelayMs({ VERCEL: "1", PT_REFUSAL_DELAY_MS: "nonsense" }), 0);
  });

  test("health on Vercel: protected with no extra configuration; misconfigured if a Caddy header is copied over", () => {
    const state = sharedTrafficState();
    assert.deepEqual(trafficHealth(VERCEL, state), { status: "protected" });
    assert.equal(trafficHealth({ ...VERCEL, PT_CLIENT_IP_HEADER: "x-pt-client-ip" }, state).status, "misconfigured");
    assert.equal(trafficHealth({ ...VERCEL, PT_RATE_LIMIT: "off" }, state).status, "disabled");
  });

  test("health on Vercel never gives the detailed report (every request arrives through Vercel's edge)", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.7", "x-vercel-forwarded-for": "203.0.113.7" });
    assert.equal(isLocalHealthRequest(h, VERCEL), false);
    assert.equal(isLocalHealthRequest(new Headers({ "x-vercel-forwarded-for": "203.0.113.7" }), VERCEL), false);
  });

  test("the limiter keys on the Vercel header and refuses a single heavy client", () => {
    const l = createLimiter({ env: { VERCEL: "1" } });
    const h = new Headers({ "x-vercel-forwarded-for": "198.51.100.20" });
    let refused = 0;
    for (let i = 0; i < 300; i++) if (l.decide("/players/0a3576f9-75f2-4be1-8342-a820c380ba31", h).action === "reject") refused++;
    assert.ok(refused > 100, `${refused} of 300 refused`);
    const other = new Headers({ "x-vercel-forwarded-for": "198.51.100.21" });
    assert.equal(l.decide("/players", other).action, "allow", "other clients are unaffected");
  });

  test("end to end through the proxy on Vercel: refused immediately, with no-store for the CDN", async (t) => {
    const prev = { ...process.env };
    const key = Symbol.for("prospect-terminal.rate-limiter");
    const g = globalThis as Record<symbol, unknown>;
    delete g[key];
    Object.assign(process.env, { VERCEL: "1", VERCEL_ENV: "preview" });
    delete process.env.PT_CLIENT_IP_HEADER;
    delete process.env.PT_REFUSAL_DELAY_MS;
    t.after(() => {
      delete g[key];
      process.env = prev;
    });
    const { proxy, REFUSAL_DELAY_MS } = await import("../src/proxy");
    assert.equal(REFUSAL_DELAY_MS, 0);
    const req = () =>
      new NextRequest("https://preview.example/players/0a3576f9-75f2-4be1-8342-a820c380ba31", {
        headers: { "x-vercel-forwarded-for": "192.0.2.50", "x-forwarded-for": "192.0.2.50" },
      });
    let refusal: Response | undefined;
    for (let i = 0; i < 300 && !refusal; i++) {
      const r = await proxy(req());
      if (r.status === 429) refusal = r;
    }
    assert.ok(refusal, "a single client is refused");
    const started = performance.now();
    const again = await proxy(req());
    assert.equal(again.status, 429);
    assert.ok(performance.now() - started < 200, "no hold on Vercel");
    assert.equal(again.headers.get("vercel-cdn-cache-control"), "no-store");
    assert.equal(again.headers.get("x-robots-tag"), "noindex, nofollow", "preview: never indexed");
  });

  test("the proxy skips Vercel's own endpoints and the image optimizer (no invocation per beacon)", async () => {
    const { config } = await import("../src/proxy");
    const re = new RegExp(`^${config.matcher[0]}$`);
    for (const p of ["/_vercel/insights/script.js", "/_vercel/insights/view", "/_next/static/chunks/a.js", "/_next/image"]) assert.ok(!re.test(p), p);
    for (const p of ["/", "/players", "/players/x", "/trends/data", "/health", "/robots.txt", "/icon.png"]) assert.ok(re.test(p), p);
  });
});

describe("5. Vercel Web Analytics", () => {
  test("on only on Vercel, switchable off", () => {
    assert.equal(webAnalyticsEnabled({}), false, "single server: the /_vercel endpoints do not exist");
    assert.equal(webAnalyticsEnabled({ VERCEL: "1" }), true);
    assert.equal(webAnalyticsEnabled({ VERCEL: "1", PT_WEB_ANALYTICS: "off" }), false);
  });

  test("page views carry the path only (no search text, filters or fragments)", () => {
    assert.equal(analyticsUrl("https://x.example/players?q=smith&team=1#top"), "https://x.example/players");
    assert.equal(analyticsUrl("https://x.example/players/0a3576f9-75f2-4be1-8342-a820c380ba31?level=aa"), "https://x.example/players/0a3576f9-75f2-4be1-8342-a820c380ba31");
    assert.equal(analyticsUrl("not a url"), null);
  });

  test("rendered from the root layout only when enabled, in production mode, with the path-only filter", () => {
    const layout = src("src/app/layout.tsx");
    assert.match(layout, /\{webAnalyticsEnabled\(\) && <WebAnalytics \/>\}/);
    const component = src("src/components/layout/web-analytics.tsx");
    assert.match(component, /^"use client";/);
    assert.match(component, /from "@vercel\/analytics\/next"/);
    assert.match(component, /mode="production"/);
    assert.match(component, /beforeSend=/);
    assert.match(component, /analyticsUrl\(event\.url\)/);
  });

  test("the analytics script and beacons are same-origin, so the CSP stays 'self' only", () => {
    const dist = readFileSync(new URL("node_modules/@vercel/analytics/dist/next/index.mjs", root), "utf8");
    assert.match(dist, /"\/_vercel\/insights\/script\.js"/);
    const config = src("next.config.ts");
    assert.match(config, /`script-src 'self' 'unsafe-inline'/);
    assert.match(config, /"connect-src 'self'"/);
    assert.doesNotMatch(config, /vercel-scripts\.com|googletagmanager|google-analytics/);
    const pkg = JSON.parse(src("package.json"));
    assert.match(pkg.dependencies["@vercel/analytics"], /^\d+\.\d+\.\d+$/, "exact version");
  });

  test("the methodology page states what is counted", () => {
    const page = src("src/app/data/page.tsx");
    assert.match(page, /id="privacy"/);
    assert.match(page, /sets no cookies/);
  });
});

describe("6. private staging: indexing", () => {
  test("Vercel: off by default, on only for production with PT_INDEXING=on", () => {
    assert.equal(indexingEnabled({ VERCEL: "1", VERCEL_ENV: "production" }), false, "default off on Vercel");
    assert.equal(indexingEnabled({ VERCEL: "1", VERCEL_ENV: "production", PT_INDEXING: "off" }), false);
    assert.equal(indexingEnabled({ VERCEL: "1", VERCEL_ENV: "production", PT_INDEXING: "on" }), true);
    for (const env of ["preview", "development", "weird", undefined])
      assert.equal(indexingEnabled({ VERCEL: "1", VERCEL_ENV: env, PT_INDEXING: "on" }), false, String(env));
  });

  test("single server unchanged", () => {
    assert.equal(indexingEnabled({}), true);
    assert.equal(indexingEnabled({ PT_INDEXING: "off" }), false);
  });

  test("a Vercel preview's robots.txt disallows everything", () => {
    assert.deepEqual(robotsFor("https://x.vercel.app", { VERCEL: "1", VERCEL_ENV: "preview", PT_INDEXING: "on" }), {
      rules: [{ userAgent: "*", disallow: "/" }],
    });
  });

  test("site origin falls back to the deployment's own hostname on Vercel only", () => {
    assert.equal(siteOrigin({}), null);
    assert.equal(siteOrigin({ VERCEL_URL: "x.vercel.app" }), null, "Vercel variables mean nothing elsewhere");
    assert.equal(siteOrigin({ VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "pt.vercel.app" }), "https://pt.vercel.app");
    assert.equal(siteOrigin({ VERCEL: "1", VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "pt-git-x.vercel.app", VERCEL_URL: "pt-abc.vercel.app" }), "https://pt-git-x.vercel.app");
    assert.equal(siteOrigin({ VERCEL: "1", VERCEL_ENV: "preview", VERCEL_URL: "pt-abc.vercel.app" }), "https://pt-abc.vercel.app");
    assert.equal(siteOrigin({ VERCEL: "1", VERCEL_ENV: "production", PT_SITE_URL: "https://prospect.example", VERCEL_PROJECT_PRODUCTION_URL: "pt.vercel.app" }), "https://prospect.example");
    assert.equal(siteOrigin({ VERCEL: "1", VERCEL_ENV: "production", PT_SITE_URL: "not a url", VERCEL_PROJECT_PRODUCTION_URL: "pt.vercel.app" }), null, "an invalid explicit value is never silently replaced");
    assert.equal(siteOrigin({ VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "evil.example/path" }), null);
  });

  test("the Vercel env template keeps staging private and holds no secrets or writer settings", () => {
    const env = src("deploy/vercel-env.example");
    assert.match(env, /^PT_DATA_SOURCE=snapshot$/m);
    assert.match(env, /^PT_INDEXING=off$/m);
    assert.doesNotMatch(env, /^(DATABASE_URL|INGESTION_DATABASE_URL|PT_WRITE_TARGET_ENDPOINT|PT_CLIENT_IP_HEADER|ANALYTICS_DEBUG|PT_RATE_LIMIT)=/m);
    assert.doesNotMatch(env, /postgres(ql)?:\/\/[^<\s]/);
  });
});
