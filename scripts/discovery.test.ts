import { test } from "node:test";
import assert from "node:assert/strict";
import { prospectRepository } from "../src/services/prospects";
import { defaultFilters, discoverDemoPlayers } from "../src/services/discovery";
import { demoDiscoveryOrder, DEMO_AS_OF, players } from "../src/data/demo";
import { ageOn } from "../src/lib/format";
import type { TimeWindow, RankingMode } from "../src/types/baseball";

test("demo modes have complete independent orders, not grade sorting or a scoring formula", async () => {
  const catalog = await prospectRepository.catalog();
  for (const window of ["7d", "14d", "30d", "season"] as TimeWindow[])
    for (const ranking of ["priority", "performance"] as RankingMode[]) {
      const order = demoDiscoveryOrder[window][ranking];
      assert.equal(new Set(order).size, 18);
      assert.deepEqual(new Set(order), new Set(players.map((p) => p.id)));
    }
  const priority = discoverDemoPlayers(catalog, defaultFilters);
  const performance = discoverDemoPlayers(catalog, {
    ...defaultFilters,
    ranking: "performance",
  });
  assert.equal(priority[0].name, "Atlas Finch");
  assert.equal(performance[0].name, "Jett Marlow");
  const context = (id: string) =>
    catalog.contexts.find(
      (c) => c.id === catalog.teams.find((t) => t.id === id)!.contextId,
    )!.slug;
  assert.equal(context(priority[0].teamId), "aa");
  assert.equal(context(performance[0].teamId), "single-a");
  assert.notDeepEqual(
    discoverDemoPlayers(catalog, { ...defaultFilters, window: "7d" }).map(
      (p) => p.id,
    ),
    priority.map((p) => p.id),
  );
});
test("combined level, timeframe, role, organization, and screener filters preserve entity identity", async () => {
  const catalog = await prospectRepository.catalog();
  for (const context of catalog.contexts) {
    const result = discoverDemoPlayers(catalog, {
      ...defaultFilters,
      context: context.slug,
      window: "7d",
    });
    assert.ok(result.length);
    for (const p of result)
      assert.equal(
        catalog.teams.find((t) => t.id === p.teamId)!.contextId,
        context.id,
      );
  }
  const pitchers = discoverDemoPlayers(catalog, {
    ...defaultFilters,
    type: "pitchers",
  });
  assert.equal(pitchers.length, 6);
  assert.ok(pitchers.every((p) => p.performance["14d"].pitching));
  const hitters = discoverDemoPlayers(catalog, {
    ...defaultFilters,
    type: "hitters",
  });
  assert.equal(hitters.length, 13);
  assert.ok(
    pitchers.some((p) => hitters.includes(p)),
    "Two-way player appears in both role filters",
  );
  const p = players[0];
  const found = discoverDemoPlayers(catalog, {
    ...defaultFilters,
    query: "finch",
    organization: p.organizationId,
    team: p.teamId,
    minGrade: 90,
    minMomentum: 8,
    maxAge: 20,
    position: "SS",
  });
  assert.deepEqual(found, [p]);
  assert.deepEqual(
    discoverDemoPlayers(catalog, {
      ...defaultFilters,
      query: "no such player",
    }),
    [],
  );
  assert.ok(
    discoverDemoPlayers(catalog, { ...defaultFilters, maxAge: 20 }).every(
      (p) => ageOn(p.birthDate, DEMO_AS_OF) <= 20,
    ),
  );
});
test("window statistics are distinct, coherent fictional samples; scores do not change with window", () => {
  for (const p of players) {
    assert.notDeepEqual(p.performance["7d"], p.performance["14d"]);
    for (const sample of Object.values(p.performance)) {
      if (sample.batting) {
        const b = sample.batting;
        assert.ok(b.hits <= b.atBats);
        assert.ok(b.doubles + b.triples + b.homeRuns <= b.hits);
      }
      if (sample.pitching) {
        assert.ok(sample.pitching.outsRecorded > 0);
        assert.ok(sample.pitching.strikeouts <= sample.pitching.outsRecorded);
      }
    }
    assert.equal(p.history.at(-1)!.grade, p.grade);
    assert.equal(p.history.at(-1)!.momentum, p.momentum);
  }
});
test("AFL rosters retain independent organization and underlying affiliated membership", async () => {
  const catalog = await prospectRepository.catalog();
  const afl = discoverDemoPlayers(catalog, {
    ...defaultFilters,
    context: "afl",
  });
  assert.equal(afl.length, 3);
  for (const p of afl) {
    const team = catalog.teams.find((t) => t.id === p.teamId)!;
    assert.equal(team.organizationId, null);
    const org = catalog.organizationMemberships.find(
      (m) => m.playerId === p.id && m.endsOn === null,
    )!;
    assert.equal(org.organizationId, p.organizationId);
    const active = catalog.memberships.filter(
      (m) => m.playerId === p.id && m.endsOn === null,
    );
    assert.equal(active.length, 2);
    assert.ok(
      active.some(
        (m) => m.assignmentType === "afl-assignment" && m.teamId === p.teamId,
      ),
    );
    const affiliate = active.find(
      (m) => m.assignmentType !== "afl-assignment",
    )!;
    assert.equal(
      catalog.teams.find((t) => t.id === affiliate.teamId)!.organizationId,
      p.organizationId,
    );
    assert.equal(p.seasonStats.length, 2);
    assert.notEqual(p.seasonStats[0].teamId, p.seasonStats[1].teamId);
  }
  const shared = afl.filter((p) => p.teamId === afl[1].teamId);
  assert.equal(new Set(shared.map((p) => p.organizationId)).size, 2);
});
test("assignment timelines and news links resolve without replacing stable IDs", async () => {
  const c = await prospectRepository.catalog();
  assert.equal(
    new Set(c.memberships.map((m) => m.id)).size,
    c.memberships.length,
  );
  for (const m of c.memberships) {
    assert.ok(c.players.some((p) => p.id === m.playerId));
    assert.ok(c.teams.some((t) => t.id === m.teamId));
    assert.ok(!m.endsOn || m.endsOn >= m.startsOn);
  }
  for (const n of c.news) {
    for (const id of n.teamIds) assert.ok(c.teams.some((t) => t.id === id));
    for (const id of n.organizationIds)
      assert.ok(c.organizations.some((o) => o.id === id));
  }
  assert.equal(await prospectRepository.findOrganization("missing"), undefined);
  assert.equal(await prospectRepository.findContext("missing"), undefined);
  assert.ok(
    c.news.some((n) => n.playerIds.includes(players[17].id)),
    "News includes players outside the top discovery positions",
  );
});

test("numeric table sorts retain unavailable statistics last and do not mutate discovery order", async () => {
  const { sortByValue } = await import("../src/lib/table-sort");
  const rows = [
    { id: "empty", value: null },
    { id: "zero", value: 0 },
    { id: "high", value: 12 },
  ];
  assert.deepEqual(
    sortByValue(rows, (r) => r.value, "asc").map((r) => r.id),
    ["zero", "high", "empty"],
  );
  assert.deepEqual(
    sortByValue(rows, (r) => r.value, "desc").map((r) => r.id),
    ["high", "zero", "empty"],
  );
  assert.equal(rows[0].id, "empty");
});
