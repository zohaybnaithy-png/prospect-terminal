import { test, describe } from "node:test";
import assert from "node:assert/strict";
import regression from "../src/ingestion/fixtures/mlb/milb-2026.schedule-regression.json";
import { selectMilbSchedule } from "../src/ingestion/sources/milb-stats-api";
import {
  reconcileLinkedChain,
  reconcileScheduleGroup,
  type ScheduleRow,
} from "../src/ingestion/sources/mlb-schedule";
import { gameStatus } from "../src/ingestion/sources/mlb-normalize";
import type { MilbOptions } from "../src/ingestion/sources/milb-config";

/**
 * Schedule reconciliation regression set from the 2026 live read-only validation (see the
 * fixture's description). Every group is checked over the full season and over every
 * single-date capture window, mirroring chunked backfills and incremental runs.
 */
type Group = {
  name: string;
  origin: string;
  expect: {
    status?: string;
    officialDate?: string;
    startsAt?: string;
    score?: [number, number] | null;
    kinds?: string[];
    notice?: string;
    quarantine?: string;
  };
  rows: [string, Record<string, unknown>][];
};
const groups = regression.groups as unknown as Group[];
const LEAGUE = 117;

/** A level context in which every team of the regression set belongs to one league. */
function context() {
  const teams = new Map<number, { id: number; name: string; league: { id: number } }>();
  for (const g of groups)
    for (const [, row] of g.rows) {
      const sides = row.teams as { home: { team: { id: number } }; away: { team: { id: number } } };
      for (const id of [sides.home.team.id, sides.away.team.id])
        teams.set(id, { id, name: `Team ${id}`, league: { id: LEAGUE } });
    }
  return {
    level: "aaa" as const,
    sportId: 11,
    leagues: new Map([[LEAGUE, "League"]]),
    teams,
    leaguesFromTeams: false,
  };
}
const envelope = (rows: Group["rows"]) => {
  const dates = new Map<string, unknown[]>();
  for (const [date, game] of rows) dates.set(date, [...(dates.get(date) ?? []), game]);
  return { dates: [...dates].sort(([a], [b]) => a.localeCompare(b)).map(([date, games]) => ({ date, games })) };
};
const options = (o: Partial<MilbOptions> = {}): MilbOptions => ({
  season: 2026,
  levels: ["aaa"],
  gameTypes: ["R"],
  ...o,
});
const ctx = context();

describe("live-shaped MiLB schedule regression set", () => {
  for (const group of groups)
    test(group.name, () => {
      const pk = (group.rows[0][1] as { gamePk: number }).gamePk;
      const result = selectMilbSchedule(envelope(group.rows), ctx as never, options());
      const selected = result.games.get(pk);
      const e = group.expect;
      if (e.quarantine) {
        assert.equal(selected, undefined, "must not be selected");
        const issue = result.issues.find((i) => i.recordKey === `game:${pk}`);
        assert.ok(issue, "must be quarantined");
        assert.match(issue.message, new RegExp(e.quarantine));
        return;
      }
      if (e.notice) {
        assert.equal(selected, undefined);
        assert.equal(result.issues.length, 0, JSON.stringify(result.issues));
        assert.ok(result.notices.some((n) => n.recordKey === `game:${pk}` && n.message.includes(e.notice!)), JSON.stringify(result.notices));
        return;
      }
      assert.equal(result.issues.length, 0, JSON.stringify(result.issues));
      assert.ok(selected, "must be selected");
      const r = selected.record;
      assert.equal(r.status, e.status);
      assert.equal(r.officialDate, e.officialDate);
      assert.equal(r.startsAt, e.startsAt);
      assert.deepEqual(
        e.score ? [r.homeScore, r.awayScore] : [r.homeScore, r.awayScore].filter((v) => v !== undefined),
        e.score ?? [],
      );
      const notice = result.notices.find((n) => n.recordKey === `game:${pk}` && n.reason === "reconciled-reschedule");
      if (group.rows.length > 1) assert.ok(notice, "reconciliation is reported");
      if (e.kinds?.includes("resumption")) assert.match(notice!.message, /resumption/);
      if (e.kinds?.includes("reschedule")) assert.match(notice!.message, /postponed/);
    });

  test("every single-date capture window agrees with the full-season result (chunk safety)", () => {
    for (const group of groups) {
      if (group.expect.quarantine || group.expect.notice) continue;
      const pk = (group.rows[0][1] as { gamePk: number }).gamePk;
      const full = selectMilbSchedule(envelope(group.rows), ctx as never, options()).games.get(pk)!.record;
      for (const date of new Set(group.rows.map(([d]) => d))) {
        // The API returns rows bucketed on the requested dates only.
        const windowRows = group.rows.filter(([d]) => d === date);
        const windowed = selectMilbSchedule(envelope(windowRows), ctx as never, options({ from: date, to: date }));
        assert.equal(windowed.issues.length, 0, `${group.name} @ ${date}: ${JSON.stringify(windowed.issues)}`);
        const got = windowed.games.get(pk)?.record;
        // A window either stores nothing for this game or exactly what the full season stores
        // (a resumption-only window omits the venue, so the origin's stored venue is kept); it
        // never stores a superseded postponed/partial representation.
        if (got) {
          const { venue: _v, ...rest } = full;
          void _v;
          assert.deepEqual(got, "venue" in got ? full : rest, `${group.name} @ ${date}`);
        }
        const resumption = windowRows.every(([, r]) => r.resumedFrom !== undefined);
        if (resumption) assert.ok(got, `${group.name} @ ${date}: resumption window completes the game`);
      }
    }
  });
});

describe("chain reconciler units", () => {
  const rowsOf = (name: string) =>
    groups.find((g) => g.name.startsWith(name))!.rows.map(([date, game]) => ({ date, game })) as unknown as ScheduleRow[];
  const identity = (r: ScheduleRow) => ({ start: r.game.gameDate, status: gameStatus(r.game.status), official: r.game.officialDate });

  test("row order does not matter", () => {
    const rows = rowsOf("High-A postponed -> postponed -> final");
    const a = reconcileLinkedChain(rows, identity);
    const b = reconcileLinkedChain([...rows].reverse(), identity);
    assert.deepEqual(a, b);
    assert.deepEqual(a.reconciled, ["reschedule"]);
  });

  test("exact duplicate listings collapse", () => {
    const rows = rowsOf("Single-A suspended -> resumed");
    const r = reconcileLinkedChain([rows[0], rows[0], rows[1]], identity);
    assert.equal(r.chosen.game.gameDate, "2026-04-07T22:10:00Z");
  });

  test("a suspended origin still in progress with its resumption not yet played keeps the in-progress status", () => {
    const [origin, resumed] = rowsOf("Single-A suspended -> resumed");
    const live = { ...origin, game: { ...origin.game, status: { abstractGameState: "Live", detailedState: "Suspended: Rain", codedGameState: "U" }, teams: { home: { team: { id: 507 } }, away: { team: { id: 424 } } } } };
    const pending = { ...resumed, game: { ...resumed.game, status: { abstractGameState: "Preview", detailedState: "Scheduled", codedGameState: "S" }, teams: { home: { team: { id: 507 } }, away: { team: { id: 424 } } } } };
    const r = reconcileLinkedChain([live, pending] as ScheduleRow[], identity);
    assert.equal(gameStatus(r.chosen.game.status), "in-progress");
  });

  test("the AFL reconciler keeps its original pairwise policy", () => {
    // AFL never accepted chains or resumptions; that behavior is unchanged.
    assert.throws(() => reconcileScheduleGroup(rowsOf("High-A postponed -> postponed -> final"), identity), /linkage|unique/);
    assert.throws(() => reconcileScheduleGroup(rowsOf("Single-A suspended -> resumed"), identity), /unique current game/);
    assert.equal(reconcileScheduleGroup(rowsOf("AAA postponed -> doubleheader"), identity).reconciled, "reschedule");
  });
});
