import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { AflFixtureAdapter } from "../src/ingestion/sources/afl-fixture";
import { ingest } from "../src/ingestion/runner";
import { buildPlan, fingerprint } from "../src/ingestion/plan";
import { recordSchema } from "../src/ingestion/contracts";
import { fetchJson } from "../src/ingestion/http";
const adapter = () =>
  new AflFixtureAdapter(resolve("src/ingestion/fixtures/afl.json"));
test("AFL proof is a complete offline dry-run with distinct source and internal identity namespaces", async () => {
  const a = adapter();
  const report = await ingest(a);
  assert.equal(report.status, "dry-run");
  assert.equal(report.records, 24);
  assert.equal(report.issues, 0);
  const snapshot = await a.load();
  const plan = buildPlan(a.normalize(snapshot));
  assert.equal(plan.records[0].kind, "league");
  assert.equal(plan.records.at(-1)!.kind, "pitchingGame");
  assert.ok(
    plan.records
      .filter((r) => r.kind === "team")
      .every((r) => r.organization === null),
  );
  const people = plan.records.filter((r) => r.kind === "player");
  assert.equal(people.length, 3);
  assert.ok(people.every((p) => p.externalId.startsWith("person-")));
});
test("unknown/partial counts and impossible baseball lines are quarantined, never filled with zero", () => {
  const complete = {
    kind: "battingGame",
    key: "line",
    player: "p",
    team: "t",
    game: "g",
    stats: {
      plateAppearances: 4,
      atBats: 4,
      hits: 2,
      doubles: 1,
      triples: 0,
      homeRuns: 0,
      walks: 0,
      strikeouts: 1,
      hitByPitch: 0,
      sacrificeFlies: 0,
      stolenBases: 0,
    },
  };
  assert.equal(recordSchema.safeParse(complete).success, true);
  assert.equal(
    recordSchema.safeParse({ ...complete, stats: { atBats: 4, hits: 2 } })
      .success,
    false,
  );
  assert.equal(
    recordSchema.safeParse({
      ...complete,
      stats: { ...complete.stats, hits: 5 },
    }).success,
    false,
  );
  assert.equal(
    recordSchema.safeParse({
      kind: "organizationMembership",
      key: "m",
      player: "p",
      organization: "o",
      startsOn: "2026-10-20",
      endsOn: "2026-10-01",
    }).success,
    false,
  );
});
test("conflicting provider identities quarantine duplicates and dependent rows regardless of ordering", async () => {
  const a = adapter();
  const batch = a.normalize(await a.load());
  const player = batch.records.find((r) => r.kind === "player")!;
  assert.equal(player.kind, "player");
  const plan = buildPlan({
    records: [
      ...batch.records,
      { ...player, name: "Different person" },
    ].reverse(),
    issues: [],
  });
  assert.ok(plan.issues.some((i) => i.code === "duplicate-key"));
  assert.ok(plan.issues.some((i) => i.code === "missing-reference"));
  assert.ok(
    !plan.records.some(
      (r) => r.kind === "player" && r.externalId === player.externalId,
    ),
  );
  const dedup = buildPlan({ records: [...batch.records, player], issues: [] });
  assert.equal(dedup.records.length, 24);
  assert.equal(dedup.issues.length, 0);
});
test("stat team mismatch is rejected and roster observations require no invented transaction date", async () => {
  const a = adapter();
  const b = a.normalize(await a.load());
  const game = b.records.find((r) => r.kind === "game")!;
  assert.equal(game.kind, "game");
  const plan = buildPlan({
    records: b.records.map((r) =>
      r.kind === "game" ? { ...r, awayTeam: r.homeTeam } : r,
    ),
    issues: [],
  });
  assert.ok(plan.issues.some((i) => i.code === "inconsistent-game"));
  assert.equal(
    recordSchema.safeParse({
      kind: "rosterObservation",
      key: "roster",
      player: "person",
      team: "fall",
      organization: null,
    }).success,
    true,
  );
  assert.equal(
    recordSchema.safeParse({
      kind: "teamMembership",
      key: "stint",
      player: "person",
      team: "fall",
      season: "2026",
      endsOn: null,
      assignmentType: "afl-assignment",
    }).success,
    false,
  );
});
test("incremental plans may reference reviewed stored identities; names never resolve missing identities", () => {
  const row = recordSchema.parse({
    kind: "rosterObservation",
    key: "roster",
    player: "person",
    team: "fall",
    organization: null,
  });
  assert.ok(buildPlan({ records: [row], issues: [] }).issues.length);
  assert.equal(
    buildPlan(
      { records: [row], issues: [] },
      new Set(["player:person", "team:fall"]),
    ).issues.length,
    0,
  );
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});
test("adapter identity/version mismatches cannot silently become a different source", async () => {
  const a = adapter();
  await assert.rejects(
    () =>
      ingest({
        id: "other",
        version: a.version,
        load: () => a.load(),
        normalize: (s) => a.normalize(s),
      }),
    /identity\/version mismatch/,
  );
});
test("HTTP transport has bounded retries, refuses permanent errors/HTML/oversize and preserves TLS semantics", async () => {
  const responses = [
    new Response("limited", { status: 429, headers: { "retry-after": "999" } }),
    new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    }),
  ];
  let calls = 0;
  const waits: number[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    assert.equal(init?.redirect, "error");
    calls++;
    return responses.shift()!;
  };
  assert.deepEqual(
    await fetchJson(new URL("https://example.test/data"), {
      fetcher,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }),
    { ok: true },
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
  calls = 0;
  await assert.rejects(
    () =>
      fetchJson(new URL("https://example.test/data"), {
        fetcher: async () => {
          calls++;
          return new Response("denied", { status: 403 });
        },
      }),
    /HTTP 403/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      fetchJson(new URL("https://example.test/data"), {
        fetcher: async () => new Response("<html/>"),
      }),
    /not JSON/,
  );
  await assert.rejects(
    () =>
      fetchJson(new URL("https://example.test/data"), {
        maxBytes: 3,
        fetcher: async () =>
          new Response('{"a":1}', {
            headers: { "content-type": "application/json" },
          }),
      }),
    /size limit/,
  );
  await assert.rejects(
    () => fetchJson(new URL("http://example.test/data")),
    /HTTPS/,
  );
});

test("AFL normalization refuses a single parent organization on a shared fall team", async () => {
  const a = adapter();
  const snapshot = await a.load();
  const payload = snapshot.payload as { records: Record<string, unknown>[] };
  payload.records.find((r) => r.entity === "team")!.organization = "org-1";
  assert.ok(
    a
      .normalize(snapshot)
      .issues.some((i) => i.message.includes("single parent organization")),
  );
});
