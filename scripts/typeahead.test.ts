/**
 * Header typeahead (T-205): the per-level name index (short unique keys, team table, ordering),
 * its size budget at the largest real level size, key resolution, the matcher, and the shape check
 * the browser applies to a fetched index. Fictional fixtures only.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { levelDirectoryRows } from "../src/services/players/adapter";
import {
  KEY_MIN_LENGTH,
  SUGGESTION_LIMIT,
  buildNameIndex,
  foldName,
  isNameIndex,
  resolveNameKey,
  suggest,
  suggestionHref,
  uniqueKeyLength,
  type NameIndexSource,
} from "../src/services/search/name-index";
import { scaleSnapshot } from "./milb-scale-support";

const row = (id: string, name: string, team: string | null = "T1", org: string | null = "O1", position = "SS"): NameIndexSource => ({
  id,
  name,
  position,
  team: team ? { abbreviation: team } : null,
  organization: org ? { abbreviation: org } : null,
});

describe("name index", () => {
  test("keys are the shortest unique hex prefix, never below the minimum", () => {
    assert.equal(uniqueKeyLength([]), KEY_MIN_LENGTH);
    assert.equal(uniqueKeyLength(["0a3576f9-75f2-4be1-8342-a820c380ba31", "1b3576f9-75f2-4be1-8342-a820c380ba31"]), KEY_MIN_LENGTH);
    // Two ids sharing their first 15 hex digits need 16.
    const a = "0a3576f9-75f2-4be1-8342-a820c380ba31", b = "0a3576f9-75f2-4be9-8342-a820c380ba31";
    assert.equal(uniqueKeyLength([a, b]), 16);
    const index = buildNameIndex([row(a, "Al One"), row(b, "Bo Two")], "aa");
    assert.deepEqual(index.players.map((p) => p[0]), ["0a3576f975f24be1", "0a3576f975f24be9"]);
    // The same id listed twice is one player, not a collision.
    assert.equal(uniqueKeyLength([a, a]), KEY_MIN_LENGTH);
  });

  test("players sorted by name; teams deduplicated into a table; no team is -1", () => {
    const index = buildNameIndex(
      [row(randomUUID(), "Zed Last", "T2", "O2"), row(randomUUID(), "Amy First"), row(randomUUID(), "Mo Middle"), row(randomUUID(), "No Team", null, null)],
      "high-a",
    );
    assert.equal(index.v, 1);
    assert.equal(index.level, "high-a");
    assert.deepEqual(index.players.map((p) => p[1]), ["Amy First", "Mo Middle", "No Team", "Zed Last"]);
    assert.deepEqual(index.teams, [["T1", "O1"], ["T2", "O2"]]);
    assert.deepEqual(index.players.map((p) => p[3]), [0, 0, -1, 1]);
    assert.ok(isNameIndex(JSON.parse(JSON.stringify(index)), "high-a"));
  });

  test("built from a level's directory rows: one entry per player, every key resolves to its player", () => {
    const snapshot = scaleSnapshot({ ns: 4, level: "aa", teams: 3, days: 8, seed: 4 });
    const rows = levelDirectoryRows(snapshot, "aa", "season");
    const index = buildNameIndex(rows, "aa");
    assert.equal(index.players.length, rows.length);
    const ids = rows.map((r) => r.id);
    for (const [key, name] of index.players) {
      const id = resolveNameKey(ids, key);
      assert.ok(id, key);
      assert.equal(rows.find((r) => r.id === id)!.name, name);
    }
  });

  test("size budget: under 50 kB gzipped at 2,400 players (the largest level has ~2,000)", () => {
    // Pseudo-random names (more entropy than real names, so this is conservative).
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const word = (n: number) => Array.from({ length: n }, () => "abcdefghijklmnoprstuvwyz"[Math.floor(rand() * 24)]).join("");
    const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
    const rows = Array.from({ length: 2400 }, (_, i) =>
      row(randomUUID(), `${cap(word(3 + (i % 5)))} ${cap(word(4 + (i % 6)))}`, `T${i % 30}`, `O${i % 30}`, ["SS", "C", "RHP", "LHP", "CF"][i % 5]),
    );
    const body = JSON.stringify(buildNameIndex(rows, "aaa"));
    const gz = gzipSync(body, { level: 6 }).length;
    assert.ok(gz < 50_000, `gzipped ${gz} bytes (raw ${body.length})`);
    console.log(`[typeahead] 2,400-player index: ${body.length} bytes raw, ${gz} gzipped`);
  });
});

describe("resolveNameKey", () => {
  const a = "0a3576f9-75f2-4be1-8342-a820c380ba31", b = "0a3576f9-75f2-4be9-8342-a820c380ba31";
  test("exactly one match resolves; ambiguous, unknown and malformed keys do not", () => {
    assert.equal(resolveNameKey([a, b], "0a3576f975f24be1"), a);
    assert.equal(resolveNameKey([a, b], "0a3576f975"), null, "ambiguous");
    assert.equal(resolveNameKey([a, b], "ffffffffff"), null, "unknown");
    assert.equal(resolveNameKey([a, b], "0a3576"), null, "shorter than the minimum");
    assert.equal(resolveNameKey([a, b], "0a3576f9-75f2"), null, "not hex");
    assert.equal(resolveNameKey([a], "0A3576F975"), null, "keys are lower-case");
  });
});

describe("suggest", () => {
  const index = buildNameIndex(
    [
      row(randomUUID(), "José Ramírez", "AKR", "CLE"),
      row(randomUUID(), "Joe Smith", "T1", "O1", "C"),
      row(randomUUID(), "Billy Joseph"),
      row(randomUUID(), "Ajose Doe"),
      row(randomUUID(), "Sam O'Joseph"),
    ],
    "aa",
  );
  test("accents and case are ignored", () => {
    assert.equal(foldName("  José   RAMÍREZ "), "jose ramirez");
    assert.deepEqual(suggest([index], "ramirez").map((s) => s.name), ["José Ramírez"]);
  });

  test("name prefix, then word prefix, then substring", () => {
    assert.deepEqual(suggest([index], "jos").map((s) => s.name), ["José Ramírez", "Billy Joseph", "Sam O'Joseph", "Ajose Doe"]);
  });

  test("too-short queries suggest nothing; results are capped", () => {
    assert.deepEqual(suggest([index], "j"), []);
    const many = buildNameIndex(Array.from({ length: 20 }, (_, i) => row(randomUUID(), `Player ${i}`)), "aa");
    assert.equal(suggest([many], "pla").length, SUGGESTION_LIMIT);
  });

  test("context: position, team, organization and level; several levels in ladder order", () => {
    const [s] = suggest([index], "ramirez");
    assert.deepEqual({ ...s, key: undefined }, { key: undefined, name: "José Ramírez", position: "SS", team: "AKR", org: "CLE", level: "aa" });
    const other = buildNameIndex([row(randomUUID(), "José Ramírez", "COL", "CLE")], "aaa");
    assert.deepEqual(suggest([other, index], "ramirez").map((x) => x.level), ["aaa", "aa"]);
  });

  test("a pick goes to the resolver with the name as fallback", () => {
    assert.equal(suggestionHref({ key: "0a3576f975", level: "high-a", name: "José Ramírez" }), "/search/player?level=high-a&id=0a3576f975&q=Jos%C3%A9+Ram%C3%ADrez");
  });
});

describe("isNameIndex (fetched index shape check)", () => {
  const good = buildNameIndex([row(randomUUID(), "Al One")], "afl");
  test("accepts a real index for the requested level only", () => {
    assert.ok(isNameIndex(good, "afl"));
    assert.ok(!isNameIndex(good, "aa"), "another level");
  });
  test("rejects other versions, malformed entries and team references out of range", () => {
    for (const bad of [null, 1, "x", { ...good, v: 2 }, { ...good, players: [["k", "n", "p"]] }, { ...good, players: [["k", "n", "p", 5]] }, { ...good, players: [["k", 1, "p", 0]] }, { ...good, teams: undefined }])
      assert.ok(!isNameIndex(bad, "afl"), JSON.stringify(bad));
  });
});
