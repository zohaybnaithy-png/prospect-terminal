import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { checkWebRole, checkWriterRole, withClient } from "./ops/check-db-roles";

/**
 * The checked-in role SQL (deploy/neon-readonly-role.sql, deploy/neon-writer-role.sql), applied to a
 * DISPOSABLE migrated database, gives exactly the intended permissions, and the checker catches a
 * widened grant. Roles are renamed (pt_web_test / pt_ingest_test) so nothing real can clash.
 *   createdb prospect_roles_test && DATABASE_URL=… npm run db:migrate
 *   ROLES_TEST_DATABASE_URL=postgres://<owner>@…/prospect_roles_test npm run test:roles:db
 */
test("database roles from the checked-in SQL", async (t) => {
  const url = process.env.ROLES_TEST_DATABASE_URL;
  if (!url || new URL(url).pathname !== "/prospect_roles_test")
    throw new Error("Use a fresh migrated prospect_roles_test database via ROLES_TEST_DATABASE_URL (as its owner)");
  const owner = new Client({ connectionString: url });
  await owner.connect();
  t.after(() => owner.end());
  const ownerName = (await owner.query<{ u: string }>("SELECT current_user AS u")).rows[0].u;
  const sql = (file: string, role: string) =>
    readFileSync(new URL(`../deploy/${file}`, import.meta.url), "utf8")
      .split("-- Verify")[0]
      .replace(/\bpt_web\b/g, "pt_web_test")
      .replace(/\bpt_ingest\b/g, role)
      .replace(/\bneondb_owner\b/g, ownerName)
      .replace(/DATABASE neondb\b/g, "DATABASE prospect_roles_test")
      .replace(/REPLACE_WITH_A_LONG_RANDOM_PASSWORD/g, "local-test-only");
  for (const r of ["pt_web_test", "pt_ingest_test"])
    await owner.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN EXECUTE 'DROP OWNED BY ${r}'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$`);
  await owner.query(sql("neon-readonly-role.sql", "pt_ingest_test"));
  await owner.query(sql("neon-writer-role.sql", "pt_ingest_test"));
  t.after(async () => {
    for (const r of ["pt_web_test", "pt_ingest_test"]) await owner.query(`DROP OWNED BY ${r}; DROP ROLE ${r}`).catch(() => {});
  });
  const as = (role: string) => {
    const u = new URL(url);
    u.username = role;
    u.password = "local-test-only";
    return u.toString();
  };
  const failing = (checks: { ok: boolean; check: string }[]) => checks.filter((c) => !c.ok).map((c) => c.check);

  await t.test("the web role passes every check", async () => {
    assert.deepEqual(failing(await withClient(as("pt_web_test"), checkWebRole)), []);
  });
  await t.test("the writer role passes every check (and writes nothing)", async () => {
    const before = (await owner.query("SELECT count(*)::int AS n FROM ingestion_runs")).rows[0].n;
    assert.deepEqual(failing(await withClient(as("pt_ingest_test"), checkWriterRole)), []);
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM ingestion_runs")).rows[0].n, before);
    assert.equal((await owner.query("SELECT to_regclass('public.pt_role_probe') AS t")).rows[0].t, null, "the CREATE probe left nothing");
  });
  await t.test("the web role checked as a writer fails (it cannot write)", async () => {
    assert.ok(failing(await withClient(as("pt_web_test"), checkWriterRole)).includes("SELECT/INSERT/UPDATE/DELETE on every app table"));
  });
  await t.test("a widened web grant is caught", async () => {
    await owner.query("GRANT INSERT ON ingestion_issues TO pt_web_test");
    assert.deepEqual(failing(await withClient(as("pt_web_test"), checkWebRole)), ["no write privilege on any table"]);
    await owner.query("REVOKE INSERT ON ingestion_issues FROM pt_web_test");
  });
  await t.test("a widened writer grant (DDL, TRUNCATE) is caught", async () => {
    await owner.query("GRANT CREATE ON SCHEMA public TO pt_ingest_test; GRANT TRUNCATE ON ingestion_issues TO pt_ingest_test");
    const f = failing(await withClient(as("pt_ingest_test"), checkWriterRole));
    assert.ok(f.includes("no CREATE in schema public") && f.includes("no TRUNCATE") && f.includes("a CREATE TABLE is refused"), f.join(", "));
    await owner.query("REVOKE CREATE ON SCHEMA public FROM pt_ingest_test; REVOKE TRUNCATE ON ingestion_issues FROM pt_ingest_test");
  });
  await t.test("the real refresh job can run as the writer role (lock, recovery, freshness)", async () => {
    const { runRefreshJob, DEFAULT_REFRESH } = await import("../src/ingestion/refresh/job");
    const { PgJobLock } = await import("../src/ingestion/refresh/lock");
    const { pipelineSteps } = await import("../src/ingestion/refresh/steps");
    const { lastStructureAppliedAt, recoverAbandonedRuns, readFreshnessFacts, assessFreshness } = await import("../src/ingestion/refresh/freshness");
    const { milbFixtureFetch } = await import("../src/ingestion/fixtures/milb-synthetic");
    const { Pool } = await import("pg");
    const writerUrl = as("pt_ingest_test");
    const pool = new Pool({ connectionString: writerUrl, max: 2 });
    const NOW = new Date("2026-05-15T12:00:00Z");
    try {
      const lock = new PgJobLock(writerUrl);
      const r = await runRefreshJob({ season: 2026, sources: ["milb"], apply: true, force: false, ...DEFAULT_REFRESH }, {
        lock,
        steps: pipelineSteps({ url: writerUrl, season: 2026, apply: true, fetcher: milbFixtureFetch().fetcher, sleep: async () => {}, clock: () => NOW }),
        lastStructureAppliedAt: () => lastStructureAppliedAt(pool, 2026),
        recoverAbandoned: (ms) => recoverAbandonedRuns(pool, ms),
        lockLost: lock.lostSignal,
        clock: () => NOW,
      });
      assert.ok(r.status === "ok" || r.status === "ok-with-quarantine", JSON.stringify(r.steps));
      // ...and the web role can read what it wrote, through the same freshness queries.
      const webPool = new Pool({ connectionString: as("pt_web_test"), max: 1 });
      try {
        const f = assessFreshness(await readFreshnessFacts(webPool, { season: 2026, now: NOW, abandonedAfterMs: DEFAULT_REFRESH.abandonedAfterMs }));
        assert.equal(f.levels.find((l) => l.level === "aa")?.latestGame, "2026-05-12");
      } finally {
        await webPool.end();
      }
    } finally {
      await pool.end();
    }
  });
});
