/**
 * Preview-only /health diagnostic for precomputed view models (src/lib/health-response.ts,
 * src/services/competition/views-store.ts). Shown only on Vercel Preview deployments, coarse
 * (status + counts, never reasons, paths or ids), recording only, and Production /health is
 * unchanged.
 */
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHealthResponse, previewViewsDiagnostics } from "../src/lib/health-response";
import { snapshotSource, writeSnapshotDir } from "../src/services/competition/snapshot-store";
import { writeSnapshotViews } from "../src/services/competition/views-build";
import { resetViewsDiagnostics, viewsDiagnostics } from "../src/services/competition/views-store";
import { homeTrending } from "../src/services/competition/prepare";
import type { HealthReport } from "../src/services/competition/health";
import type { LevelId } from "../src/services/players/levels";
import type { AflSnapshot } from "../src/services/afl/types";
import { scaleSnapshot } from "./milb-scale-support";
import { trajectorySnapshot } from "./analytics-test-support";

const FP = "f".repeat(64);
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const ready = { status: "ready", configured: true, levels: { afl: "ready" } } as unknown as HealthReport;
const starting = { status: "starting", configured: true, levels: { afl: "loading" } } as unknown as HealthReport;
const traffic = { status: "protected" as const };
const extras = { indexing: "off" as const, process: { uptimeSeconds: 1, rssMB: 1, heapUsedMB: 1, heapLimitMB: 1 } };

describe("visibility: Vercel Preview only", () => {
  test("only VERCEL=1 with VERCEL_ENV=preview enables it", () => {
    assert.equal(previewViewsDiagnostics({ VERCEL: "1", VERCEL_ENV: "preview" }), true);
    for (const env of [
      { VERCEL: "1", VERCEL_ENV: "production" },
      { VERCEL: "1", VERCEL_ENV: "development" },
      { VERCEL: "1" },
      { VERCEL_ENV: "preview" }, // not on Vercel: a stray variable must not enable it
      {},
      { NODE_ENV: "production" },
    ])
      assert.equal(previewViewsDiagnostics(env), false, JSON.stringify(env));
  });

  test("Production and every other deployment: /health output is exactly what it was", () => {
    // Public (proxied / Vercel) requests: only ready / unavailable, with the same HTTP status.
    assert.deepEqual(buildHealthResponse(ready, traffic, extras, false), { status: 200, body: { status: "ready" } });
    assert.deepEqual(buildHealthResponse(starting, traffic, extras, false), { status: 503, body: { status: "unavailable" } });
    // Direct local requests: the full report, with no views field.
    const local = buildHealthResponse(ready, traffic, extras, true);
    assert.deepEqual(local, { status: 200, body: { ...ready, traffic, ...extras } });
    assert.equal("views" in local.body, false);
  });

  test("Preview: the public answer adds only the coarse views object; the HTTP status never depends on it", () => {
    for (const views of [
      { status: "on" as const, decoded: 12, fallbacks: 0 },
      { status: "off" as const, decoded: 0, fallbacks: 0 },
      { status: "pending" as const, decoded: 0, fallbacks: 0 },
    ]) {
      assert.deepEqual(buildHealthResponse(ready, traffic, extras, false, views), { status: 200, body: { status: "ready", views } });
      assert.equal(buildHealthResponse(starting, traffic, extras, false, views).status, 503);
    }
    // Anything beyond status and counts is dropped, even if a caller passed more.
    const leaky = { status: "off", decoded: 0, fallbacks: 1, reason: "fingerprint-mismatch", dir: "/var/task/.data-snapshot" } as never;
    assert.deepEqual(buildHealthResponse(ready, traffic, extras, false, leaky).body, { status: "ready", views: { status: "off", decoded: 0, fallbacks: 1 } });
  });

  test("the route wires it only through the Preview check and still never caches", () => {
    const route = src("src/app/health/route.ts");
    assert.match(route, /previewViewsDiagnostics\(process\.env\) \? viewsDiagnostics\(dataSource\(\)\.kind === "snapshot"\) : undefined/);
    assert.match(route, /"Cache-Control": "no-store"/);
    // Recording only: nothing but /health reads the diagnostics, and only the snapshot source writes the status.
    const readers = ["src/services/competition/prepare.ts", "src/services/players/adapter.ts", "src/services/competition/moves.ts", "src/services/competition/index.ts", "src/services/competition/cache.ts", "src/lib/cdn-cache.ts", "src/proxy.ts"];
    for (const f of readers) assert.doesNotMatch(src(f), /viewsDiagnostics|recordViewsStatus|views-diagnostics/, f);
    assert.match(src("src/services/competition/snapshot-store.ts"), /recordViewsStatus\(status\)/);
  });
});

describe("status transitions and counts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pt-views-diag-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const levels = () =>
    new Map<LevelId, AflSnapshot | null>([
      ["afl", trajectorySnapshot()],
      ["aaa", null],
      ["aa", scaleSnapshot({ ns: 2, level: "aa", teams: 4, days: 30, seed: 2 })],
      ["high-a", null],
      ["single-a", null],
    ]);
  const dir = async (name: string, views: boolean) => {
    const d = path.join(root, name);
    await writeSnapshotDir(d, { season: 2026, ingestionVersion: name, levels: levels() });
    if (views) await writeSnapshotViews(d, { season: 2026, fingerprint: FP });
    return d;
  };
  const quiet = async <T>(f: () => Promise<T>) => {
    const orig = console.error;
    console.error = () => {};
    try {
      return await f();
    } finally {
      console.error = orig;
    }
  };
  beforeEach(() => resetViewsDiagnostics());

  test("pending until a level is loaded, then on; decoded counts parts served precomputed", async () => {
    const d = await dir("on", true);
    assert.deepEqual(viewsDiagnostics(true), { status: "pending", decoded: 0, fallbacks: 0 });
    const source = snapshotSource(d, 2026, { views: { fingerprint: FP } });
    const aa = await quiet(() => source.load("aa"));
    assert.deepEqual(viewsDiagnostics(true), { status: "on", decoded: 0, fallbacks: 0 }, "loading decodes nothing");
    homeTrending(aa!);
    homeTrending(aa!);
    assert.deepEqual(viewsDiagnostics(true), { status: "on", decoded: 1, fallbacks: 0 });
  });

  test("off when the views are rejected or absent, with no reason exposed", async () => {
    const cases: [string, () => Promise<string>, string | undefined][] = [
      ["other source", () => dir("other-source", true), "e".repeat(64)],
      ["no build fingerprint", () => dir("no-fp", true), undefined],
      ["no views", () => dir("absent", false), FP],
    ];
    for (const [label, make, fp] of cases) {
      resetViewsDiagnostics();
      const d = await make();
      await quiet(() => snapshotSource(d, 2026, { views: { fingerprint: fp } }).load("aa"));
      const v = viewsDiagnostics(true);
      assert.deepEqual(v, { status: "off", decoded: 0, fallbacks: 0 }, label);
      assert.deepEqual(Object.keys(v).sort(), ["decoded", "fallbacks", "status"]);
    }
  });

  test("the rollback switch reports off", async () => {
    const d = await dir("switch", true);
    const prev = process.env.PT_PRECOMPUTED_VIEWS;
    process.env.PT_PRECOMPUTED_VIEWS = "off";
    try {
      await quiet(() => snapshotSource(d, 2026, { views: { fingerprint: FP } }).load("aa"));
      assert.equal(viewsDiagnostics(true).status, "off");
    } finally {
      if (prev === undefined) delete process.env.PT_PRECOMPUTED_VIEWS;
      else process.env.PT_PRECOMPUTED_VIEWS = prev;
    }
  });

  test("a part that fails its check counts as a fallback", async () => {
    const d = await dir("tampered", true);
    rmSync(path.join(d, "views", "aa", "home-trending.json.gz"));
    const aa = await quiet(() => snapshotSource(d, 2026, { views: { fingerprint: FP } }).load("aa"));
    await quiet(async () => homeTrending(aa!));
    assert.deepEqual(viewsDiagnostics(true), { status: "on", decoded: 0, fallbacks: 1 });
  });

  test("database mode (or no data source) reports off, never a pending that would not resolve", () => {
    assert.equal(viewsDiagnostics(false).status, "off");
  });

  test("sources without views (the views build itself, tests) do not touch the status", async () => {
    const d = await dir("plain", true);
    await snapshotSource(d, 2026).load("aa");
    assert.equal(viewsDiagnostics(true).status, "pending");
  });
});
