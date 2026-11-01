import { test } from "node:test";
import assert from "node:assert/strict";
import { players, teams, news } from "../src/data/demo";
import {
  prospectRepository,
  getMarketOverview,
} from "../src/services/prospects";
import { average, innings, era } from "../src/lib/format";
import { getDatabase } from "../src/db/client";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema";

test("fictional fixtures preserve identity, references, two-way roles, and chart endpoints", () => {
  assert.equal(teams.length, 13);
  assert.equal(players.length, 18);
  assert.equal(new Set(players.map((p) => p.id)).size, players.length);
  assert.ok(players.some((p) => p.batting && p.pitching));
  for (const p of players) {
    assert.ok(teams.some((t) => t.id === p.teamId));
    assert.ok(p.history.length > 1);
    assert.equal(p.history.at(-1)?.grade, p.grade);
    assert.equal(p.history.at(-1)?.momentum, p.momentum);
    for (const h of p.history) assert.ok(h.grade >= 0 && h.grade <= 100);
    if (p.batting) assert.ok(p.batting.hits <= p.batting.atBats);
  }
  for (const n of news)
    for (const id of n.playerIds) assert.ok(players.some((p) => p.id === id));
});
test("repository resolves profiles and missing IDs without a database", async () => {
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.equal((await prospectRepository.listPlayers()).length, 18);
    assert.equal(
      (await prospectRepository.findPlayer(players[0].id))?.name,
      "Atlas Finch",
    );
    assert.equal(await prospectRepository.findPlayer("missing"), undefined);
    assert.equal(await prospectRepository.findTeam("missing"), undefined);
    assert.throws(getDatabase, /DATABASE_URL is required/);
    const market = await getMarketOverview();
    assert.equal(market.top[0].grade, 92);
    assert.ok(market.rising.every((p) => p.momentum > 0));
    assert.ok(market.falling.every((p) => p.momentum < 0));
    assert.equal(market.rising.length + market.falling.length, players.length);
  } finally {
    if (original !== undefined) process.env.DATABASE_URL = original;
  }
});
test("baseball formats handle fractional innings and empty samples", () => {
  assert.equal(innings(19), "6.1");
  assert.equal(era(2, 19), "2.84");
  assert.equal(era(0, 0), "—");
  assert.equal(average(0, 0), "—");
  assert.equal(average(38, 100), ".380");
});
test("schema has all 20 relational models with primary keys", () => {
  const tables = Object.values(schema).map((table) => getTableConfig(table));
  assert.equal(tables.length, 20);
  for (const table of tables)
    assert.ok(table.columns.some((column) => column.primary));
  const current = getTableConfig(schema.prospectScores);
  assert.ok(current.checks.length > 0);
  assert.equal(getTableConfig(schema.newsItemPlayers).foreignKeys.length, 2);
  assert.equal(getTableConfig(schema.highlights).foreignKeys.length, 2);
});
