import { test } from "node:test";
import assert from "node:assert/strict";
import { MLBStatsApiSource } from "../src/ingestion/sources/mlb-stats-api";
import { MlbClient } from "../src/ingestion/sources/mlb-client";
import {
  inningsToOuts,
  battingStats,
  pitchingStats,
} from "../src/ingestion/sources/mlb-normalize";
import { buildPlan } from "../src/ingestion/plan";
import { ingest } from "../src/ingestion/runner";
import { parseIngestionArgs } from "../src/ingestion/cli-options";
import { mockMlbFetch, syntheticMlb } from "./mlb-test-support";
const clock = () => new Date("2026-10-27T12:00:00Z");
export async function offlineLiveAdapter(
  data = syntheticMlb(),
  options: {
    from?: string;
    to?: string;
    mode?: "all" | "rosters" | "games";
  } = {},
) {
  const mock = mockMlbFetch(data);
  const source = new MLBStatsApiSource(
    { season: 2026, ...options },
    { fetcher: mock.fetcher, sleep: async () => {}, clock },
  );
  const snapshot = await source.load();
  return {
    mock,
    source,
    snapshot,
    plan: buildPlan(source.normalize(snapshot)),
  };
}
test("live-shaped offline AFL normalizes discovered teams, people, separate organization observations, schedule and complete boxscores", async () => {
  const { mock, plan } = await offlineLiveAdapter();
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.records.filter((r) => r.kind === "team").length, 6);
  assert.equal(plan.records.filter((r) => r.kind === "player").length, 3);
  assert.ok(
    plan.records
      .filter((r) => r.kind === "team")
      .every((t) => t.organization === null),
  );
  assert.equal(plan.records.filter((r) => r.kind === "game").length, 3);
  assert.equal(plan.records.filter((r) => r.kind === "battingGame").length, 4);
  assert.equal(plan.records.filter((r) => r.kind === "pitchingGame").length, 4);
  assert.equal(plan.records.filter((r) => r.kind === "gameLineSet").length, 2);
  assert.equal(
    plan.records.filter(
      (r) => r.kind === "organizationMembership" || r.kind === "teamMembership",
    ).length,
    0,
  );
  const roster = plan.records.filter((r) => r.kind === "rosterObservation");
  assert.equal(roster.find((r) => r.player === "1001")!.organization, "9301");
  assert.equal(roster.find((r) => r.player === "1002")!.organization, null);
  assert.equal(roster.find((r) => r.player === "1003")!.organization, "9302");
  assert.ok(
    roster.every((r) => r.season === "afl-2026" && r.rosterStatus === "Active"),
  );
  assert.ok(
    mock.urls.every((u) => u.startsWith("https://statsapi.mlb.com/api/v1/")),
  );
  assert.ok(!mock.urls.some((u) => u.includes("8003/boxscore")));
  assert.equal(mock.maxActive, 1);
});
test("incremental bounds fetch only completed games within scope; roster-only avoids schedule/boxscores", async () => {
  const subset = await offlineLiveAdapter(undefined, {
    from: "2026-10-20",
    to: "2026-10-25",
    mode: "games",
  });
  assert.equal(subset.plan.records.filter((r) => r.kind === "game").length, 1);
  assert.equal(
    subset.plan.records.filter((r) => r.kind === "rosterObservation").length,
    0,
  );
  assert.ok(
    !subset.mock.urls.some(
      (u) => u.includes("/roster") || u.includes("8002/boxscore"),
    ),
  );
  const roster = await offlineLiveAdapter(undefined, { mode: "rosters" });
  assert.ok(
    !roster.mock.urls.some(
      (u) => u.includes("schedule") || u.includes("/boxscore"),
    ),
  );
});
test("invalid game statistics quarantine the whole boxscore without dropping unrelated teams or another game's stats", async () => {
  const data = syntheticMlb();
  data.boxes["8001"].teams.home.players.ID1001.stats.batting.hits = 99;
  const { plan } = await offlineLiveAdapter(data);
  assert.ok(plan.issues.length);
  assert.equal(plan.quarantinePolicy, "records");
  assert.equal(plan.records.filter((r) => r.kind === "team").length, 6);
  assert.equal(plan.records.filter((r) => r.kind === "battingGame").length, 2);
  assert.ok(
    !plan.records.some((r) => r.kind === "gameLineSet" && r.game === "8001"),
  );
});
test("baseball innings and required counts are validated rather than coerced into decimal innings/zeros", () => {
  assert.equal(inningsToOuts("5.2"), 17);
  assert.equal(inningsToOuts("0.0"), 0);
  for (const value of [5.2, "5.3", "5.9", "-1.0", "NaN"])
    assert.throws(() => inningsToOuts(value));
  assert.throws(
    () => pitchingStats({ inningsPitched: "5.2", outs: 18 }),
    /disagree/,
  );
  const missing = battingStats({ atBats: 4 }) as { hits?: number };
  assert.equal(missing.hits, undefined);
});
test("URL cache reuses responses and transport errors do not fabricate provider data", async () => {
  const mock = mockMlbFetch();
  const client = new MlbClient({
    fetcher: mock.fetcher,
    sleep: async () => {},
  });
  await Promise.all([client.get("league/119"), client.get("league/119")]);
  assert.equal(mock.urls.length, 1);
  assert.throws(
    () => new MlbClient({ baseUrl: "http://example.test/api/v1" }),
    /HTTPS/,
  );
  const source = new MLBStatsApiSource(
    { season: 2026 },
    {
      fetcher: async () => {
        throw new Error("offline fixture");
      },
      sleep: async () => {},
    },
  );
  await assert.rejects(() => ingest(source), /league\/119/);
});
test("CLI selects sources and rejects conflicting/invalid ranges before making requests", () => {
  assert.equal(
    parseIngestionArgs(["--source=live", "--season=2026", "--dry-run"]).apply,
    false,
  );
  assert.equal(
    parseIngestionArgs([
      "--source",
      "live",
      "--season",
      "2026",
      "--apply",
      "--games-only",
    ]).mode,
    "games",
  );
  assert.throws(() => parseIngestionArgs(["--apply", "--dry-run"]));
  assert.throws(() =>
    parseIngestionArgs(["--from=2026-11-01", "--to=2026-10-01"]),
  );
  assert.throws(() =>
    parseIngestionArgs(["--source=fixture", "--season=2025"]),
  );
});

test("a failed roster is diagnosed while valid teams/schedule remain available", async () => {
  const mock = mockMlbFetch();
  const source = new MLBStatsApiSource(
    { season: 2026 },
    {
      fetcher: async (input, init) =>
        String(input).includes("/teams/9106/roster")
          ? new Response("unavailable", { status: 503 })
          : mock.fetcher(input, init),
      sleep: async () => {},
      clock,
    },
  );
  const report = await ingest(source);
  assert.equal(report.status, "dry-run-with-quarantine");
  assert.ok(report.issues > 0);
  assert.equal(report.operations!.team, 6);
  assert.ok(report.diagnostics!.some((i) => i.recordKey === "roster:9106"));
});
test("bounded network-error retries are injected and cannot turn an outage into a successful empty feed", async () => {
  const { fetchJson } = await import("../src/ingestion/http");
  let attempts = 0;
  const response = await fetchJson(new URL("https://fixture.test/api"), {
    fetcher: async () => {
      attempts++;
      if (attempts < 3) throw new Error("temporary");
      return new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
      });
    },
    sleep: async () => {},
  });
  assert.equal(attempts, 3);
  assert.deepEqual(response, { ok: true });
});
