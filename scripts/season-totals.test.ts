/** Season-totals ingestion (D-030, T-503): adapter, normalization, planner. Fictional data only, no network. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlan } from "../src/ingestion/plan";
import { ingest } from "../src/ingestion/runner";
import { SeasonTotalsStatsApiSource, validateSeasonTotalsOptions } from "../src/ingestion/sources/season-totals-stats-api";
import { parseSeasons } from "./ingest-season-totals";
import { fakeTotalsFetch, hitter, pitcher, type FakeTotals } from "./season-totals-support";

const clock = () => new Date("2026-11-28T12:00:00Z");
const source = (f: FakeTotals, o: { season?: number; scope?: "milb" | "mlb"; known?: number[] } = {}) =>
  new SeasonTotalsStatsApiSource(
    { season: o.season ?? 2014, scope: o.scope ?? "milb" },
    { fetcher: fakeTotalsFetch(f), sleep: async () => {}, clock, knownPlayers: o.known ? new Set(o.known) : undefined },
  );
const milb: FakeTotals = {
  hitting: { 11: [hitter(101), hitter(102, { numTeams: 2 } as never)], 14: [hitter(103)] },
  pitching: { 12: [pitcher(201)], 13: [pitcher(202)] },
};

test("normalizes one row per player, season and level, with the season and new players only", async () => {
  const a = source(milb);
  const batch = a.normalize(await a.load());
  assert.deepEqual(batch.issues, []);
  const kinds = batch.records.reduce<Record<string, number>>((c, r) => ((c[r.kind] = (c[r.kind] ?? 0) + 1), c), {});
  assert.deepEqual(kinds, { season: 1, player: 5, battingSeason: 3, pitchingSeason: 2 });
  assert.ok(!batch.records.some((r) => r.kind === "team" || r.kind === "league" || r.kind === "level"), "no team/league/level entities");
  const b = batch.records.find((r) => r.kind === "battingSeason" && r.player === "101");
  assert.deepEqual(b && b.kind === "battingSeason" && { key: b.key, season: b.season, levelCode: b.levelCode, games: b.games, pa: b.stats.plateAppearances }, {
    key: "milb-2014:aaa:101", season: "milb-2014", levelCode: "aaa", games: 100, pa: 400,
  });
  const p = batch.records.find((r) => r.kind === "pitchingSeason" && r.player === "202");
  assert.equal(p?.kind === "pitchingSeason" && p.levelCode, "high-a", "Class A Advanced is High-A");
  assert.equal(p?.kind === "pitchingSeason" && p.stats.outsRecorded, 360);
  assert.equal(buildPlan(batch).issues.length, 0);
});

test("stored players are referenced, not fetched or rewritten", async () => {
  const requested: string[] = [];
  const fetcher = fakeTotalsFetch(milb);
  const a = new SeasonTotalsStatsApiSource({ season: 2014, scope: "milb" }, {
    fetcher: (async (u: string | URL | Request) => (requested.push(String(u)), fetcher(u))) as typeof fetch,
    sleep: async () => {}, clock, knownPlayers: new Set([101, 102, 103, 201, 202]),
  });
  const batch = a.normalize(await a.load());
  assert.ok(!requested.some((u) => u.includes("/people")));
  assert.equal(batch.records.filter((r) => r.kind === "player").length, 0);
  // Without the stored identities the planner rejects the rows (missing reference), never invents players.
  assert.equal(buildPlan(batch).records.filter((r) => r.kind === "battingSeason").length, 0);
  const known = new Set(["101", "102", "103", "201", "202"].map((id) => `player:${id}`));
  assert.equal(buildPlan(batch, known).records.filter((r) => r.kind === "battingSeason").length, 3);
});

test("MLB scope uses its own season identity", async () => {
  const a = source({ hitting: { 1: [hitter(301)] }, pitching: { 1: [pitcher(401)] } }, { season: 2018, scope: "mlb" });
  const batch = a.normalize(await a.load());
  assert.equal(batch.records.find((r) => r.kind === "season" && "externalId" in r)?.kind === "season" && (batch.records.find((r) => r.kind === "season") as { externalId: string }).externalId, "mlb-2018");
  assert.ok(batch.records.some((r) => r.kind === "battingSeason" && r.levelCode === "mlb"));
});

test("a truncated page or an unexpected sport name fails the capture", async () => {
  await assert.rejects(source({ ...milb, truncate: 1 }).load(), /rows for .* splits/);
  await assert.rejects(source({ ...milb, sportNames: { 1: "x", 11: "Triple-A", 12: "Double-A", 13: "Rookie", 14: "Class A" } }).load(), /not the expected high-a level/);
});

test("a malformed row is quarantined with its key; the rest stay", async () => {
  const a = source({ hitting: { 11: [hitter(101), hitter(102, { hits: 500 })] }, pitching: {} });
  const batch = a.normalize(await a.load());
  assert.equal(batch.issues.length, 1);
  assert.equal(batch.issues[0].recordKey, "battingSeason:milb-2014:aaa:102");
  assert.equal(batch.records.filter((r) => r.kind === "battingSeason").length, 1);
  const report = await ingest(a);
  assert.equal(report.status, "dry-run-with-quarantine");
});

test("options and season lists are validated", () => {
  assert.throws(() => validateSeasonTotalsOptions({ season: 2020, scope: "milb" }, clock()), /no 2020 MiLB season/);
  assert.throws(() => validateSeasonTotalsOptions({ season: 2027, scope: "mlb" }, clock()));
  assert.deepEqual(parseSeasons("2012-2014,2021,2013"), [2012, 2013, 2014, 2021]);
  assert.throws(() => parseSeasons("2019-2012"));
});

test("the capture is deterministic", async () => {
  const a = await ingest(source(milb));
  const b = await ingest(source(milb));
  assert.equal(a.contentHash, b.contentHash);
});
