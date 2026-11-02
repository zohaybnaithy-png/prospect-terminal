import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectAflSchedule,
  normalizedGame,
} from "../src/ingestion/sources/mlb-schedule";
import {
  recordedSchedule,
  recordedClubIds,
  recordedScheduleFetch,
} from "./mlb-test-support";
import { MLBStatsApiSource } from "../src/ingestion/sources/mlb-stats-api";
import { ingest } from "../src/ingestion/runner";
import { buildPlan, fingerprint } from "../src/ingestion/plan";

const select = (body: unknown) =>
  selectAflSchedule(body, recordedClubIds, { season: 2026 });
const mutable = () =>
  recordedSchedule() as unknown as {
    dates: { date: string; games: Record<string, unknown>[] }[];
  };
const rawRows = (body: ReturnType<typeof mutable>, id: number) =>
  body.dates.flatMap((d) => d.games).filter((g) => g.gamePk === id);

test("recorded 98 schedule entries select 90 club games; two reciprocal weather reschedules and six explicit special-game notices", () => {
  const result = select(recordedSchedule());
  assert.deepEqual(result.issues, []);
  assert.equal(result.games.size, 90);
  assert.equal(
    result.notices.filter((n) => n.reason === "reconciled-reschedule").length,
    2,
  );
  assert.equal(
    result.notices.filter((n) => n.reason === "deferred-participants").length,
    5,
  );
  assert.equal(
    result.notices.filter((n) => n.reason === "excluded-exhibition").length,
    1,
  );
  for (const id of [867710, 867709]) {
    const row = result.games.get(id)!;
    assert.equal(row.game.status.detailedState, "Final");
    const g = normalizedGame(row.game, row.date, 2026);
    assert.equal(g.officialDate, "2026-10-14");
    assert.equal(g.startsAt, "2026-10-14T20:30:00.000Z");
  }
  assert.equal(result.games.get(867709)!.game.venue!.name, "Goodyear Ballpark");
  assert.equal(result.games.get(867710)!.game.teams.home.score, 9);
});
test("schedule order and identical alternate representations do not change the canonical game set", () => {
  const baseline = select(recordedSchedule());
  const data = mutable();
  data.dates.reverse();
  for (const d of data.dates) {
    d.games.reverse();
    d.games.push(...structuredClone(d.games));
  }
  const replay = select(data);
  assert.deepEqual(replay.issues, []);
  const canonical = (r: typeof replay) =>
    [...r.games.values()]
      .map((x) => normalizedGame(x.game, x.date, 2026))
      .sort((a, b) => a.externalId.localeCompare(b.externalId));
  assert.equal(
    fingerprint(canonical(replay)),
    fingerprint(canonical(baseline)),
  );
});
test("missing reschedule evidence, contradictory current copies and changed opponent/context remain quarantined", () => {
  for (const mutation of [
    "link",
    "score",
    "opponent",
    "league",
    "type",
    "season",
    "malformed",
  ]) {
    const data = mutable(),
      rows = rawRows(data, 867709);
    if (mutation === "link") delete rows[1].rescheduledFrom;
    if (mutation === "score") {
      const conflicting = structuredClone(rows[1]);
      (conflicting.teams as { home: { score: number } }).home.score = 99;
      data.dates[0].games.push(conflicting);
    }
    if (mutation === "opponent")
      (rows[0].teams as { home: { team: { id: number } } }).home.team.id = 544;
    if (mutation === "league") rows[0].leagueId = 103;
    if (mutation === "type") rows[0].gameType = "W";
    if (mutation === "season") rows[0].season = "2025";
    if (mutation === "malformed") rows[0].gameDate = "bad";
    const r = select(data);
    assert.ok(
      r.issues.some((i) => i.recordKey === "game:867709"),
      mutation,
    );
    assert.ok(!r.games.has(867709), mutation);
  }
});
test("resolved AFL postseason participants are ingested; placeholders are not invented as clubs", () => {
  const data = mutable(),
    row = rawRows(data, 867638)[0];
  row.teams = { home: { team: { id: 490 } }, away: { team: { id: 542 } } };
  const result = select(data);
  assert.deepEqual(result.issues, []);
  assert.ok(result.games.has(867638));
  assert.equal(
    result.notices.filter((n) => n.reason === "deferred-participants").length,
    4,
  );
  for (const mutation of [
    "final-placeholder",
    "unknown-team",
    "unknown-exhibition",
    "wrong-sport",
  ]) {
    const bad = mutable(),
      g = rawRows(bad, mutation === "unknown-exhibition" ? 867649 : 867638)[0];
    if (mutation === "final-placeholder")
      g.status = { abstractGameState: "Final", detailedState: "Final" };
    if (mutation === "unknown-team")
      g.teams = { home: { team: { id: 999999 } }, away: { team: { id: 542 } } };
    if (mutation === "unknown-exhibition") g.gameType = "R";
    if (mutation === "wrong-sport") g.sportId = 1;
    assert.ok(select(bad).issues.length, mutation);
  }
});
test("positive foreign league/sport context filters outsiders; incomplete or contradictory AFL scope is never hidden", () => {
  const base = mutable(),
    original = rawRows(base, 867638)[0];
  original.teams = {
    home: { team: { id: 999998 } },
    away: { team: { id: 999999 } },
  };
  original.leagueId = 103;
  original.sportId = 1;
  const r = select(base);
  assert.deepEqual(r.issues, []);
  assert.ok(
    r.notices.some(
      (n) => n.recordKey === "game:867638" && n.reason === "outside-scope",
    ),
  );
  for (const change of ["missing-sport", "afl-team", "malformed"]) {
    const data = structuredClone(base),
      g = rawRows(data, 867638)[0];
    if (change === "missing-sport") delete g.sportId;
    if (change === "afl-team")
      (g.teams as { home: { team: { id: number } } }).home.team.id = 490;
    if (change === "malformed") g.gameDate = "bad";
    assert.ok(
      select(data).issues.some((i) => i.recordKey === "game:867638"),
      change,
    );
  }
});
test("recorded schedule runs through adapter with synthetic boxes, resolves all game references, and replays identically", async () => {
  const mock = recordedScheduleFetch();
  const source = new MLBStatsApiSource(
    { season: 2026, mode: "games" },
    {
      fetcher: mock.fetcher,
      sleep: async () => {},
      clock: () => new Date("2026-11-01T12:00:00Z"),
    },
  );
  const snapshot = await source.load(),
    plan = buildPlan(source.normalize(snapshot));
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.records.filter((r) => r.kind === "gameLineSet").length, 65);
  assert.equal(
    plan.records.filter((r) => r.kind === "battingGame").length,
    130,
  );
  assert.equal(
    plan.records.filter((r) => r.kind === "pitchingGame").length,
    130,
  );
  assert.equal(plan.records.filter((r) => r.kind === "team").length, 6);
  for (const id of ["867710", "867709"])
    for (const kind of ["game", "battingGame", "pitchingGame", "gameLineSet"])
      assert.ok(
        plan.records.some(
          (r) =>
            r.kind === kind &&
            ("game" in r
              ? r.game === id
              : "externalId" in r && r.externalId === id),
        ),
        `${kind}:${id}`,
      );
  assert.equal(
    mock.urls.filter((u) => u.includes("/867709/boxscore")).length,
    1,
  );
  assert.equal(
    mock.urls.filter((u) => u.includes("/867710/boxscore")).length,
    1,
  );
  const again = buildPlan(source.normalize(snapshot));
  assert.equal(fingerprint(plan.records), fingerprint(again.records));
  const report = await ingest(source);
  assert.equal(report.status, "dry-run");
  assert.equal(report.issues, 0);
  assert.equal(report.notices!.length, 8);
});
