/**
 * Phase 6A observability: what /health exposes beyond readiness, and the local monitor
 * (scripts/ops/monitor.ts). Each check was written to reproduce a gap before the change.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createLevelCache } from "../src/services/competition/cache";
import { healthHttpStatus, healthReport } from "../src/services/competition/health";
import type { AflSnapshot } from "../src/services/afl/types";

const keepAlive = setInterval(() => {}, 1_000); // see site-data.test.ts: cache timers are unref'd
after(() => clearInterval(keepAlive));
const snap = (tag: string) => ({ league: { id: tag, name: tag } }) as unknown as AflSnapshot;
const settle = () => new Promise((r) => setImmediate(r));

describe("/health: database refresh failures after start are visible", () => {
  test("a level whose background reload keeps failing stays ready (200) but is listed in refreshFailing", async () => {
    let clock = 1_000, version = "v1", fail = false;
    const cache = createLevelCache({
      load: async (l) => (fail ? Promise.reject(new Error("database down")) : snap(`${l}@${version}`)),
      version: async () => (fail ? Promise.reject(new Error("database down")) : version),
      checkMs: 60_000,
      now: () => clock,
      onBackgroundError: () => {},
    });
    const report = () => healthReport(true, [["aaa", cache.state("aaa")], ["aa", cache.state("aa")]]);
    await cache.get("aaa");
    await cache.get("aa");
    assert.deepEqual(report(), { status: "ready", levels: { aaa: "ready", aa: "ready" } });
    // The database goes away: the next check of AAA fails; AA has not been checked again yet.
    fail = true;
    version = "v2";
    clock += 61_000;
    await cache.get("aaa");
    for (let i = 0; i < 5; i++) await settle();
    const r = report();
    assert.equal(r.status, "ready", "still serving the last snapshot");
    assert.equal(healthHttpStatus(r), 200);
    assert.deepEqual(r.refreshFailing, ["aaa"]);
    // The database comes back: the failure clears.
    fail = false;
    clock += 120_000;
    await cache.get("aaa");
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(report().refreshFailing, undefined);
  });
});

describe("local monitor (scripts/ops/monitor.ts)", async () => {
  const { analyzeAccessLog, evaluate5xx, evaluateHealth, evaluateRefresh, runMonitor } = await import("./ops/monitor");
  const { ACTIVE_WINDOWS } = await import("../src/ingestion/refresh/schedule");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const NOW = new Date("2026-06-15T12:00:00Z");
  const line = (secondsAgo: number, status: number) =>
    JSON.stringify({ level: "info", ts: NOW.getTime() / 1000 - secondsAgo, logger: "http.log.access.log0", msg: "handled request", request: { remote_ip: "203.0.113.9", uri: "/players" }, status });

  test("health: ready and protected is ok; refresh failures, misconfiguration and memory alert", () => {
    const ok = evaluateHealth(200, { status: "ready", traffic: { status: "protected" }, process: { rssMB: 900, heapUsedMB: 500, heapLimitMB: 1536 } }, 2560);
    assert.deepEqual(ok.map((c) => c.status), ["ok", "ok", "ok"]);
    const db = evaluateHealth(200, { status: "ready", refreshFailing: ["aaa", "afl"], traffic: { status: "protected" }, process: { rssMB: 2700 } }, 2560);
    assert.deepEqual(db.map((c) => [c.name, c.status]), [["health", "alert"], ["traffic", "ok"], ["memory", "alert"]]);
    assert.match(db[0].detail, /database refresh failing for aaa, afl/);
    assert.match(db[2].detail, /rss 2700 MB/);
    const mis = evaluateHealth(503, { status: "misconfigured", traffic: { status: "misconfigured", reason: "PT_CLIENT_IP_HEADER is unset" } }, 2560);
    assert.equal(mis[0].status, "alert");
    assert.match(mis[1].detail, /traffic protection misconfigured \(PT_CLIENT_IP_HEADER is unset\)/);
  });

  test("5xx: only the window counts, malformed lines are ignored, small numbers do not alert", () => {
    const lines = [
      ...Array.from({ length: 95 }, () => line(60, 200)),
      ...Array.from({ length: 5 }, () => line(30, 502)),
      line(3600, 500), // outside the 10-minute window
      "not json",
      "{\"broken\":",
    ];
    const a = analyzeAccessLog(lines, NOW.getTime(), 10 * 60_000);
    assert.deepEqual([a.total, a.errors, a.byStatus], [100, 5, { "502": 5 }]);
    assert.equal(evaluate5xx(a, 10).status, "alert");
    assert.equal(evaluate5xx(analyzeAccessLog([line(10, 503), line(10, 200)], NOW.getTime(), 600_000), 10).status, "ok", "a single error is not an alert");
    assert.equal(evaluate5xx(analyzeAccessLog([...Array(1000).fill(line(1, 200)), ...Array(6).fill(line(1, 500))], NOW.getTime(), 600_000), 10).status, "ok", "0.6% is below 2%");
  });

  test("refresh: failed jobs alert; a stopped timer alerts in season only", () => {
    assert.equal(evaluateRefresh({ status: "ok", finishedAt: "2026-06-15T10:30:00Z" }, NOW, ACTIVE_WINDOWS).status, "ok");
    for (const s of ["failed", "error", "timed-out", "aborted", "locked-stale"])
      assert.equal(evaluateRefresh({ status: s, finishedAt: "2026-06-15T10:30:00Z" }, NOW, ACTIVE_WINDOWS).status, "alert", s);
    assert.equal(evaluateRefresh({ status: "locked", finishedAt: "2026-06-15T10:30:00Z" }, NOW, ACTIVE_WINDOWS).status, "ok", "normal overlap");
    assert.match(evaluateRefresh({ status: "ok", finishedAt: "2026-06-13T10:30:00Z" }, NOW, ACTIVE_WINDOWS).detail, /no refresh job for 50 h/);
    assert.equal(evaluateRefresh({ status: "ok", finishedAt: "2026-11-25T10:30:00Z" }, new Date("2027-01-20T00:00:00Z"), ACTIVE_WINDOWS).status, "ok", "off-season");
    assert.equal(evaluateRefresh(null, NOW, ACTIVE_WINDOWS).status, "alert");
  });

  test("a full run: app down, 5xx burst and a failed refresh are all reported; the ping says /fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pt-monitor-"));
    writeFileSync(join(dir, "access.log"), [...Array(50).fill(line(20, 200)), ...Array(10).fill(line(10, 502))].join("\n") + "\n");
    writeFileSync(join(dir, "last-job.json"), JSON.stringify({ status: "error", finishedAt: "2026-06-15T10:30:00Z", error: "Error: ECONNREFUSED" }));
    const pinged: string[] = [];
    const fake = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/health")) throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
      pinged.push(u);
      return new Response("ok");
    }) as typeof fetch;
    const r = await runMonitor(
      { PT_MONITOR_ACCESS_LOG: join(dir, "access.log"), PT_MONITOR_REFRESH_STATE: join(dir, "last-job.json"), PT_MONITOR_PING_URL: "https://hc.example/ping/m1" },
      { fetch: fake, now: () => NOW },
    );
    assert.equal(r.status, "alert");
    assert.deepEqual(Object.fromEntries(r.checks.map((c) => [c.name, c.status])), { app: "alert", "http-5xx": "alert", refresh: "alert", freshness: "skipped" });
    assert.deepEqual(pinged, ["https://hc.example/ping/m1/fail"]);
    assert.ok(r.checks.every((c) => !/203\.0\.113\.9/.test(c.detail)), "never echoes client addresses");
  });

  test("a healthy run pings success; missing inputs are skipped, not alerts", async () => {
    const pinged: string[] = [];
    const fake = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/health"))
        return Response.json({ status: "ready", levels: {}, traffic: { status: "protected" }, process: { rssMB: 800, heapUsedMB: 400, heapLimitMB: 1536 } });
      pinged.push(u);
      return new Response("ok");
    }) as typeof fetch;
    const r = await runMonitor(
      { PT_MONITOR_ACCESS_LOG: "/nonexistent/access.log", PT_MONITOR_REFRESH_STATE: "/nonexistent/dir/last-job.json", PT_MONITOR_PING_URL: "https://hc.example/ping/m1" },
      { fetch: fake, now: () => new Date("2027-01-20T00:00:00Z") },
    );
    assert.equal(r.status, "ok");
    assert.deepEqual(Object.fromEntries(r.checks.map((c) => [c.name, c.status])), { app: "ok", health: "ok", traffic: "ok", memory: "ok", "http-5xx": "skipped", refresh: "ok", freshness: "skipped" });
    assert.deepEqual(pinged, ["https://hc.example/ping/m1"]);
  });
});
