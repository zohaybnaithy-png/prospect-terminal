import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCompetition } from "../src/services/competition/load";
import { readinessReport } from "../src/services/competition/readiness";
import type { AflSnapshot } from "../src/services/afl/types";
import type { LevelId } from "../src/services/players/levels";
import { playerId, scaleSnapshot } from "./milb-scale-support";

const SHARED = playerId(98, 1);
const small = { teams: 6, days: 60 } as const;
const snapshots: Partial<Record<LevelId, AflSnapshot>> = {
  aa: scaleSnapshot({ ns: 2, level: "aa", ...small, seed: 2, sharedPlayers: [{ id: SHARED, name: "Shared Prospect", role: "hitter", toDay: 40 }] }),
  aaa: scaleSnapshot({ ns: 1, level: "aaa", ...small, seed: 1, sharedPlayers: [{ id: SHARED, name: "Shared Prospect", role: "hitter", fromDay: 45 }] }),
  "high-a": scaleSnapshot({ ns: 3, level: "high-a", ...small, days: 50, seed: 3 }),
};

test("readiness exercises every page view model per level on fictional MiLB-scale data", async () => {
  const result = await loadCompetition(async (level) => snapshots[level] ?? null);
  const report = readinessReport(result);
  assert.equal(report.status, "ok");
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.levels.map((l) => l.level), ["aaa", "aa", "high-a"]);
  for (const l of report.levels) {
    assert.equal(l.coverageStatus, "live");
    assert.ok(l.finalGames > 0 && l.battingLines > 0 && l.pitchingLines > 0);
    assert.ok(l.directory.season.hitter > 0 && l.directory["7d"].pitcher > 0);
    // A 50–60 day season has an earlier baseline for every Momentum window.
    for (const w of ["7d", "14d", "30d"] as const) assert.ok(l.momentumComparable.hitter[w] > 0, `${l.level} ${w}`);
    assert.ok(l.sampleProfile && l.sampleProfile.levels.includes(l.level));
  }
  assert.ok(report.multiLevelPlayers >= 1, "the promoted player is one identity across levels");
  assert.ok(report.allLevelsDirectory.hitter < report.levels.reduce((a, l) => a + l.directory.season.hitter, 0));
});

test("readiness reports an empty or unavailable database honestly", async () => {
  const empty = readinessReport(await loadCompetition(async () => null));
  assert.equal(empty.status, "empty");
  assert.match(empty.problems.join(), /empty/);
});
