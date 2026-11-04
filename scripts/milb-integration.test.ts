/**
 * MiLB + AFL site integration: level loading and selection, coverage states, one identity per
 * player across levels, Momentum computed within each level, and homepage data scenarios.
 * Clearly fictional deterministic snapshots only (scripts/milb-scale-support.ts).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MOMENTUM_SETTINGS, MOMENTUM_WINDOW_IDS } from "../src/analytics/config";
import { momentum } from "../src/analytics/engine";
import { analyticsContextFor } from "../src/analytics/views";
import {
  aflAsOf,
  buildPlayerRows,
  currentStint,
  scoreboard,
} from "../src/services/afl/read-model";
import type { AflSnapshot } from "../src/services/afl/types";
import { loadCompetition } from "../src/services/competition/load";
import {
  defaultLevel,
  levelCoverage,
  playerLevels,
  profileLevel,
  selectLevel,
} from "../src/services/competition/model";
import type { LevelSnapshot } from "../src/services/competition/types";
import { coverageSummary, latestTopLines, trendingSets } from "../src/services/home";
import { aflDirectoryRows, directoryRows, levelDirectoryRows } from "../src/services/players/adapter";
import { directoryOptions, filterDirectory } from "../src/services/players/directory";
import { LEVELS, LEVEL_IDS, type LevelId } from "../src/services/players/levels";
import { MILB_LEVELS } from "../src/domain/levels";
import { playerId, scaleSnapshot } from "./milb-scale-support";

const SHARED = playerId(99, 1);
const SHARED_ARM = playerId(99, 2);
const small = { teams: 6, days: 60 } as const;
/** Double-A through day 40, then promoted to Triple-A from day 45 (hitter and pitcher). */
const aa = scaleSnapshot({
  ns: 2,
  level: "aa",
  ...small,
  seed: 2,
  sharedPlayers: [
    { id: SHARED, name: "Shared Prospect", role: "hitter", toDay: 40 },
    { id: SHARED_ARM, name: "Shared Arm", role: "pitcher", toDay: 40 },
  ],
});
const aaa = scaleSnapshot({
  ns: 1,
  level: "aaa",
  ...small,
  seed: 1,
  sharedPlayers: [
    { id: SHARED, name: "Shared Prospect", role: "hitter", fromDay: 45 },
    { id: SHARED_ARM, name: "Shared Arm", role: "pitcher", fromDay: 45 },
  ],
});
const highA = scaleSnapshot({ ns: 3, level: "high-a", ...small, days: 50, seed: 3 });
const singleA = scaleSnapshot({ ns: 4, level: "single-a", ...small, days: 55, seed: 4 });
const afl: AflSnapshot = {
  ...scaleSnapshot({ ns: 5, teams: 6, days: 30, start: "2026-10-06", seed: 5 }),
  scope: { kind: "afl", leagueIds: ["00000000-0000-4000-9005-000000000002"] },
  season: { id: "00000000-0000-4000-9005-000000000003", year: 2026, name: "2026 Arizona Fall League" },
};
const structureOnly: AflSnapshot = { ...scaleSnapshot({ ns: 6, level: "single-a", teams: 4, days: 1 }), games: [], batting: [], pitching: [] };

const ls = (level: LevelId, snapshot: AflSnapshot): LevelSnapshot => ({ level, snapshot });
const ALL = [ls("aaa", aaa), ls("aa", aa), ls("high-a", highA), ls("single-a", singleA), ls("afl", afl)];
const MILB = ALL.filter((l) => l.level !== "afl");

describe("level registry", () => {
  test("derives from the domain levels: ladder order, labels, AFL last", () => {
    assert.deepEqual(LEVEL_IDS, ["aaa", "aa", "high-a", "single-a", "afl"]);
    for (const l of LEVELS.filter((x) => x.kind === "affiliated"))
      assert.equal(l.label, MILB_LEVELS[l.id as keyof typeof MILB_LEVELS].label);
  });
});

describe("loadCompetition", () => {
  const loader =
    (map: Partial<Record<LevelId, AflSnapshot | Error | null>>) => async (level: LevelId) => {
      const v = map[level] ?? null;
      if (v instanceof Error) throw v;
      return v;
    };
  test("empty database → empty, with every level not ingested", async () => {
    const r = await loadCompetition(loader({}));
    assert.equal(r.status, "empty");
    if (r.status === "empty")
      assert.ok(levelCoverage([], r.levelStatus).every((c) => c.status === "not-ingested"));
  });
  test("every read failing → unavailable; errors reported per level without details", async () => {
    const failed: LevelId[] = [];
    const err = new Error("boom");
    const r = await loadCompetition(
      loader({ aaa: err, aa: err, "high-a": err, "single-a": err, afl: err }),
      (l) => failed.push(l),
    );
    assert.equal(r.status, "unavailable");
    assert.deepEqual(failed, LEVEL_IDS);
  });
  test("partial failure keeps the levels that loaded and marks the failed one", async () => {
    const r = await loadCompetition(loader({ aaa, aa: new Error("x"), afl }));
    assert.equal(r.status, "ok");
    if (r.status !== "ok") return;
    assert.deepEqual(r.levels.map((l) => l.level), ["aaa", "afl"]);
    assert.equal(r.levelStatus.aa, "unavailable");
    assert.equal(r.levelStatus["high-a"], "empty");
    const cov = levelCoverage(r.levels, r.levelStatus);
    assert.deepEqual(
      cov.map((c) => c.status),
      ["live", "unavailable", "not-ingested", "not-ingested", "live"],
    );
  });
  test("levels are returned in ladder order regardless of load order", async () => {
    const r = await loadCompetition(loader({ afl, "single-a": singleA, aaa }));
    assert.equal(r.status, "ok");
    if (r.status === "ok") assert.deepEqual(r.levels.map((l) => l.level), ["aaa", "single-a", "afl"]);
  });
});

describe("default level and level selection (homepage scenarios)", () => {
  test("only AFL ingested", () => {
    assert.equal(defaultLevel([ls("afl", afl)]), "afl");
    assert.equal(selectLevel([ls("afl", afl)], "aaa")!.level, "afl", "unavailable level falls back");
  });
  test("only one MiLB level ingested", () => {
    assert.equal(defaultLevel([ls("high-a", highA)]), "high-a");
  });
  test("all four MiLB levels: the level with the latest completed game", () => {
    // AAA and AA play through day 59; ladder order breaks the tie.
    assert.equal(aflAsOf(aaa), aflAsOf(aa));
    assert.equal(defaultLevel(MILB), "aaa");
    assert.equal(defaultLevel([ls("high-a", highA), ls("single-a", singleA)]), "single-a");
  });
  test("AFL (fall) is the default once its games are the most recent", () => {
    assert.equal(defaultLevel(ALL), "afl");
    assert.equal(selectLevel(ALL, "aa")!.level, "aa");
    assert.equal(selectLevel(ALL, "bogus")!.level, "afl");
  });
  test("a structure-only level (no games) never wins over a level with games", () => {
    assert.equal(defaultLevel([ls("single-a", structureOnly), ls("high-a", highA)]), "high-a");
    assert.equal(defaultLevel([ls("single-a", structureOnly)]), "single-a");
    const cov = levelCoverage([ls("single-a", structureOnly)], { "single-a": "ok" });
    assert.equal(cov.find((c) => c.level.id === "single-a")!.status, "no-games");
  });
  test("homepage view models build for every level and for a level without games", () => {
    for (const { snapshot } of [...ALL, ls("single-a", structureOnly)]) {
      const t = trendingSets(snapshot);
      assert.doesNotThrow(() => JSON.stringify(t));
      latestTopLines(snapshot);
      coverageSummary(snapshot);
    }
    const empty = latestTopLines(structureOnly);
    assert.equal(empty.date, null);
    assert.equal(trendingSets(structureOnly).asOf, null);
  });
  test("coverage is per level and never summed", () => {
    const cov = levelCoverage(ALL, Object.fromEntries(LEVEL_IDS.map((l) => [l, "ok"])));
    for (const c of cov) {
      const snap = ALL.find((l) => l.level === c.level.id)!.snapshot;
      assert.equal(c.coverage!.gamesFinal, snap.games.length);
      assert.equal(c.coverage!.asOf, aflAsOf(snap));
    }
  });
});

describe("players directory across levels", () => {
  const hitters = directoryRows(ALL, { window: "season", role: "hitter" });
  const pitchers = directoryRows(ALL, { window: "season", role: "pitcher" });

  test("all levels: one row per player identity", () => {
    for (const rows of [hitters, pitchers])
      assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  });
  test("a promoted player appears once, at the level of the latest game, with both levels listed", () => {
    const row = hitters.find((r) => r.id === SHARED)!;
    assert.equal(row.level, "aaa");
    assert.deepEqual(row.levels, ["aaa", "aa"]);
    const aaaOnly = buildPlayerRows(aaa, "season").find((r) => r.id === SHARED)!;
    const aaOnly = buildPlayerRows(aa, "season").find((r) => r.id === SHARED)!;
    assert.deepEqual(row.batting, aaaOnly.batting, "AAA statistics only — never summed with AA");
    assert.notEqual(row.batting!.plateAppearances, aaaOnly.batting!.plateAppearances + aaOnly.batting!.plateAppearances);
    const arm = pitchers.find((r) => r.id === SHARED_ARM)!;
    assert.equal(arm.level, "aaa");
    assert.deepEqual(arm.levels, ["aaa", "aa"]);
  });
  test("a level scope returns that level's own line for the same player", () => {
    const rows = directoryRows(ALL, { level: "aa", window: "season", role: "hitter" });
    assert.ok(rows.every((r) => r.level === "aa"));
    const row = rows.find((r) => r.id === SHARED)!;
    assert.deepEqual(row.batting, buildPlayerRows(aa, "season").find((r) => r.id === SHARED)!.batting);
    assert.deepEqual(row.levels, ["aa"]);
  });
  test("windowed views: a player who left a level drops out of that level's recent window", () => {
    const aa7 = directoryRows(ALL, { level: "aa", window: "7d", role: "hitter" });
    assert.equal(aa7.find((r) => r.id === SHARED), undefined);
    const all7 = directoryRows(ALL, { window: "7d", role: "hitter" });
    const row = all7.find((r) => r.id === SHARED)!;
    assert.equal(row.level, "aaa");
    assert.deepEqual(row.levels, ["aaa"], "only levels with lines in the window");
  });
  test("rows carry only the selected role's statistics and Momentum", () => {
    assert.ok(hitters.every((r) => r.pitching === null && r.batting !== null && !r.momentum.pitcher));
    assert.ok(pitchers.every((r) => r.batting === null && r.pitching !== null && !r.momentum.hitter));
  });
  test("each row is labeled with its level's stats-through date", () => {
    for (const r of hitters) {
      const snap = ALL.find((l) => l.level === r.level)!.snapshot;
      assert.equal(r.asOf, aflAsOf(snap));
    }
  });
  test("organization filter spans levels; team filter stays within one level", () => {
    const options = directoryOptions(hitters);
    const org = options.organizations[0];
    const byOrg = filterDirectory(hitters, { organizationId: org.id });
    assert.ok(new Set(byOrg.map((r) => r.level)).size > 1, "parent orgs are shared across levels");
    const team = options.teams[0];
    const byTeam = filterDirectory(hitters, { teamId: team.id });
    assert.equal(new Set(byTeam.map((r) => r.level)).size, 1);
    assert.equal(filterDirectory(hitters, { query: "shared prospect" }).length, 1);
  });
  test("AFL rows are unchanged by the generic adapter", () => {
    assert.deepEqual(aflDirectoryRows(afl, "14d"), levelDirectoryRows(afl, "afl", "14d"));
    const aflOnly = directoryRows([ls("afl", afl)], { window: "season", role: "hitter" });
    assert.ok(aflOnly.every((r) => r.level === "afl"));
  });
});

describe("Momentum per level", () => {
  test("directory Momentum equals the V1 engine run on the row's own level", () => {
    const rows = directoryRows(ALL, { window: "14d", role: "hitter" });
    for (const r of rows.slice(0, 60)) {
      const snap = ALL.find((l) => l.level === r.level)!.snapshot;
      const m = momentum(analyticsContextFor(snap), r.id, "hitter", "14d", "balanced");
      assert.equal(r.momentum.hitter!.score, m.score, r.name);
    }
  });
  test("populations are level-scoped: no other level's players in a level's comparison set", () => {
    for (const { snapshot } of ALL) {
      const ctx = analyticsContextFor(snapshot);
      const ids = new Set(snapshot.players.map((p) => p.id));
      for (const role of ["hitter", "pitcher"] as const)
        assert.ok(ctx.percentilePopulations[role].qualified.every((id) => ids.has(id)));
    }
  });
  test("7/14/30-day windows, thresholds and confidence hold at every level, hitters and pitchers", () => {
    const s = MOMENTUM_SETTINGS.sample;
    for (const { snapshot } of ALL) {
      const ctx = analyticsContextFor(snapshot);
      for (const role of ["hitter", "pitcher"] as const) {
        const ids = [...(role === "hitter" ? ctx.ds.batting : ctx.ds.pitching).keys()].slice(0, 40);
        let ok = 0;
        for (const id of ids)
          for (const w of MOMENTUM_WINDOW_IDS) {
            const m = momentum(ctx, id, role, w, "balanced");
            if (m.status === "ok") {
              ok++;
              assert.ok(m.sample.recent >= s.minRecent[role]);
              assert.ok(m.sample.baseline >= s.minBaseline[role]);
              assert.ok(["low", "medium", "high"].includes(m.confidence));
              assert.ok(m.score !== null && Math.abs(m.score) <= 100);
              // Recent window and baseline come from this level's season only.
              assert.ok(m.ranges!.recent.to === ctx.ds.asOf);
              assert.ok(m.ranges!.baseline!.from.startsWith(String(snapshot.season.year)));
            } else assert.equal(m.score, null);
          }
        assert.ok(ok > 0, `some ${role} windows compute at ${snapshot.season.name}`);
      }
    }
  });
  test("a promoted player is measured only against earlier games at the new level", () => {
    const ctxAaa = analyticsContextFor(aaa);
    const ctxAa = analyticsContextFor(aa);
    const atAaa = momentum(ctxAaa, SHARED, "hitter", "7d", "balanced");
    const aaaPa = buildPlayerRows(aaa, "season").find((r) => r.id === SHARED)!.batting!.plateAppearances;
    assert.ok(atAaa.sample.recent + atAaa.sample.baseline <= aaaPa);
    // Long gone from Double-A: no recent games there, so no Momentum at that level.
    const atAa = momentum(ctxAa, SHARED, "hitter", "7d", "balanced");
    assert.equal(atAa.status, "no-recent");
    assert.equal(atAa.score, null);
  });
  test("no games at a level → explicit unavailable state, never a fabricated score", () => {
    const ctx = analyticsContextFor(structureOnly);
    const m = momentum(ctx, structureOnly.players[0].id, "hitter", "14d", "balanced");
    assert.equal(m.status, "no-games");
    assert.equal(m.score, null);
    assert.match(m.explanation, /at this level/);
  });
});

describe("player profile resolution", () => {
  test("presence lists each level separately, most recent first", () => {
    const p = playerLevels(ALL, SHARED);
    assert.deepEqual(p.map((x) => x.level), ["aaa", "aa"]);
    assert.ok(p[0].firstGame! > p[1].lastGame!, "AAA games follow the AA stint");
    for (const x of p) {
      const snap = ALL.find((l) => l.level === x.level)!.snapshot;
      assert.deepEqual(x.batting, buildPlayerRows(snap, "season").find((r) => r.id === SHARED)!.batting);
    }
  });
  test("default level is the most recent; a requested level is honored only when present", () => {
    const p = playerLevels(ALL, SHARED);
    assert.equal(profileLevel(p, undefined), "aaa");
    assert.equal(profileLevel(p, "aa"), "aa");
    assert.equal(profileLevel(p, "afl"), "aaa");
    assert.equal(profileLevel(playerLevels(ALL, "00000000-0000-4000-9999-999999999999"), undefined), null);
  });
  test("a roster-only player (no games) still resolves, with no statistics", () => {
    const id = structureOnly.players[0].id;
    const p = playerLevels([ls("single-a", structureOnly)], id);
    assert.equal(p.length, 1);
    assert.equal(p[0].games, 0);
    assert.equal(p[0].batting, null);
    assert.equal(p[0].firstGame, null);
  });
});

describe("read model at MiLB scale", () => {
  test("indexed player context matches the per-player rule (roster stint, else last game team)", () => {
    // Remove some roster stints so the game-line fallback is exercised.
    const s: AflSnapshot = { ...aaa, rosterStints: aaa.rosterStints.filter((_, i) => i % 3) };
    const teams = new Map(s.teams.map((t) => [t.id, t]));
    const dates = new Map(s.games.map((g) => [g.id, g.date]));
    for (const row of buildPlayerRows(s, "season")) {
      const stint = currentStint(s, row.id);
      let expected: string | null = stint?.teamId ?? null;
      if (!stint) {
        let best: { date: string; teamId: string } | null = null;
        for (const l of [...s.batting, ...s.pitching])
          if (l.playerId === row.id) {
            const d = dates.get(l.gameId) ?? "";
            if (!best || d > best.date) best = { date: d, teamId: l.teamId };
          }
        expected = best?.teamId ?? null;
      }
      assert.equal(row.team?.id ?? null, expected ? teams.get(expected)!.id : null);
      assert.equal(row.teamSource, stint ? "roster" : expected ? "game-lines" : null);
    }
  });
  test("scheduled MiLB games show Eastern time; AFL keeps Arizona time", () => {
    const g = { ...aaa.games[0], status: "scheduled", date: "2026-06-20", startsAt: "2026-06-20T23:05:00.000Z" };
    const s = { ...aaa, games: [...aaa.games, g] };
    const milb = scoreboard(s, 50, "aaa").find((x) => x.id === g.id);
    assert.equal(milb?.statusLabel, "7:05 PM ET");
    const ag = { ...afl.games[0], id: "00000000-0000-4000-9005-999999999999", status: "scheduled", date: "2026-11-20", startsAt: "2026-11-20T23:05:00.000Z" };
    const a = { ...afl, games: [...afl.games, ag] };
    assert.equal(scoreboard(a, 50).find((x) => x.id === ag.id)?.statusLabel, "4:05 PM MST");
  });
});
