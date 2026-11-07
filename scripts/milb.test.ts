import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MILB_LEVELS,
  MILB_LEVEL_IDS,
  milbLevelBySportId,
  milbLevelExternalId,
  isMilbLevelId,
} from "../src/domain/levels";
import { parseMilbArgs } from "../src/ingestion/cli-options";
import { validateMilbOptions, type MilbOptions } from "../src/ingestion/sources/milb-config";
import {
  MilbStatsApiSource,
  resolveLevel,
  milbSnapshotKey,
} from "../src/ingestion/sources/milb-stats-api";
import {
  buildMilbFixture,
  milbFixtureFetch,
  FIXTURE_IDS,
  batting,
  type MilbFixture,
} from "../src/ingestion/fixtures/milb-synthetic";
import { buildPlan } from "../src/ingestion/plan";
import { ingest } from "../src/ingestion/runner";
import type { IngestionRecord, NormalizedBatch } from "../src/ingestion/contracts";
import {
  planDateChunks,
  resolveGamesRange,
  runMilbIngestion,
  type MilbRunOptions,
  type MilbSink,
} from "../src/ingestion/milb-runner";
import { projectBoxscore } from "../src/ingestion/sources/mlb-normalize";

const { teams: T, players: P, games: G, leagues: L, orgs: O } = FIXTURE_IDS;
const ALL = [...MILB_LEVEL_IDS];
const clock = () => new Date("2026-06-01T12:00:00Z");

async function capture(
  options: Partial<MilbOptions> = {},
  data: MilbFixture = buildMilbFixture(),
  deps: { knownPlayers?: Set<number>; fetcher?: typeof fetch } = {},
) {
  const mock = milbFixtureFetch(data);
  const source = new MilbStatsApiSource(
    { season: 2026, levels: ALL, ...options },
    { fetcher: deps.fetcher ?? mock.fetcher, sleep: async () => {}, clock, knownPlayers: deps.knownPlayers },
  );
  const snapshot = await source.load();
  const batch = source.normalize(snapshot);
  return { mock, source, snapshot, batch };
}
const find = <K extends IngestionRecord["kind"]>(batch: NormalizedBatch, kind: K, id: string) =>
  batch.records.find(
    (r) => r.kind === kind && ("externalId" in r ? r.externalId === id : r.key === id),
  ) as Extract<IngestionRecord, { kind: K }> | undefined;
const ofKind = <K extends IngestionRecord["kind"]>(batch: NormalizedBatch, kind: K) =>
  batch.records.filter((r) => r.kind === kind) as Extract<IngestionRecord, { kind: K }>[];

describe("level registry and options", () => {
  test("four affiliated levels map to verified-at-runtime sport IDs", () => {
    assert.deepEqual(MILB_LEVEL_IDS, ["aaa", "aa", "high-a", "single-a"]);
    assert.deepEqual(MILB_LEVEL_IDS.map((l) => MILB_LEVELS[l].sportId), [11, 12, 13, 14]);
    assert.equal(milbLevelBySportId(13)?.label, "High-A");
    assert.equal(milbLevelBySportId(1), undefined);
    assert.ok(MILB_LEVELS["single-a"].sportNamePattern.test("Low-A"), "2021 name accepted");
    assert.ok(MILB_LEVELS["high-a"].sportNamePattern.test("Class A Advanced"));
    assert.ok(!MILB_LEVELS.aaa.sportNamePattern.test("Double-A"));
    assert.equal(milbLevelExternalId(11, 117), "milb:11:117");
    assert.ok(isMilbLevelId("aa") && !isMilbLevelId("afl"));
  });

  test("option validation", () => {
    assert.throws(() => validateMilbOptions({ season: 2026, levels: [] }));
    assert.throws(() => validateMilbOptions({ season: 2026, levels: ["aaa", "aaa"] }), /Duplicate/);
    assert.throws(() => validateMilbOptions({ season: 2026, levels: ["aaa"], from: "2025-05-01" }), /season/);
    assert.throws(() => validateMilbOptions({ season: 2026, levels: ["aaa"], from: "2026-06-01", to: "2026-05-01" }));
    assert.throws(() => validateMilbOptions({ season: 2026, levels: ["aaa"], concurrency: 50 }));
    assert.throws(() => validateMilbOptions({ season: 2026, levels: ["aaa"], extra: 1 } as never));
  });

  test("CLI arguments", () => {
    const d = parseMilbArgs(["--season=2026"]);
    assert.equal(d.source, "live");
    assert.equal(d.apply, false);
    assert.deepEqual(d.levels, ALL);
    assert.equal(d.mode, "all");
    assert.equal(d.chunkDays, 7);
    assert.equal(d.concurrency, 4);
    assert.equal(d.rosterType, "fullSeason");
    assert.deepEqual(d.gameTypes, ["R"]);
    const one = parseMilbArgs(["--season", "2026", "--level=aaa,aa", "--team=9301", "--games-only", "--from=2026-05-01", "--to=2026-05-31", "--apply"]);
    assert.deepEqual(one.levels, ["aaa", "aa"]);
    assert.equal(one.team, 9301);
    assert.equal(one.mode, "games");
    assert.equal(one.apply, true);
    assert.equal(parseMilbArgs(["--season=2026", "--incremental"]).rosterType, "active");
    assert.equal(parseMilbArgs(["--season=2026", "--rosters-only"]).mode, "structure");
    for (const bad of [
      ["--level=triple-a"],
      ["--level=aaa,aaa"],
      ["--apply", "--dry-run"],
      ["--games-only", "--rosters-only"],
      ["--source=fixture", "--apply"],
      ["--incremental", "--from=2026-05-01"],
      ["--season=2026", "--from=2025-05-01"],
      ["--chunk-days=0"],
      ["--bogus"],
      ["--season=2026", "--season=2025"],
    ])
      assert.throws(() => parseMilbArgs(bad), String(bad));
  });

  test("snapshot keys distinguish scope", () => {
    const base = { season: 2026, levels: ["aa", "aaa"] as MilbOptions["levels"] };
    assert.equal(milbSnapshotKey(base), "milb:2026:aa+aaa:all:season:end:all-leagues:all-teams");
    assert.notEqual(milbSnapshotKey({ ...base, from: "2026-05-01" }), milbSnapshotKey(base));
    assert.notEqual(milbSnapshotKey({ ...base, team: 9301 }), milbSnapshotKey(base));
  });
});

describe("discovery and hierarchy", () => {
  test("a sport whose name does not match the level is rejected", () => {
    const data = buildMilbFixture();
    assert.throws(
      () =>
        resolveLevel({
          level: "aaa",
          sportId: 11,
          sport: { sports: [{ id: 11, name: "Double-A" }] },
          leagues: { leagues: data.leagues[11] },
          teams: { teams: data.teams[11] },
        }),
      /not Triple-A/,
    );
  });

  test("inactive and wrong-sport teams are excluded", () => {
    const data = buildMilbFixture();
    const ctx = resolveLevel({
      level: "aaa",
      sportId: 11,
      sport: data.sports[11],
      leagues: { leagues: data.leagues[11] },
      teams: { teams: [...data.teams[11], { ...data.teams[12][0] }, { ...data.teams[11][0], id: 9399, active: false }] },
    });
    assert.deepEqual([...ctx.teams.keys()].sort(), [T.aaa1, T.aaa2, T.aaa3]);
    assert.deepEqual([...ctx.leagues.keys()].sort(), [L.aaaEast, L.aaaWest]);
  });

  test("leagues, levels, teams and parent organizations", async () => {
    const { batch } = await capture({ mode: "structure" });
    assert.equal(ofKind(batch, "league").length, 5);
    const level = find(batch, "level", milbLevelExternalId(11, L.aaaWest))!;
    assert.equal(level.name, "Triple-A");
    assert.equal(level.league, String(L.aaaWest));
    assert.equal(find(batch, "level", milbLevelExternalId(14, L.singleA))!.name, "Single-A");
    assert.equal(find(batch, "season", "milb-2026")!.year, 2026);
    const team = find(batch, "team", String(T.aaa1))!;
    assert.equal(team.level, milbLevelExternalId(11, L.aaaEast));
    assert.equal(team.organization, String(O.epc));
    assert.equal(find(batch, "team", String(T.aa2))!.organization, String(O.sbc));
    assert.deepEqual(ofKind(batch, "organization").map((o) => o.externalId).sort(), [String(O.epc), String(O.sbc)]);
    // Missing or non-MLB parents stay unresolved and are reported, never invented.
    assert.equal(find(batch, "team", String(T.highA2))!.organization, null);
    assert.equal(find(batch, "team", String(T.singleA2))!.organization, null);
    assert.deepEqual(
      batch.notices!.filter((n) => n.reason === "unresolved-affiliation").map((n) => n.recordKey).sort(),
      [`team:${T.highA2}`, `team:${T.singleA2}`],
    );
    assert.ok(!find(batch, "organization", String(O.notMlb)));
    assert.equal(batch.issues.length, 0);
  });

  test("a single level only requests that level", async () => {
    const { batch, mock } = await capture({ levels: ["aa"], mode: "structure" });
    assert.equal(mock.count(/sports\/11/), 0);
    assert.equal(mock.count(/sports\/12/), 1);
    assert.deepEqual(ofKind(batch, "team").map((t) => t.externalId).sort(), [String(T.aa1), String(T.aa2)]);
  });

  test("league names fall back to team references when league discovery fails", async () => {
    const mock = milbFixtureFetch();
    const failing: typeof fetch = async (input, init) =>
      new URL(String(input)).pathname.endsWith("/league")
        ? new Response("{}", { status: 400, headers: { "content-type": "application/json" } })
        : mock.fetcher(input, init);
    const { batch } = await capture({ levels: ["aa"], mode: "structure" }, undefined, { fetcher: failing });
    assert.equal(find(batch, "league", String(L.aa))?.name, `League ${L.aa}`);
    assert.equal(batch.issues.length, 0);
    assert.ok(batch.notices!.some((n) => n.recordKey === "level:12" && /League discovery failed/.test(n.message)));
  });

  test("discovery failure aborts the capture instead of guessing scope", async () => {
    const data = buildMilbFixture();
    data.sports[12] = { sports: [{ id: 12, name: "Triple-A" }] };
    await assert.rejects(capture({ levels: ["aa"] }, data), /not Double-A/);
    await assert.rejects(capture({ levels: ["aa"], team: 4242 }), /not a team/);
    await assert.rejects(capture({ levels: ["aa"], league: 4242 }), /not a league/);
  });
});

describe("rosters and players", () => {
  test("roster observations keep each team and its parent at capture time", async () => {
    const { batch } = await capture({ mode: "structure" });
    const riser = ofKind(batch, "rosterObservation").filter((o) => o.player === String(P.riser));
    assert.deepEqual(
      riser.map((o) => [o.team, o.organization, o.rosterStatus, o.season]).sort(),
      [
        [String(T.aaa1), String(O.epc), "Active", "milb-2026"],
        [String(T.aa1), String(O.epc), "Promoted", "milb-2026"],
      ],
    );
    const unaffiliated = ofKind(batch, "rosterObservation").find((o) => o.player === String(P.hi2Bat))!;
    assert.equal(unaffiliated.organization, null);
    const player = find(batch, "player", String(P.riser))!;
    assert.deepEqual(
      { name: player.name, position: player.position, bats: player.bats, throws: player.throws, birthDate: player.birthDate },
      { name: "Fixture Riser", position: "SS", bats: "L", throws: "R", birthDate: "2003-04-05" },
    );
  });

  test("a failed roster request is an issue, not an empty roster", async () => {
    const mock = milbFixtureFetch();
    const failing: typeof fetch = async (input, init) =>
      new URL(String(input)).pathname.endsWith(`/teams/${T.aa1}/roster`)
        ? new Response("{}", { status: 404, headers: { "content-type": "application/json" } })
        : mock.fetcher(input, init);
    const { batch } = await capture({ levels: ["aa"], mode: "structure" }, undefined, { fetcher: failing });
    assert.ok(batch.issues.some((i) => i.recordKey === `roster:${T.aa1}`));
    assert.ok(ofKind(batch, "rosterObservation").every((o) => o.team !== String(T.aa1)));
  });
});

describe("schedule handling", () => {
  test("doubleheaders, reschedules, suspensions, cancellations and exclusions", async () => {
    const { batch, mock } = await capture({ levels: ["aaa"], mode: "games" });
    const game = (id: number) => find(batch, "game", String(id));
    // Doubleheader: two gamePks on one date, both kept with their own start times.
    assert.equal(game(G.dh1)!.officialDate, "2026-05-02");
    assert.equal(game(G.dh2)!.officialDate, "2026-05-02");
    assert.notEqual(game(G.dh1)!.startsAt, game(G.dh2)!.startsAt);
    // Postponed 05-04 → played 05-05: one game, the completed representation, one boxscore.
    assert.deepEqual(
      { date: game(G.rescheduled)!.officialDate, status: game(G.rescheduled)!.status, home: game(G.rescheduled)!.homeScore },
      { date: "2026-05-05", status: "final", home: 5 },
    );
    assert.equal(mock.count(new RegExp(`game/${G.rescheduled}/boxscore`)), 1);
    // Suspended 05-06 → resumed and completed 05-07: one game, official date and start time of
    // the day it began, final result.
    assert.equal(game(G.suspended)!.officialDate, "2026-05-06");
    assert.equal(game(G.suspended)!.startsAt, "2026-05-06T23:05:00.000Z");
    assert.equal(game(G.suspended)!.status, "final");
    assert.equal(mock.count(new RegExp(`game/${G.suspended}/boxscore`)), 1);
    // Cancelled/scheduled games are stored with their status but never fetch boxscores.
    assert.equal(game(G.cancelled)!.status, "cancelled");
    assert.equal(game(G.scheduled)!.status, "scheduled");
    assert.equal(mock.count(new RegExp(`game/(${G.cancelled}|${G.scheduled})/`)), 0);
    // Exhibition excluded with a notice; conflicting representations quarantined, no boxscore.
    assert.equal(game(G.exhibition), undefined);
    assert.ok(batch.notices!.some((n) => n.recordKey === `game:${G.exhibition}` && n.reason === "outside-scope"));
    assert.equal(game(G.conflicting), undefined);
    assert.ok(batch.issues.some((i) => i.recordKey === `game:${G.conflicting}`));
    assert.equal(mock.count(new RegExp(`game/${G.conflicting}/`)), 0);
    // Interleague game is attributed to the home team's league.
    assert.equal(game(G.interleague)!.league, String(L.aaaWest));
    assert.equal(game(G.single)!.season, "milb-2026");
    const reconciled = batch.notices!.filter((n) => n.reason === "reconciled-reschedule").map((n) => n.recordKey).sort();
    assert.deepEqual(reconciled, [`game:${G.rescheduled}`, `game:${G.suspended}`]);
  });

  test("postseason types are opt-in", async () => {
    const data = buildMilbFixture();
    data.schedule[12].push(["2026-09-20", { ...(data.schedule[12][0][1] as object), gamePk: 9690, gameType: "F", officialDate: "2026-09-20", gameDate: "2026-09-20T23:05:00Z" }]);
    const regular = await capture({ levels: ["aa"], mode: "games" }, data);
    assert.equal(find(regular.batch, "game", "9690"), undefined);
    const post = await capture({ levels: ["aa"], mode: "games", gameTypes: ["R", "F"] }, buildMilbFixtureWith(data));
    assert.equal(find(post.batch, "game", "9690")?.status, "final");
  });

  test("a chunk that sees only the postponed row defers to the later reschedule", async () => {
    const { batch } = await capture({ levels: ["aaa"], mode: "games", from: "2026-05-04", to: "2026-05-04" });
    assert.equal(find(batch, "game", String(G.rescheduled)), undefined);
    assert.ok(batch.notices!.some((n) => n.recordKey === `game:${G.rescheduled}` && /superseded/.test(n.message)));
    const next = await capture({ levels: ["aaa"], mode: "games", from: "2026-05-05", to: "2026-05-05" });
    assert.equal(find(next.batch, "game", String(G.rescheduled))?.status, "final");
  });

  test("unknown participants and malformed rows are quarantined", async () => {
    const data = buildMilbFixture();
    data.schedule[12].push(["2026-05-13", { ...(data.schedule[12][0][1] as object), gamePk: 9691, officialDate: "2026-05-13", gameDate: "2026-05-13T23:05:00Z", teams: { home: { team: { id: T.aa1 } }, away: { team: { id: 7777 } } } }]);
    data.schedule[12].push(["2026-05-14", { gamePk: 9692, gameDate: "not a date", teams: { home: { team: { id: T.aa1 } }, away: { team: { id: T.aa2 } } } }]);
    const { batch } = await capture({ levels: ["aa"], mode: "games" }, data);
    assert.ok(batch.issues.some((i) => i.recordKey === "game:9691" && /Unrecognized participants/.test(i.message)));
    assert.ok(batch.issues.some((i) => i.recordKey === "game:9692"));
    assert.equal(find(batch, "game", "9691"), undefined);
  });

  test("date, team and league scopes", async () => {
    const dated = await capture({ levels: ["aaa"], mode: "games", from: "2026-05-01", to: "2026-05-02" });
    assert.deepEqual(ofKind(dated.batch, "game").map((g) => Number(g.externalId)).sort(), [G.single, G.dh1, G.dh2]);
    const team = await capture({ levels: ["aaa"], mode: "games", team: T.aaa3 });
    assert.deepEqual(ofKind(team.batch, "game").map((g) => Number(g.externalId)).sort(), [G.interleague, G.cancelled, G.scheduled]);
    const league = await capture({ levels: ["aaa"], league: L.aaaWest });
    assert.ok(ofKind(league.batch, "game").every((g) => [g.homeTeam, g.awayTeam].includes(String(T.aaa3))));
    // Teams are still discovered level-wide so opponents resolve; rosters follow the scope.
    assert.equal(ofKind(league.batch, "team").length, 3);
    assert.deepEqual([...new Set(ofKind(league.batch, "rosterObservation").map((o) => o.team))], [String(T.aaa3)]);
  });
});

function buildMilbFixtureWith(data: MilbFixture) {
  return structuredClone(data);
}

describe("boxscores and game lines", () => {
  test("batting and pitching lines from completed boxscores", async () => {
    const { batch } = await capture({ levels: ["aa"], mode: "games" });
    const bat = find(batch, "battingGame", `${G.aaEarly}:${P.riser}`)!;
    assert.equal(bat.team, String(T.aa1));
    assert.deepEqual(
      { pa: bat.stats.plateAppearances, ab: bat.stats.atBats, h: bat.stats.hits, d: bat.stats.doubles, hr: bat.stats.homeRuns, bb: bat.stats.walks },
      { pa: 5, ab: 4, h: 3, d: 1, hr: 1, bb: 1 },
    );
    const arm = find(batch, "pitchingGame", `${G.aaLate}:${P.aa2Arm}`)!;
    assert.equal(arm.stats.outsRecorded, 20, "6.2 IP = 20 outs");
    assert.equal(arm.stats.battersFaced, 26);
    const set = find(batch, "gameLineSet", String(G.aaEarly))!;
    assert.equal(set.battingPlayers.length, 3);
    assert.equal(set.pitchingPlayers.length, 2);
    assert.equal(ofKind(batch, "gameLineSet").length, 2);
  });

  test("captures keep only a projection of each boxscore", async () => {
    const { snapshot } = await capture({ levels: ["aa"], mode: "games" });
    const boxes = (snapshot.payload as { boxes: { body: unknown }[] }).boxes;
    const text = JSON.stringify(boxes);
    assert.ok(!text.includes("seasonStats") && !text.includes("officials") && !text.includes("fielding"));
    assert.ok(boxes.length === 2);
    assert.ok(snapshot.rawContentHash && /^[0-9a-f]{64}$/.test(snapshot.rawContentHash));
    const docs = (snapshot.storedPayload as { documents: { contentHash: string; body?: unknown }[] }).documents;
    assert.ok(docs.length > 0 && docs.every((d) => d.body === undefined && d.contentHash.length === 64));
    assert.deepEqual(projectBoxscore("not a box"), "not a box");
  });

  test("a malformed boxscore holds all of its lines; the game itself is kept", async () => {
    const data = buildMilbFixture();
    const box = data.boxes[G.aaEarly] as { teams: { home: { players: Record<string, { stats: { batting: Record<string, unknown> } }> } } };
    box.teams.home.players[`ID${P.aaBat}`].stats.batting = { ...batting(4, 4, 1), atBats: "four" };
    const { batch } = await capture({ levels: ["aa"], mode: "games" }, data);
    assert.equal(find(batch, "game", String(G.aaEarly))?.status, "final");
    assert.ok(!batch.records.some((r) => "game" in r && r.game === String(G.aaEarly)));
    assert.ok(batch.issues.some((i) => i.recordKey.includes(String(G.aaEarly))));
    assert.ok(find(batch, "gameLineSet", String(G.aaLate)), "other games unaffected");
  });

  test("boxscore teams must match the schedule", async () => {
    const data = buildMilbFixture();
    const box = data.boxes[G.aaLate] as { teams: { home: { team: { id: number } } } };
    box.teams.home.team.id = T.aa1;
    const { batch } = await capture({ levels: ["aa"], mode: "games" }, data);
    assert.ok(batch.issues.some((i) => i.recordKey === `boxscore:${G.aaLate}` && /disagree/.test(i.message)));
  });

  test("box-only players are enriched; a game position is never a primary position", async () => {
    const { batch, mock } = await capture({ levels: ["aaa"], mode: "games", from: "2026-05-01", to: "2026-05-01" });
    const callup = find(batch, "player", String(P.callup))!;
    assert.equal(callup.position, "OF", "people endpoint primary position, not the boxscore's PH");
    assert.equal(mock.count(/\/people$/), 1);
    // Already-stored players are not looked up again.
    const known = new Set(Object.values(P));
    const again = await capture({ levels: ["aaa"], mode: "games", from: "2026-05-01", to: "2026-05-01" }, undefined, { knownPlayers: known });
    assert.equal(again.mock.count(/\/people$/), 0);
    assert.equal(find(again.batch, "player", String(P.callup)), undefined);
    assert.ok(find(again.batch, "battingGame", `${G.single}:${P.callup}`), "lines still emitted");
  });

  test("an unknown box-only player without a primary position quarantines that boxscore's lines", async () => {
    const data = buildMilbFixture();
    delete data.people[P.callup];
    const { batch } = await capture({ levels: ["aaa"], mode: "games", from: "2026-05-01", to: "2026-05-01" }, data);
    assert.equal(find(batch, "player", String(P.callup)), undefined);
    const plan = buildPlan(batch);
    assert.ok(plan.issues.some((i) => i.recordKey === `battingGame:${G.single}:${P.callup}` && i.code === "missing-reference"));
    assert.ok(!plan.records.some((r) => r.kind === "gameLineSet" && r.game === String(G.single)), "partial boxscore never completes");
  });
});

describe("incremental capture", () => {
  test("stored complete games are not re-fetched outside the refetch window", async () => {
    const { batch, mock } = await capture({
      levels: ["aa"],
      mode: "games",
      knownComplete: [G.aaEarly, G.aaLate],
      refetchWindowDays: 3,
    });
    assert.equal(mock.count(/\/boxscore$/), 0);
    assert.equal(find(batch, "game", String(G.aaEarly))?.status, "final", "game row still refreshed from the schedule");
    assert.equal(ofKind(batch, "battingGame").length, 0);
    assert.ok(batch.notices!.some((n) => n.reason === "reused-boxscores" && n.message.startsWith("2 ")));
    // Within the window (capture 2026-06-01, window 30 days) they are re-fetched for corrections.
    const recent = await capture({ levels: ["aa"], mode: "games", knownComplete: [G.aaEarly, G.aaLate], refetchWindowDays: 30 });
    assert.equal(recent.mock.count(/\/boxscore$/), 1, "only 05-12 is within 30 days of 06-01");
  });

  test("date chunks", () => {
    assert.deepEqual(planDateChunks("2026-05-01", "2026-05-15", 7), [
      { from: "2026-05-01", to: "2026-05-07" },
      { from: "2026-05-08", to: "2026-05-14" },
      { from: "2026-05-15", to: "2026-05-15" },
    ]);
    assert.deepEqual(planDateChunks("2026-05-02", "2026-05-01", 7), []);
    assert.equal(planDateChunks("2026-03-01", "2026-10-31", 7).length, 35);
  });

  const runOptions = (o: Partial<MilbRunOptions> = {}): MilbRunOptions => ({
    season: 2026,
    levels: ["aa"],
    mode: "games",
    apply: false,
    incremental: false,
    refetchComplete: false,
    chunkDays: 7,
    concurrency: 2,
    lookbackDays: 3,
    refetchWindowDays: 3,
    rosterType: "fullSeason",
    gameTypes: ["R"],
    ...o,
  });
  const stubSink = (latest: string | null, complete: string[] = []): MilbSink => ({
    completedGameIds: async () => new Set(complete),
    knownExternalIds: async () => new Set(),
    latestCompleteGameDate: async () => latest,
    apply: async () => {
      throw new Error("not used");
    },
    preview: async (snapshot, batch) => ({
      provider: snapshot.provider,
      snapshotKey: snapshot.key,
      contentHash: "x",
      rawContentHash: "y",
      status: "dry-run",
      records: batch.records.length,
      issues: batch.issues.length,
      notices: batch.notices,
    }),
  });

  test("incremental range starts a lookback before the latest stored complete game", async () => {
    assert.deepEqual(
      await resolveGamesRange(runOptions({ incremental: true }), { sink: stubSink("2026-05-10"), clock }),
      { from: "2026-05-07", to: "2026-06-01" },
    );
    assert.deepEqual(
      await resolveGamesRange(runOptions({ incremental: true }), { sink: stubSink(null), clock }),
      { from: "2026-03-01", to: "2026-06-01" },
    );
    await assert.rejects(resolveGamesRange(runOptions({ incremental: true }), { clock }), /needs a database/);
    assert.deepEqual(await resolveGamesRange(runOptions(), { clock: () => new Date("2027-01-10T00:00:00Z") }), {
      from: "2026-03-01",
      to: "2026-10-31",
    });
  });

  test("an incremental run reuses stored complete games", async () => {
    const mock = milbFixtureFetch();
    const summary = await runMilbIngestion(runOptions({ incremental: true }), {
      sink: stubSink("2026-05-12", [String(G.aaEarly), String(G.aaLate)]),
      fetcher: mock.fetcher,
      sleep: async () => {},
      clock,
    });
    assert.equal(summary.status, "ok");
    assert.deepEqual(summary.range, { from: "2026-05-09", to: "2026-06-01" });
    assert.equal(mock.count(/\/boxscore$/), 0);
    assert.equal(summary.chunks.reduce((n, c) => n + (c.reusedBoxscores ?? 0), 0), 1);
  });

  test("offline backfill runs structure then chunks; a failing chunk reports where to resume", async () => {
    const mock = milbFixtureFetch();
    let scheduleCalls = 0;
    const flaky: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      // Discovery for the third games chunk fails → that capture aborts.
      if (url.pathname.endsWith("/sports/12") && ++scheduleCalls === 4)
        return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      return mock.fetcher(input, init);
    };
    const summary = await runMilbIngestion(
      runOptions({ mode: "all", from: "2026-04-15", to: "2026-05-20" }),
      { fetcher: flaky, sleep: async () => {}, clock },
    );
    assert.equal(summary.status, "failed");
    assert.equal(summary.chunks[0].phase, "structure");
    assert.equal(summary.chunks[0].status, "dry-run");
    assert.equal(summary.chunks.at(-1)!.status, "failed");
    assert.equal(summary.resumeFrom, "2026-04-29");
  });
});

describe("capture identity and request volume", () => {
  test("contentHash is stable across identical captures; rawContentHash follows response content", async () => {
    const a = await ingest(new MilbStatsApiSource({ season: 2026, levels: ["aa"] }, { fetcher: milbFixtureFetch().fetcher, sleep: async () => {}, clock }));
    const b = await ingest(new MilbStatsApiSource({ season: 2026, levels: ["aa"] }, { fetcher: milbFixtureFetch().fetcher, sleep: async () => {}, clock: () => new Date("2026-06-02T12:00:00Z") }));
    assert.equal(a.contentHash, b.contentHash);
    assert.equal(a.rawContentHash, b.rawContentHash);
    const changed = buildMilbFixture();
    (changed.boxes[G.aaLate] as { copyright: string }).copyright = "changed";
    const c = await ingest(new MilbStatsApiSource({ season: 2026, levels: ["aa"] }, { fetcher: milbFixtureFetch(changed).fetcher, sleep: async () => {}, clock }));
    assert.notEqual(c.rawContentHash, a.rawContentHash, "raw body changed");
    assert.equal(c.contentHash, a.contentHash, "normalized data did not");
  });

  test("bounded request concurrency", async () => {
    const four = await capture({ concurrency: 4 });
    assert.ok(four.mock.maxActive <= 4 && four.mock.maxActive > 1, String(four.mock.maxActive));
    const one = await capture({ concurrency: 1 });
    assert.equal(one.mock.maxActive, 1);
    // URL caching: every endpoint is requested once per capture.
    assert.equal(new Set(one.mock.urls).size, one.mock.urls.length);
  });

  test("a failed boxscore request is an issue; other games still apply", async () => {
    const mock = milbFixtureFetch();
    const failing: typeof fetch = async (input, init) =>
      new URL(String(input)).pathname.endsWith(`/game/${G.aaLate}/boxscore`)
        ? new Response("{}", { status: 503, headers: { "content-type": "application/json" } })
        : mock.fetcher(input, init);
    const { batch } = await capture({ levels: ["aa"], mode: "games" }, undefined, { fetcher: failing });
    assert.ok(batch.issues.some((i) => i.recordKey === `boxscore:${G.aaLate}`));
    assert.ok(find(batch, "gameLineSet", String(G.aaEarly)));
    assert.equal(find(batch, "game", String(G.aaLate))?.status, "final");
  });
});

test("box score: an unlisted all-zero entry under the other club is skipped with a notice; real conflicts still quarantine", async () => {
  const { MlbNormalizer, normalizeBoxscore: normalizeRaw, projectBoxscore } = await import("../src/ingestion/sources/mlb-normalize");
  // Through the same projection the MiLB adapter applies to every fetched box score.
  const normalizeBoxscore = (n: InstanceType<typeof MlbNormalizer>, pk: number, body: unknown, s: { home: number; away: number }) =>
    normalizeRaw(n, pk, projectBoxscore(JSON.parse(JSON.stringify(body))), s);
  const person = (id: number) => ({ id, fullName: `P ${id}`, primaryPosition: { abbreviation: "P" } });
  const line = (bf: number, ip: string, extra: Record<string, number> = {}) => ({
    gamesPlayed: bf ? 1 : 0, gamesPitched: bf ? 1 : 0, battersFaced: bf, outs: Number(ip.split(".")[0]) * 3 + Number(ip.split(".")[1]),
    inningsPitched: ip, numberOfPitches: bf * 4, hits: bf ? 1 : 0, earnedRuns: 0, runs: 0, baseOnBalls: 0, strikeOuts: 0, homeRuns: 0, ...extra,
  });
  const box = (homeExtra: Record<string, unknown>) => ({
    teams: {
      away: { team: { id: 2 }, batters: [], pitchers: [20], players: { ID20: { person: person(20), stats: { batting: {}, pitching: line(7, "1.0") } } } },
      home: {
        team: { id: 1 }, batters: [], pitchers: [10],
        players: { ID10: { person: person(10), stats: { batting: {}, pitching: line(30, "9.0") } }, ID20: { person: person(20), stats: { batting: {}, pitching: homeExtra } } },
      },
    },
  });
  // Shape of gamePk 817667: zero line, not in the home pitchers list (inherited runners are not participation).
  const ok = new MlbNormalizer();
  normalizeBoxscore(ok, 817667, box(line(0, "0.0", { inheritedRunners: 2 })), { home: 1, away: 2 });
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.notices.map((x) => [x.reason, x.recordKey]), [["unlisted-empty-line", "pitchingGame:817667:20"]]);
  const pitching = [...ok.records.values()].filter((r) => r.kind === "pitchingGame");
  assert.deepEqual(pitching.map((r) => ("team" in r ? `${r.player}@${r.team}` : "")).sort(), ["10@1", "20@2"]);
  const set = [...ok.records.values()].find((r) => r.kind === "gameLineSet");
  assert.ok(set && "pitchingPlayers" in set && set.pitchingPlayers.join() === "10,20");
  // An unlisted entry WITH participation is not skipped: the duplicate still quarantines.
  const bad = new MlbNormalizer();
  normalizeBoxscore(bad, 817667, box(line(3, "1.0")), { home: 1, away: 2 });
  assert.deepEqual(bad.notices, []);
  assert.ok(bad.issues.some((i) => i.recordKey === "pitchingGame:817667:20" && /Conflicting/.test(i.message)));
  // Without the lists (older payload shape) nothing is skipped either.
  const noLists = box(line(0, "0.0"));
  for (const side of [noLists.teams.home, noLists.teams.away] as Record<string, unknown>[]) delete side.pitchers;
  const legacy = new MlbNormalizer();
  normalizeBoxscore(legacy, 817667, noLists, { home: 1, away: 2 });
  assert.deepEqual(legacy.notices, []);
  assert.ok(legacy.issues.some((i) => /Conflicting/.test(i.message)));
});
