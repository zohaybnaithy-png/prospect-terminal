import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyHealth,
  classifyRuntimeLogs,
  createHealthEvaluator,
  formatTimingTable,
  isBenignConsoleError,
  isPreviewHost,
  isProtectionResponse,
  mayReceiveBypass,
  parseBuildLog,
  sameSnapshot,
  summarizeTimings,
  type TimingSample,
} from "./preview-verify-support";

const HOST = "prospect-terminal-8aw340b8c-zo-s.vercel.app";
const READY = { status: 200, body: '{"status":"ready","views":{"status":"on","decoded":0,"fallbacks":0}}' };
const COLD = { status: 503, body: '{"status":"unavailable","views":{"status":"pending","decoded":0,"fallbacks":0}}' };

describe("bypass header scoping", () => {
  test("only the deployment's own https host may receive the header", () => {
    assert.equal(mayReceiveBypass(`https://${HOST}/health`, HOST), true);
    assert.equal(mayReceiveBypass(`https://${HOST.toUpperCase()}/players?level=aa`, HOST), true);
  });
  test("every other origin is refused", () => {
    for (const url of [
      "https://vercel.live/_next-live/feedback/feedback.js",
      "https://vercel.com/sso-api?url=x",
      `http://${HOST}/health`, // plain http
      `https://${HOST}.evil.example/health`,
      `https://evil.example/?h=${HOST}`,
      "https://prospect-terminal-git-other-zo-s.vercel.app/", // a different deployment
      `https://${HOST}:8443/`,
      "not a url",
    ])
      assert.equal(mayReceiveBypass(url, HOST), false, url);
  });
  test("a non-vercel.app deployment host never qualifies", () => {
    assert.equal(isPreviewHost("prospect-terminal.example.com"), false);
    assert.equal(mayReceiveBypass("https://prospect-terminal.example.com/", "prospect-terminal.example.com"), false);
  });
});

describe("protection detection", () => {
  test("SSO redirect and 401 page count as protected", () => {
    assert.equal(isProtectionResponse(302, "https://vercel.com/sso-api?url=https%3A%2F%2Fx&nonce=1", ""), true);
    assert.equal(isProtectionResponse(401, null, "<title>Authentication Required</title>"), true);
  });
  test("a served page or a foreign redirect does not", () => {
    assert.equal(isProtectionResponse(200, null, '{"status":"ready"}'), false);
    assert.equal(isProtectionResponse(302, "https://evil.example/sso-api", ""), false);
    assert.equal(isProtectionResponse(307, "/players", ""), false);
  });
});

describe("health classification", () => {
  test("ready, cold start, and the unhealthy variants", () => {
    assert.equal(classifyHealth(READY).kind, "ready");
    assert.equal(classifyHealth(COLD).kind, "cold-start");
    assert.equal(classifyHealth({ status: 200, body: '{"status":"ready","views":{"status":"off","fallbacks":0}}' }).kind, "unhealthy");
    assert.equal(classifyHealth({ status: 200, body: '{"status":"ready","views":{"status":"on","fallbacks":2}}' }).kind, "unhealthy");
    assert.equal(classifyHealth({ status: 200, body: '{"status":"ready"}' }).kind, "unhealthy");
    assert.equal(classifyHealth({ status: 503, body: '{"status":"unavailable","views":{"status":"on","fallbacks":0}}' }).kind, "unhealthy");
    assert.equal(classifyHealth({ status: 500, body: "<html>" }).kind, "unhealthy");
  });
});

describe("health evaluator (bounded cold-start retries)", () => {
  const policy = { warmupAttempts: 4, polls: 3, maxConsecutiveColdStarts: 2 };
  const feed = (samples: (typeof READY)[]) => {
    const e = createHealthEvaluator(policy);
    let used = 0;
    for (const s of samples) {
      used++;
      if (!e.add(s)) break;
    }
    return { ...e.verdict(), used };
  };
  test("PR #22 shape: one cold start, then ready", () => {
    const v = feed([COLD, READY, READY, READY, READY]);
    assert.equal(v.ok, true);
    assert.equal(v.coldStarts, 1);
    assert.equal(v.used, 5);
  });
  test("a mid-run cold start on a new instance is tolerated", () => {
    assert.equal(feed([READY, READY, COLD, READY, READY]).ok, true);
  });
  test("never warming up fails after the bound", () => {
    const v = feed([COLD, COLD, COLD, COLD, READY]);
    assert.equal(v.ok, false);
    assert.equal(v.used, 4);
  });
  test("too many consecutive cold starts after warm-up fail", () => {
    assert.equal(feed([READY, COLD, COLD, COLD, READY, READY, READY]).ok, false);
  });
  test("any unhealthy answer fails immediately", () => {
    const v = feed([READY, { status: 200, body: '{"status":"ready","views":{"status":"off","fallbacks":0}}' }, READY, READY]);
    assert.equal(v.ok, false);
    assert.equal(v.used, 2);
  });
});

describe("build log parsing", () => {
  const LOG = `
2026-11-22T23:16:11.691Z  [snapshot] aaa: 2093 players, 2250 games, 42053 batting and 19824 pitching lines (3237 ms)
2026-11-22T23:16:14.723Z  [snapshot] high-a: 1867 players, 1980 games, 36284 batting and 15211 pitching lines (1481 ms)
2026-11-22T23:16:21.036Z  [snapshot] verified 2 levels against the database read (snapshot 7efabf4a38dd)
2026-11-22T23:16:21.036Z  "snapshotId": "7efabf4a38ddc68aa0c0be152556870dbedd3df863d96436b52ec4bd32907010",
2026-11-22T23:16:24.560Z  [snapshot-views] aaa: 17 parts, 877 kB (compute 1824 ms, encode+verify 860 ms)
2026-11-22T23:16:28.786Z  [snapshot-views] high-a: 17 parts, 818 kB (compute 1212 ms, encode+verify 680 ms)
2026-11-22T23:16:31.913Z  [snapshot-views] done: 3.60 MB in 10.2 s
2026-11-22T23:16:32.450Z  ▲ Next.js 16.4.5 (Turbopack)
2026-11-22T23:16:58.552Z  Build Completed in /vercel/output [2m]
2026-11-22T23:17:02.100Z  Deployment completed`;
  test("extracts snapshot, levels, views and completion", () => {
    const f = parseBuildLog(LOG);
    assert.equal(f.guardRefused, false);
    assert.equal(f.buildCompleted, true);
    assert.equal(f.snapshotId, "7efabf4a38ddc68aa0c0be152556870dbedd3df863d96436b52ec4bd32907010");
    assert.equal(f.verifiedLevels, 2);
    assert.deepEqual(f.exportedLevels.map((l) => l.level), ["aaa", "high-a"]);
    assert.deepEqual(f.viewsLevels, ["aaa", "high-a"]);
    assert.equal(f.viewsDone, true);
    assert.equal(f.nextVersion, "16.4.5");
  });
  test("detects a refused build", () => {
    const f = parseBuildLog("Error: Vercel preview build refused: PT_DATA_SOURCE is not set.");
    assert.equal(f.guardRefused, true);
    assert.equal(f.buildCompleted, false);
    assert.equal(f.snapshotId, null);
  });
});

describe("runtime log classification", () => {
  test("startup lines (stderr, tagged error by Vercel) are not problems", () => {
    const f = classifyRuntimeLogs([
      { level: "error", message: "[competition-views] precomputed views on (snapshot 7efabf4a38dd, 5 levels)", requestPath: "/health" },
      { level: "error", message: "[competition-data] loaded aaa in 2400 ms", requestPath: "/" },
    ]);
    assert.deepEqual(f.problems, []);
    assert.deepEqual(f.startups, [{ snapshot: "7efabf4a38dd", levels: 5 }]);
  });
  test("real failures and degraded modes are problems", () => {
    const f = classifyRuntimeLogs([
      { level: "error", message: "[competition-views] precomputed views off: the views were computed from a different data snapshot" },
      { level: "error", message: "[competition-data] load failed: aaa read 120 ms" },
      { level: "error", message: "[traffic] refused 12 requests in the last minute" },
      { level: "info", message: "Unhandled Rejection: TypeError: x is undefined" },
      { level: "fatal", message: "FUNCTION_INVOCATION_TIMEOUT" },
    ]);
    assert.equal(f.problems.length, 5);
    assert.equal(f.startups.length, 0);
  });
  test("snapshot ids match by prefix only when long enough", () => {
    const full = "7efabf4a38ddc68aa0c0be152556870dbedd3df863d96436b52ec4bd32907010";
    assert.equal(sameSnapshot(full, "7efabf4a38dd"), true);
    assert.equal(sameSnapshot(full, "8efabf4a38dd"), false);
    assert.equal(sameSnapshot(full, "7efa"), false);
    assert.equal(sameSnapshot(null, "7efabf4a38dd"), false);
  });
});

test("only the Vercel toolbar CSP error is benign", () => {
  assert.equal(isBenignConsoleError("Loading the script 'https://vercel.live/_next-live/feedback/feedback.js' violates the following Content Security Policy directive"), true);
  assert.equal(isBenignConsoleError("Uncaught TypeError: Cannot read properties of undefined"), false);
});

describe("response timing summary (T-102)", () => {
  const t = (totalMs: number, extra: Partial<TimingSample> = {}): TimingSample => ({
    status: 200, ttfbMs: totalMs * 0.8, totalMs, cache: null, serverTiming: null, ...extra,
  });

  test("first request kept separate; warm median, max and cache values", () => {
    const [row] = summarizeTimings([
      { path: "/", first: t(1234.4, { cache: "MISS" }), warm: [t(90.2, { cache: "HIT" }), t(110.6, { cache: "HIT" }), t(70.1, { cache: "HIT" })] },
    ]);
    assert.deepEqual(row, {
      path: "/", status: 200,
      firstTtfbMs: 988, firstTotalMs: 1234, firstCache: "MISS",
      warmTtfbMedianMs: 72, warmTotalMedianMs: 90, warmTotalMaxMs: 111, warmCache: ["HIT"],
    });
  });

  test("even sample count: median is the rounded mean of the middle two", () => {
    const [row] = summarizeTimings([{ path: "/trends?level=aa", first: t(500), warm: [t(100), t(201), t(300), t(400)] }]);
    assert.equal(row.warmTotalMedianMs, 251);
  });

  test("warm samples with a different status are excluded; none left gives nulls", () => {
    const [mixed] = summarizeTimings([{ path: "/x", first: t(300), warm: [t(50, { status: 503 }), t(80)] }]);
    assert.equal(mixed.warmTotalMedianMs, 80);
    assert.deepEqual(mixed.warmCache, ["-"]);
    const [none] = summarizeTimings([{ path: "/y", first: t(300), warm: [t(50, { status: 500 })] }]);
    assert.equal(none.warmTotalMedianMs, null);
    assert.equal(none.warmTotalMaxMs, null);
    assert.deepEqual(none.warmCache, []);
  });

  test("table has a header, a rule and one aligned line per path", () => {
    const rows = summarizeTimings([
      { path: "/", first: t(1000), warm: [t(100)] },
      { path: "/players?level=high-a", first: t(2000, { cache: "MISS" }), warm: [] },
    ]);
    const lines = formatTimingTable(rows).split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^path\s+status\s+first ttfb/);
    assert.match(lines[1], /^-+\s+-+/);
    assert.ok(lines[3].startsWith("/players?level=high-a"));
    assert.match(lines[3], /MISS/);
    assert.ok(lines.every((l) => l.length === lines[0].length), "columns align");
  });
});
