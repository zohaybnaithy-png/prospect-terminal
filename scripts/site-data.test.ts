/**
 * Site data layer: per-level stale-while-revalidate cache, compact columnar line decoding,
 * per-player profile windows, level fallback notices and process-wide memo slots.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLevelCache, LevelLoadTimeoutError } from "../src/services/competition/cache";
import { ColumnarDecodeError, decodeColumnarLines } from "../src/services/afl/columnar";
import { buildPlayerRows, playerProfile } from "../src/services/afl/read-model";
import { levelFallback, unavailableLevels } from "../src/services/competition/model";
import { processWeakMap } from "../src/lib/process-memo";
import type { AflSnapshot } from "../src/services/afl/types";
import type { LevelId } from "../src/services/players/levels";

// ---------------------------------------------------------------------------------------------
// Level cache

const snap = (tag: string) => ({ league: { id: tag, name: tag } }) as unknown as AflSnapshot;
const tick = () => new Promise((r) => setImmediate(r));

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function harness(opts: { version?: () => Promise<string>; load?: (l: LevelId) => Promise<AflSnapshot | null> } = {}) {
  let clock = 1_000;
  let version = "v1";
  const loads: LevelId[] = [];
  let probes = 0;
  const prepared: string[] = [];
  const errors: string[] = [];
  const cache = createLevelCache({
    load:
      opts.load ??
      (async (level) => {
        loads.push(level);
        return snap(`${level}@${version}`);
      }),
    version:
      opts.version ??
      (async () => {
        probes++;
        return version;
      }),
    checkMs: 60_000,
    now: () => clock,
    prepare: (_l, s) => prepared.push(s?.league.id ?? "null"),
    onBackgroundError: (level) => errors.push(level),
  });
  return {
    cache,
    loads,
    prepared,
    errors,
    get probes() {
      return probes;
    },
    advance: (ms: number) => (clock += ms),
    setVersion: (v: string) => (version = v),
  };
}

test("level cache: loads once, shares an in-flight load and prepares before serving", async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.cache.get("aaa"), h.cache.get("aaa")]);
  assert.equal(a, b);
  assert.deepEqual(h.loads, ["aaa"]);
  assert.deepEqual(h.prepared, ["aaa@v1"]);
  assert.equal(await h.cache.get("aaa"), a);
  assert.deepEqual(h.loads, ["aaa"]);
  assert.deepEqual(h.cache.state("aaa"), { loaded: true, version: "v1", loading: false, failures: 0, retryInMs: 0 });
});

test("level cache: within the check window no probe runs; after it an unchanged version keeps the snapshot", async () => {
  const h = harness();
  const first = await h.cache.get("aa");
  const probesAfterLoad = h.probes;
  h.advance(59_000);
  assert.equal(await h.cache.get("aa"), first);
  await tick();
  assert.equal(h.probes, probesAfterLoad, "no probe inside the window");
  h.advance(2_000);
  assert.equal(await h.cache.get("aa"), first);
  await tick();
  assert.equal(h.probes, probesAfterLoad + 1);
  assert.deepEqual(h.loads, ["aa"], "unchanged version: no reload");
});

test("level cache: a changed version reloads in the background while the previous snapshot is served", async () => {
  const gate = deferred<void>();
  let version = "v1";
  const loads: string[] = [];
  let clock = 0;
  const cache = createLevelCache({
    load: async (level) => {
      loads.push(`${level}@${version}`);
      if (version === "v2") await gate.promise;
      return snap(`${level}@${version}`);
    },
    version: async () => version,
    checkMs: 1_000,
    now: () => clock,
  });
  const old = await cache.get("high-a");
  version = "v2";
  clock += 1_000;
  assert.equal(await cache.get("high-a"), old, "stale served immediately");
  await tick();
  assert.deepEqual(loads, ["high-a@v1", "high-a@v2"]);
  assert.equal(await cache.get("high-a"), old, "still stale while the reload is in flight");
  gate.resolve();
  await tick();
  await tick();
  const fresh = await cache.get("high-a");
  assert.equal(fresh?.league.id, "high-a@v2");
  assert.deepEqual(cache.state("high-a"), { loaded: true, version: "v2", loading: false, failures: 0, retryInMs: 0 });
});

test("level cache: a failed first load is not reused; retries back off (no retry storm) and reset on success", async () => {
  let fail = true;
  let calls = 0;
  let clock = 0;
  const cache = createLevelCache({
    load: async (level) => {
      calls++;
      if (fail) throw Object.assign(new Error("boom"), { code: "ECONNRESET" });
      return snap(level);
    },
    version: async () => "v1",
    checkMs: 60_000,
    now: () => clock,
    retryBaseMs: 5_000,
    retryMaxMs: 20_000,
  });
  await assert.rejects(cache.get("single-a"), /boom/);
  assert.deepEqual(cache.state("single-a"), { loaded: false, version: null, loading: false, failures: 1, retryInMs: 5_000 });
  // Inside the backoff window every request fails fast with the last error and starts no load.
  for (let i = 0; i < 20; i++) await assert.rejects(cache.get("single-a"), /boom/);
  cache.warm(["single-a"]);
  assert.equal(calls, 1, "no new load during backoff");
  // Consecutive failures double the wait, capped.
  clock += 5_000;
  await assert.rejects(cache.get("single-a"), /boom/);
  assert.equal(cache.state("single-a").retryInMs, 10_000);
  clock += 10_000;
  await assert.rejects(cache.get("single-a"), /boom/);
  assert.equal(cache.state("single-a").retryInMs, 20_000);
  clock += 20_000;
  await assert.rejects(cache.get("single-a"), /boom/);
  assert.equal(cache.state("single-a").retryInMs, 20_000, "capped");
  assert.equal(calls, 4);
  // After the window the next request retries; success clears the failure state.
  fail = false;
  clock += 20_000;
  assert.equal((await cache.get("single-a"))!.league.id, "single-a");
  assert.equal(calls, 5);
  assert.deepEqual(cache.state("single-a"), { loaded: true, version: "v1", loading: false, failures: 0, retryInMs: 0 });
});

test("level cache: a load that never finishes is abandoned after loadTimeoutMs (cold and background)", async () => {
  let hang = true;
  let version = "v1";
  let clock = 0;
  const errors: unknown[] = [];
  const cache = createLevelCache({
    load: (level) => (hang ? new Promise<never>(() => {}) : Promise.resolve(snap(`${level}@${version}`))),
    version: async () => version,
    checkMs: 1_000,
    now: () => clock,
    loadTimeoutMs: 30,
    retryBaseMs: 0,
    onBackgroundError: (_l, e) => errors.push(e),
  });
  // Cold: the request is released with a timeout error instead of waiting forever.
  await assert.rejects(cache.get("aa"), LevelLoadTimeoutError);
  assert.equal(cache.state("aa").loading, false);
  hang = false;
  const first = await cache.get("aa");
  assert.equal(first!.league.id, "aa@v1");
  // Background: a hanging reload times out, the previous snapshot stays, and a later window retries.
  hang = true;
  version = "v2";
  clock += 1_000;
  assert.equal(await cache.get("aa"), first);
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(errors[0] instanceof LevelLoadTimeoutError);
  assert.equal(await cache.get("aa"), first, "previous snapshot still served");
  assert.equal(cache.state("aa").version, "v1");
  assert.equal(cache.state("aa").loading, false, "a timed-out reload does not block later refreshes");
  hang = false;
  clock += 1_000;
  await cache.get("aa");
  await tick();
  await tick();
  assert.equal(cache.state("aa").version, "v2");
});

test("level cache: a reload whose result fails to prepare keeps the previous snapshot", async () => {
  let version = "v1";
  let clock = 0;
  const errors: LevelId[] = [];
  const cache = createLevelCache({
    load: async (level) => snap(`${level}@${version}`),
    version: async () => version,
    checkMs: 1_000,
    now: () => clock,
    prepare: (_l, s) => {
      if (s?.league.id.endsWith("v2")) throw new Error("bad snapshot");
    },
    onBackgroundError: (level) => errors.push(level),
  });
  const first = await cache.get("aaa");
  version = "v2";
  clock += 1_000;
  await cache.get("aaa");
  await tick();
  await tick();
  assert.deepEqual(errors, ["aaa"]);
  assert.equal(await cache.get("aaa"), first);
  assert.equal(cache.state("aaa").version, "v1");
});

test("level cache: probe or reload failures keep serving the previous snapshot and are reported", async () => {
  let version: () => Promise<string> = async () => "v1";
  let failLoad = false;
  let clock = 0;
  const errors: LevelId[] = [];
  const cache = createLevelCache({
    load: async (level) => {
      if (failLoad) throw new Error("reload failed");
      return snap(level);
    },
    version: () => version(),
    checkMs: 1_000,
    now: () => clock,
    onBackgroundError: (level) => errors.push(level),
  });
  const first = await cache.get("afl");
  version = async () => {
    throw new Error("probe failed");
  };
  clock += 1_000;
  assert.equal(await cache.get("afl"), first);
  await tick();
  assert.deepEqual(errors, ["afl"]);
  // New version but the reload fails: still the previous snapshot, and the next window retries.
  version = async () => "v2";
  failLoad = true;
  clock += 1_000;
  assert.equal(await cache.get("afl"), first);
  await tick();
  await tick();
  assert.deepEqual(errors, ["afl", "afl"]);
  assert.equal(cache.state("afl").version, "v1");
  failLoad = false;
  clock += 1_000;
  await cache.get("afl");
  await tick();
  await tick();
  assert.equal(cache.state("afl").version, "v2");
});

test("level cache: the version is read before the load, so an apply committed during a load is picked up later", async () => {
  let version = "v1";
  let clock = 0;
  const loads: string[] = [];
  const cache = createLevelCache({
    load: async (level) => {
      // An ingestion apply commits while this level is being read.
      version = "v2";
      loads.push(level);
      return snap(level);
    },
    version: async () => version,
    checkMs: 1_000,
    now: () => clock,
  });
  await cache.get("aaa");
  assert.equal(cache.state("aaa").version, "v1", "recorded the version read before the load");
  clock += 1_000;
  await cache.get("aaa");
  await tick();
  await tick();
  assert.equal(loads.length, 2, "the next probe sees v2 and reloads");
});

test("level cache: probes of different levels at the same moment share one query; warm loads only missing levels", async () => {
  const h = harness();
  await Promise.all((["aaa", "aa", "high-a"] as const).map((l) => h.cache.get(l)));
  assert.equal(h.probes, 1);
  h.cache.warm(["aaa", "single-a", "afl"]);
  await tick();
  await tick();
  assert.deepEqual([...h.loads].sort(), ["aa", "aaa", "afl", "high-a", "single-a"]);
  assert.equal(h.cache.state("single-a").loaded, true);
});

test("level cache: a level that is not ingested (null) is cached like any other result", async () => {
  let calls = 0;
  const cache = createLevelCache({
    load: async () => {
      calls++;
      return null;
    },
    version: async () => "v1",
    checkMs: 60_000,
  });
  assert.equal(await cache.get("afl"), null);
  assert.equal(await cache.get("afl"), null);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------------------------
// Columnar line decoding

const COLS = ["plateAppearances", "runs"] as const;
const P1 = "00000000-0000-4000-9000-000000000001",
  P2 = "00000000-0000-4000-9000-000000000002",
  G1 = "00000000-0000-4000-9000-000000000101",
  G2 = "00000000-0000-4000-9000-000000000102",
  T1 = "00000000-0000-4000-9000-000000000011";
const payload = () => ({
  players: [P1, P2],
  games: [G1, G2],
  teams: [T1],
  p: [0, 1, 0],
  g: [0, 0, 1],
  t: [0, 0, 0],
  plateAppearances: [4, 5, 3],
  runs: [1, null, 0],
});

test("columnar decode: rebuilds exactly the per-line objects, keeping nulls", () => {
  assert.deepEqual(decodeColumnarLines(payload(), COLS, ["plateAppearances"]), [
    { playerId: P1, gameId: G1, teamId: T1, plateAppearances: 4, runs: 1 },
    { playerId: P2, gameId: G1, teamId: T1, plateAppearances: 5, runs: null },
    { playerId: P1, gameId: G2, teamId: T1, plateAppearances: 3, runs: 0 },
  ]);
  const empty = { players: [], games: [], teams: [], p: [], g: [], t: [], plateAppearances: [], runs: [] };
  assert.deepEqual(decodeColumnarLines(empty, COLS), []);
});

test("columnar decode: malformed payloads fail the load instead of producing wrong lines", () => {
  const bad: [string, Record<string, unknown> | undefined][] = [
    ["missing payload", undefined],
    ["missing column", { ...payload(), runs: undefined }],
    ["length mismatch", { ...payload(), plateAppearances: [4, 5] }],
    ["index out of range", { ...payload(), p: [0, 2, 0] }],
    ["negative index", { ...payload(), g: [0, -1, 1] }],
    ["fractional statistic", { ...payload(), plateAppearances: [4, 5.5, 3] }],
    ["string statistic", { ...payload(), plateAppearances: [4, "5", 3] }],
    ["non-string id", { ...payload(), teams: [11] }],
    ["null in a NOT NULL column", { ...payload(), plateAppearances: [4, null, 3] }],
  ];
  for (const [name, p] of bad)
    assert.throws(() => decodeColumnarLines(p, COLS, ["plateAppearances"]), ColumnarDecodeError, name);
});

// ---------------------------------------------------------------------------------------------
// Player profile windows (computed per player instead of building every player's rows)

const uid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
function season(): AflSnapshot {
  const teams = [uid(11), uid(12)];
  const players = Array.from({ length: 6 }, (_, i) => ({
    id: uid(31 + i),
    name: `Synthetic Player ${i}`,
    primaryPosition: i % 3 === 0 ? "P" : "SS",
    secondaryPosition: null,
    bats: "R",
    throws: "R",
    birthDate: "2003-04-05",
    height: null,
    weight: null,
  }));
  const games = Array.from({ length: 40 }, (_, i) => {
    const day = new Date(Date.UTC(2026, 3, 1) + i * 4 * 86_400_000).toISOString().slice(0, 10);
    return {
      id: uid(1000 + i),
      date: day,
      startsAt: `${day}T23:05:00.000Z`,
      status: i === 39 ? "scheduled" : "final",
      homeTeamId: teams[i % 2],
      awayTeamId: teams[(i + 1) % 2],
      homeScore: i === 39 ? null : (i * 7) % 9,
      awayScore: i === 39 ? null : (i * 5) % 8,
      venue: null,
      boxscoreComplete: i !== 39 && i !== 17, // one final game without a complete box score
    };
  });
  const batting = [];
  const pitching = [];
  for (const g of games)
    for (const [k, p] of players.entries()) {
      const n = Number(g.id.slice(-4)) + k;
      if (n % 3 !== 0)
        batting.push({
          playerId: p.id,
          gameId: g.id,
          teamId: teams[k % 2],
          plateAppearances: 3 + (n % 3),
          atBats: 3 + (n % 2),
          hits: n % 4,
          doubles: n % 5 === 0 ? 1 : 0,
          triples: 0,
          homeRuns: n % 7 === 0 ? 1 : 0,
          walks: n % 3 === 1 ? 1 : 0,
          strikeouts: n % 2,
          hitByPitch: 0,
          sacrificeFlies: 0,
          stolenBases: n % 6 === 0 ? 1 : 0,
          runs: n % 11 === 0 ? null : n % 2,
          rbi: n % 3,
          caughtStealing: 0,
        });
      if (p.primaryPosition === "P" && n % 2 === 0)
        pitching.push({
          playerId: p.id,
          gameId: g.id,
          teamId: teams[k % 2],
          outsRecorded: 3 + (n % 10),
          battersFaced: 5 + (n % 9),
          hitsAllowed: n % 4,
          earnedRuns: n % 3,
          walks: n % 2,
          strikeouts: n % 5,
          homeRunsAllowed: n % 7 === 0 ? 1 : 0,
          runs: n % 3,
          hitBatters: null,
          pitches: 20 + n,
        });
    }
  return {
    league: { id: uid(1), name: "Synthetic League" },
    season: { id: uid(2), year: 2026, name: "2026 Synthetic" },
    teams: teams.map((id, i) => ({ id, name: `Team ${i}`, abbreviation: `T${i}` })),
    organizations: [],
    players,
    games,
    rosterStints: [],
    batting,
    pitching,
    lastIngestedAt: null,
  };
}

test("player profile: per-player window aggregates equal the directory rows for every window", () => {
  const s = season();
  for (const p of s.players) {
    const profile = playerProfile(s, p.id)!;
    for (const w of ["7d", "14d", "30d", "season"] as const) {
      const row = buildPlayerRows(s, w).find((r) => r.id === p.id)!;
      assert.deepEqual(profile.windows[w], { batting: row.batting, pitching: row.pitching }, `${p.name} ${w}`);
    }
    assert.deepEqual(profile.row, buildPlayerRows(s, "season").find((r) => r.id === p.id));
    // Game log: one entry per completed game with a line, newest first.
    const completed = new Set(s.games.filter((g) => g.status === "final" && g.boxscoreComplete).map((g) => g.id));
    const withLines = new Set(
      [...s.batting, ...s.pitching].filter((l) => l.playerId === p.id && completed.has(l.gameId)).map((l) => l.gameId),
    );
    assert.equal(profile.gameLog.length, withLines.size);
    assert.ok(profile.gameLog.every((e, i, a) => i === 0 || a[i - 1].date >= e.date));
  }
});

// ---------------------------------------------------------------------------------------------
// Level fallback notices

test("level fallback: explains a requested level that is not shown, and nothing otherwise", () => {
  const status = { aaa: "unavailable", aa: "ok", "high-a": "empty", "single-a": "ok", afl: "ok" } as const;
  assert.deepEqual(levelFallback("aaa", "afl", status), { requested: "aaa", reason: "unavailable" });
  assert.deepEqual(levelFallback("high-a", "afl", status), { requested: "high-a", reason: "not-ingested" });
  assert.deepEqual(levelFallback("aaa", "", status), { requested: "aaa", reason: "unavailable" });
  assert.equal(levelFallback("aa", "aa", status), null);
  assert.equal(levelFallback(undefined, "afl", status), null);
  assert.equal(levelFallback("", "afl", status), null);
  assert.equal(levelFallback("bogus", "afl", status), null, "invalid ids are not echoed back");
  assert.deepEqual(unavailableLevels(status), ["aaa"]);
});

// ---------------------------------------------------------------------------------------------
// Process-wide memo slots

test("process memo: every lookup of a name returns the same WeakMap, and names are separate", () => {
  const a = processWeakMap<object, number>("test-slot-a");
  const key = {};
  a.set(key, 7);
  assert.equal(processWeakMap<object, number>("test-slot-a").get(key), 7);
  assert.equal(processWeakMap<object, number>("test-slot-b").get(key), undefined);
});

// ---------------------------------------------------------------------------------------------
// Query watchdog and timing (fake pool: no database)

import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import {
  currentTrace,
  instrumentPool,
  newTrace,
  queryLabel,
  summarizeTrace,
  withTrace,
} from "../src/db/instrument";
import { closedByWatchdog, tracedLevelLoader } from "../src/services/competition/load";

function fakePool() {
  const stream = Object.assign(new EventEmitter(), { destroyed: false, destroy() {} });
  const client = Object.assign(new EventEmitter(), {
    connection: { stream },
    pending: undefined as undefined | { resolve: (v: unknown) => void; reject: (e: Error) => void },
    query(text: string) {
      void text;
      return new Promise((resolve, reject) => (client.pending = { resolve, reject }));
    },
  });
  stream.destroy = () => {
    stream.destroyed = true;
    // What pg does when its socket closes under an active query.
    client.emit("error", new Error("Connection terminated unexpectedly"));
    client.pending?.reject(new Error("Connection terminated unexpectedly"));
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, client, stream };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("watchdog: a query whose connection goes silent is closed as stalled, and the process survives", async () => {
  const { pool, client, stream } = fakePool();
  const closed: string[] = [];
  const stop = instrumentPool(pool, { queryDeadlineMs: 0, stallMs: 60, sweepMs: 10, onDeadline: (l, _ms, r) => closed.push(`${r}:${l}`) });
  const trace = newTrace("aaa");
  await withTrace(trace, async () => {
    const c = await pool.connect();
    const q = (c as unknown as typeof client).query('select "a" from "player_batting_games" where x = $1');
    stream.emit("data", Buffer.alloc(100));
    await assert.rejects(q, /terminated/);
  });
  stop();
  assert.equal(stream.destroyed, true);
  assert.deepEqual(closed, ["stalled:select:player_batting_games"]);
  assert.equal(trace.queries[0].outcome, "stalled");
  assert.equal(trace.queries[0].bytes, 100);
  assert.ok(closedByWatchdog(trace));
  // The client 'error' was handled (an unhandled one would have thrown here).
  assert.ok(client.listenerCount("error") >= 1);
});

test("watchdog: steady progress is never closed; the total deadline still applies", async () => {
  const { pool, stream } = fakePool();
  type FakeClient = ReturnType<typeof fakePool>["client"];
  const closed: string[] = [];
  const stop = instrumentPool(pool, { queryDeadlineMs: 300, stallMs: 80, sweepMs: 10, onDeadline: (_l, _ms, r) => closed.push(r) });
  const c = (await pool.connect()) as unknown as FakeClient;
  const q = c.query("select 1");
  const feed = setInterval(() => stream.emit("data", Buffer.alloc(10)), 20);
  await sleep(150);
  assert.deepEqual(closed, [], "bytes keep arriving: not a stall");
  await assert.rejects(q, /terminated/);
  clearInterval(feed);
  stop();
  assert.deepEqual(closed, ["deadline"]);
});

test("watchdog: a process pause (blocked event loop or sleep) is not mistaken for a stall", async () => {
  const { pool, client, stream } = fakePool();
  const closed: string[] = [];
  const stop = instrumentPool(pool, { queryDeadlineMs: 0, stallMs: 100, sweepMs: 20, onDeadline: (_l, _ms, r) => closed.push(r) });
  const c = (await pool.connect()) as unknown as typeof client;
  const q = c.query("select 1");
  await sleep(30);
  const until = performance.now() + 250; // block the event loop longer than stallMs
  while (performance.now() < until);
  await sleep(40); // the late sweep resets the idle clock instead of closing
  stream.emit("data", Buffer.alloc(10));
  client.pending!.resolve({ rows: [] });
  await q;
  stop();
  assert.deepEqual(closed, []);
  assert.equal(stream.destroyed, false);
});

test("query timing: labels and summaries never include SQL parameters or connection details", () => {
  assert.equal(queryLabel(`select "x" from "players" where "id" in ($1, $2)`), "select:players");
  assert.equal(queryLabel(" with x as materialized ( select 1 from \"player_pitching_games\" )"), "with:player_pitching_games");
  assert.equal(queryLabel("begin isolation level repeatable read read only"), "begin");
  const t = newTrace("aaa");
  t.queries.push({ label: "select:games", firstByteMs: 80, lastByteMs: 900, totalMs: 910, bytes: 400_000, chunks: 30, maxGapMs: 50, bytesBeforeMaxGap: 1000, outcome: "ok" });
  const line = summarizeTrace(t, 1_000);
  assert.match(line, /^aaa 1\.00s: .*select:games/);
  assert.doesNotMatch(line, /postgres|password|\$1|neon\.tech/i);
});

test("traced loader: a load failed by a stalled connection is retried once; other failures are not", async () => {
  const markStalled = () =>
    currentTrace()!.queries.push({ label: "with:player_batting_games", firstByteMs: 1, lastByteMs: 9, totalMs: 9000, bytes: 10, chunks: 1, maxGapMs: 8000, bytesBeforeMaxGap: 10, outcome: "stalled" });
  const traces: string[] = [];
  const onTrace = (t: { name: string }, _ms: number, ok: boolean) => traces.push(`${t.name}:${ok ? "ok" : "failed"}`);

  let calls = 0;
  const recovers = tracedLevelLoader(async (level) => {
    if (++calls === 1) {
      markStalled();
      throw new Error("Connection terminated");
    }
    return snap(level);
  }, { onTrace });
  assert.equal((await recovers("aaa"))!.league.id, "aaa");
  assert.deepEqual(traces, ["aaa:failed", "aaa (retry 1):ok"]);

  traces.length = 0;
  const alwaysStalls = tracedLevelLoader(async () => {
    markStalled();
    throw new Error("Connection terminated");
  }, { onTrace });
  await assert.rejects(alwaysStalls("aa"), /terminated/);
  assert.deepEqual(traces, ["aa:failed", "aa (retry 1):failed"], "at most one retry");

  traces.length = 0;
  let sqlCalls = 0;
  const sqlError = tracedLevelLoader(async () => {
    sqlCalls++;
    throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
  }, { onTrace });
  await assert.rejects(sqlError("afl"), /does not exist/);
  assert.equal(sqlCalls, 1, "non-stall failures are not retried");
});

test("watchdog: a connection that keeps trickling below the minimum rate is closed as slow; a fast one is not", async () => {
  const run = async (bytesPerTick: number) => {
    const { pool, client, stream } = fakePool();
    const closed: string[] = [];
    const stop = instrumentPool(pool, {
      queryDeadlineMs: 0,
      stallMs: 1_000,
      slowAfterMs: 100,
      minBytesPerSec: 50_000,
      sweepMs: 10,
      onDeadline: (_l, _ms, r) => closed.push(r),
    });
    const c = (await pool.connect()) as unknown as typeof client;
    const q = c.query("select 1");
    q.catch(() => {});
    const feed = setInterval(() => stream.emit("data", Buffer.alloc(bytesPerTick)), 10);
    await sleep(220);
    clearInterval(feed);
    if (!stream.destroyed) client.pending!.resolve({ rows: [] });
    await q.catch(() => {});
    stop();
    return closed;
  };
  assert.deepEqual(await run(50), ["slow"], "~5 kB/s: degraded");
  assert.deepEqual(await run(5_000), [], "~500 kB/s: healthy");
});
