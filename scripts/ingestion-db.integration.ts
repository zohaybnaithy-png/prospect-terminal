import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "pg";
import { AflFixtureAdapter } from "../src/ingestion/sources/afl-fixture";
import { PostgresIngestionSink } from "../src/ingestion/postgres-sink";
import { ingest } from "../src/ingestion/runner";
import type { SourceAdapter, SourceSnapshot } from "../src/ingestion/contracts";

test("PostgreSQL AFL proof: identity, replay, corrections, roster history, quarantine, rollback and source conflicts", async (t) => {
  const url = process.env.INGESTION_TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("/prospect_ingestion_test"))
    throw new Error(
      "Use a fresh migrated disposable database named prospect_ingestion_test via INGESTION_TEST_DATABASE_URL",
    );
  const client = new Client({ connectionString: url });
  await client.connect();
  const sink = new PostgresIngestionSink(url);
  const a = new AflFixtureAdapter(resolve("src/ingestion/fixtures/afl.json"));
  const original = await a.load();
  const adapt = (snapshot: SourceSnapshot): SourceAdapter => ({
    id: snapshot.provider,
    version: snapshot.adapterVersion,
    load: async () => snapshot,
    normalize: (s) => a.normalize(s),
  });
  const count = async (table: string) =>
    (await client.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0]
      .n as number;
  const revise = (
    date: string,
    edit?: (records: Record<string, unknown>[]) => void,
  ) => {
    const s = structuredClone(original);
    s.observedAt = date;
    s.fetchedAt = new Date().toISOString();
    const p = s.payload as {
      observedAt: string;
      records: Record<string, unknown>[];
    };
    p.observedAt = date;
    edit?.(p.records);
    return s;
  };
  try {
    assert.equal(await count("players"), 0, "Integration DB must be fresh");
    await t.test(
      "first apply and concurrent replay retain UUIDs, stints and two-way game lines",
      async () => {
        const first = await ingest(adapt(original), sink);
        assert.equal(first.changed, 24);
        const before = (
          await client.query(
            "SELECT internal_id FROM source_identities ORDER BY external_id",
          )
        ).rows;
        const replays = await Promise.all([
          ingest(adapt(original), sink),
          ingest(adapt(original), sink),
        ]);
        assert.ok(replays.every((r) => r.changed === 0 && r.unchanged === 24));
        assert.deepEqual(
          (
            await client.query(
              "SELECT internal_id FROM source_identities ORDER BY external_id",
            )
          ).rows,
          before,
        );
        assert.equal(await count("players"), 3);
        assert.equal(await count("games"), 1);
        assert.equal(await count("player_batting_games"), 2);
        assert.equal(await count("player_pitching_games"), 2);
        assert.equal(await count("source_snapshots"), 1);
        assert.ok(
          (
            await client.query(
              "SELECT internal_id FROM source_identities WHERE entity_kind='player'",
            )
          ).rows.every((r) => /^[0-9a-f-]{36}$/.test(r.internal_id)),
        );
        assert.equal(
          (
            await client.query(
              "SELECT count(DISTINCT o.organization_id)::integer AS n FROM player_team_memberships m JOIN player_organization_memberships o ON o.player_id=m.player_id WHERE m.team_id=(SELECT internal_id FROM source_identities WHERE entity_kind='team' AND external_id='fall-team-1')",
            )
          ).rows[0].n,
          2,
        );
        assert.equal(
          (
            await client.query(
              "SELECT count(*)::integer AS n FROM teams WHERE organization_id IS NOT NULL",
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      "later corrected snapshot replaces a stat instead of adding totals; roster observations retain separate dates",
      async () => {
        const s = revise("2026-10-26T00:00:00Z", (rows) => {
          const row = rows.find((r) => r.entity === "battingGame")!;
          (row.stats as Record<string, number>).hits = 3;
        });
        const r = await ingest(adapt(s), sink);
        assert.equal(r.changed, 4);
        assert.equal(await count("player_batting_games"), 2);
        assert.equal(await count("source_roster_observations"), 6);
        assert.equal(await count("player_team_memberships"), 3);
        assert.equal(
          (
            await client.query(
              "SELECT max(hits) AS hits FROM player_batting_games",
            )
          ).rows[0].hits,
          3,
        );
        await assert.rejects(
          () => ingest(adapt(original), sink),
          /stale-snapshot/,
        );
        assert.equal(
          (
            await client.query(
              "SELECT max(hits) AS hits FROM player_batting_games",
            )
          ).rows[0].hits,
          3,
        );
      },
    );
    await t.test(
      "invalid rows quarantine the entire source batch with audit evidence and no canonical writes",
      async () => {
        const before = await count("players");
        const s = revise("2026-10-27T00:00:00Z", (rows) => {
          rows.push({
            entity: "player",
            id: "invalid-person",
            fullName: "Missing required position",
          });
          rows.push({
            entity: "player",
            id: "valid-but-quarantined",
            fullName: "Must not leak",
            position: "SS",
          });
        });
        const r = await ingest(adapt(s), sink);
        assert.equal(r.status, "quarantined");
        assert.ok(r.issues > 0);
        assert.equal(await count("players"), before);
        assert.ok((await count("ingestion_issues")) > 0);
      },
    );
    await t.test(
      "overlapping affiliations roll back a preceding entity correction",
      async () => {
        const s = revise("2026-10-28T00:00:00Z", (rows) => {
          const p = rows.find((r) => r.entity === "player")!;
          p.fullName = "Should roll back";
          const m = rows.find((r) => r.entity === "organizationMembership")!;
          rows.push({ ...m, key: "overlapping-org", organization: "org-2" });
        });
        await assert.rejects(
          () => ingest(adapt(s), sink),
          /overlapping-organization-stints/,
        );
        assert.equal(
          (
            await client.query(
              "SELECT count(*)::integer AS n FROM players WHERE name='Should roll back'",
            )
          ).rows[0].n,
          0,
        );
        assert.ok(
          (
            await client.query(
              "SELECT count(*)::integer AS n FROM ingestion_runs WHERE status='failed'",
            )
          ).rows[0].n > 0,
        );
      },
    );
    await t.test(
      "incremental stats reject an unrelated team and roll back its new mapping",
      async () => {
        const snapshot = revise("2026-10-30T00:00:00Z");
        const originalPayload = original.payload as {
          records: Record<string, unknown>[];
        };
        const line = structuredClone(
          originalPayload.records.find((r) => r.entity === "battingGame")!,
        );
        line.team = "fall-team-3";
        (snapshot.payload as { records: unknown[] }).records = [
          {
            entity: "team",
            id: "fall-team-3",
            fullName: "Unrelated team",
            abbreviation: "FT3",
            level: "fall-classification",
            organization: null,
          },
          line,
        ];
        await assert.rejects(
          () => ingest(adapt(snapshot), sink),
          /stat-team-not-in-game/,
        );
        assert.equal(await count("teams"), 2);
        assert.equal(
          (
            await client.query(
              "SELECT count(*)::integer AS n FROM source_identities WHERE external_id='fall-team-3'",
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      "same-as-of conflicting revisions require reconciliation",
      async () => {
        const s = revise("2026-10-26T00:00:00Z", (rows) => {
          rows.find((r) => r.entity === "player")!.fullName =
            "Unordered correction";
        });
        await assert.rejects(
          () => ingest(adapt(s), sink),
          /ambiguous-revision/,
        );
      },
    );
    await t.test(
      "reviewed mapping to another source cannot overwrite canonical ownership",
      async () => {
        const run = (
          await client.query("SELECT id FROM ingestion_runs LIMIT 1")
        ).rows[0].id;
        const person = (
          await client.query(
            "SELECT internal_id FROM source_identities WHERE entity_kind='player' AND external_id='person-1'",
          )
        ).rows[0].internal_id;
        await client.query(
          "INSERT INTO source_identities(provider,entity_kind,external_id,internal_id,created_run_id) VALUES('other-fixture','player','other-person',$1,$2)",
          [person, run],
        );
        const s = revise("2026-10-29T00:00:00Z");
        s.provider = "other-fixture";
        (s.payload as { records: unknown[] }).records = [
          {
            entity: "player",
            id: "other-person",
            fullName: "Do not replace",
            position: "SS",
          },
        ];
        await assert.rejects(
          () => ingest(adapt(s), sink),
          /source-ownership-conflict/,
        );
        assert.notEqual(
          (await client.query("SELECT name FROM players WHERE id=$1", [person]))
            .rows[0].name,
          "Do not replace",
        );
      },
    );
    await t.test(
      "confirmed organization movement retains history and closes an older stint before opening a new one",
      async () => {
        const s = revise("2026-11-01T00:00:00Z", (rows) => {
          const old = rows.find(
            (r) =>
              r.entity === "organizationMembership" && r.player === "person-1",
          )!;
          old.endsOn = "2026-10-30";
          rows.push({
            entity: "organizationMembership",
            key: "a-trade-first-alphabetically",
            player: "person-1",
            organization: "org-2",
            startsOn: "2026-10-31",
            endsOn: null,
          });
          rows.find(
            (r) => r.entity === "rosterObservation" && r.player === "person-1",
          )!.organization = "org-2";
          const line = rows.find((r) => r.entity === "battingGame")!;
          (line.stats as Record<string, number>).hits = 3;
        });
        const report = await ingest(adapt(s), sink);
        assert.equal(report.status, "applied");
        const result = await client.query(
          "SELECT starts_on::text,ends_on::text FROM player_organization_memberships WHERE player_id=(SELECT internal_id FROM source_identities WHERE provider='afl-fixture' AND entity_kind='player' AND external_id='person-1') ORDER BY starts_on",
        );
        assert.equal(result.rows.length, 2);
        assert.equal(result.rows[0].ends_on, "2026-10-30");
        assert.equal(result.rows[1].starts_on, "2026-10-31");
        assert.equal(result.rows[1].ends_on, null);
      },
    );
  } finally {
    await sink.close();
    await client.end();
  }
});

test("PostgreSQL season totals (D-030, T-503): apply, replay, correction, stale capture, stored players, quarantine", async (t) => {
  const url = process.env.INGESTION_TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("/prospect_ingestion_test"))
    throw new Error("Use the disposable prospect_ingestion_test database via INGESTION_TEST_DATABASE_URL");
  const { SeasonTotalsStatsApiSource } = await import("../src/ingestion/sources/season-totals-stats-api");
  const { fakeTotalsFetch, hitter, pitcher } = await import("./season-totals-support");
  const client = new Client({ connectionString: url });
  await client.connect();
  const sink = new PostgresIngestionSink(url);
  const capture = (at: string, edit: (f: { hitting: Record<number, Record<string, unknown>[]>; pitching: Record<number, Record<string, unknown>[]> }) => void = () => {}, known?: number[]) => {
    const f = { hitting: { 11: [hitter(9101), hitter(9102)], 14: [hitter(9103)] } as Record<number, Record<string, unknown>[]>, pitching: { 12: [pitcher(9201)] } as Record<number, Record<string, unknown>[]> };
    edit(f);
    return new SeasonTotalsStatsApiSource(
      { season: 2014, scope: "milb" },
      { fetcher: fakeTotalsFetch(f), sleep: async () => {}, clock: () => new Date(at), knownPlayers: known ? new Set(known) : undefined },
    );
  };
  const rows = async () =>
    (await client.query(
      `SELECT si.external_id AS player, s.level_code, s.plate_appearances AS pa, s.hits, se.year
         FROM player_batting_level_seasons s
         JOIN source_identities si ON si.internal_id = s.player_id AND si.provider = 'mlb-stats-api' AND si.entity_kind = 'player'
         JOIN seasons se ON se.id = s.season_id ORDER BY si.external_id`,
    )).rows as { player: string; level_code: string; pa: number; hits: number; year: number }[];
  try {
    await t.test("first apply writes one row per player, season and level", async () => {
      const r = await ingest(capture("2026-11-28T10:00:00Z"), sink);
      assert.equal(r.status, "applied");
      const got = await rows();
      assert.deepEqual(got.map((x) => [x.player, x.level_code, x.year]), [["9101", "aaa", 2014], ["9102", "aaa", 2014], ["9103", "single-a", 2014]]);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM player_pitching_level_seasons")).rows[0].n, 1);
    });
    await t.test("an identical replay changes nothing", async () => {
      const r = await ingest(capture("2026-11-28T11:00:00Z"), sink);
      assert.equal(r.status, "applied");
      assert.equal(r.changed, 0);
    });
    await t.test("a later correction updates the row in place", async () => {
      const r = await ingest(capture("2026-11-28T12:00:00Z", (f) => (f.hitting[11][0] = hitter(9101, { hits: 95 }))), sink);
      assert.equal(r.status, "applied");
      assert.equal(r.changed, 1);
      const got = await rows();
      assert.equal(got.length, 3);
      assert.equal(got.find((x) => x.player === "9101")!.hits, 95);
    });
    await t.test("an older capture is rejected and rolls back", async () => {
      await assert.rejects(ingest(capture("2026-11-28T09:00:00Z", (f) => (f.hitting[11][0] = hitter(9101, { hits: 80 }))), sink), /stale-snapshot/);
      assert.equal((await rows()).find((x) => x.player === "9101")!.hits, 95);
    });
    await t.test("stored players are referenced with their existing internal ids", async () => {
      const before = (await client.query("SELECT internal_id FROM source_identities WHERE provider='mlb-stats-api' AND entity_kind='player' AND external_id='9101'")).rows[0].internal_id;
      const r = await ingest(capture("2026-11-28T13:00:00Z", () => {}, [9101, 9102, 9103, 9201]), sink);
      assert.equal(r.status, "applied");
      const after = (await client.query("SELECT internal_id FROM source_identities WHERE provider='mlb-stats-api' AND entity_kind='player' AND external_id='9101'")).rows[0].internal_id;
      assert.equal(after, before);
      assert.equal((await rows()).length, 3);
    });
    await t.test("a malformed row is quarantined and the rest applied", async () => {
      const r = await ingest(capture("2026-11-28T14:00:00Z", (f) => (f.hitting[14] = [hitter(9103, { hits: 999 })])), sink);
      assert.equal(r.status, "applied-with-quarantine");
      assert.equal(r.issues, 1);
      assert.equal((await rows()).find((x) => x.player === "9103")!.hits, 90, "the stored row is kept, not overwritten by the malformed one");
    });
  } finally {
    await sink.close();
    await client.end();
  }
});
