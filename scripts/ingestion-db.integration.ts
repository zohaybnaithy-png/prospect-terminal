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
