/**
 * Verifies the two database roles a deployment uses, from the host that uses them, without changing
 * anything (docs/NEON-STAGING.md). Every probe runs inside a transaction that is rolled back.
 *
 *   PT_WEB_DATABASE_URL=…    npm run -s check:db-roles      # the web server's read-only role
 *   PT_WRITER_DATABASE_URL=… npm run -s check:db-roles      # the ingestion writer role
 *   (either or both; exit 0 = every check passed, 1 = a check failed, 2 = could not connect)
 *
 * Web role (deploy/neon-readonly-role.sql): not privileged; sessions read-only by default; SELECT on
 * every app table and no INSERT/UPDATE/DELETE/TRUNCATE; an actual UPDATE is refused.
 * Writer role (deploy/neon-writer-role.sql): not privileged; SELECT/INSERT/UPDATE/DELETE on every app
 * table, no TRUNCATE, no CREATE in the schema, owns no table; an UPDATE that matches nothing
 * succeeds and a CREATE TABLE is refused (both rolled back); advisory locks work.
 * Never prints the connection strings.
 */
import { Client } from "pg";

export interface RoleCheck {
  check: string;
  ok: boolean;
  detail: string;
}

const APP_TABLES = `SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'`;

async function common(c: Client, out: RoleCheck[]) {
  const r = (
    await c.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; neon_super: boolean | null }>(
      `SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb,
              CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neon_superuser')
                   THEN pg_has_role(current_user, 'neon_superuser', 'member') END AS neon_super
       FROM pg_roles r WHERE r.rolname = current_user`,
    )
  ).rows[0];
  out.push({ check: "not superuser / createrole / createdb", ok: !r.rolsuper && !r.rolcreaterole && !r.rolcreatedb, detail: `${r.rolsuper}, ${r.rolcreaterole}, ${r.rolcreatedb}` });
  out.push({
    check: "not a member of neon_superuser",
    ok: r.neon_super !== true,
    detail: r.neon_super === null ? "no neon_superuser role here (not Neon)" : String(r.neon_super),
  });
}

/** Expects `errorExpected` to throw (inside a rolled-back transaction). */
async function probe(c: Client, sql: string): Promise<{ ok: boolean; code?: string }> {
  await c.query("BEGIN");
  try {
    await c.query(sql);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code };
  } finally {
    await c.query("ROLLBACK").catch(() => {});
  }
}

export async function checkWebRole(c: Client): Promise<RoleCheck[]> {
  const out: RoleCheck[] = [];
  await common(c, out);
  const ro = (await c.query<{ v: string }>("SELECT current_setting('default_transaction_read_only') AS v")).rows[0].v;
  out.push({ check: "sessions are read-only by default", ok: ro === "on", detail: `default_transaction_read_only=${ro}` });
  const p = (
    await c.query<{ tables: string; can_select: string; can_write: string }>(
      `SELECT count(*) AS tables,
              count(*) FILTER (WHERE has_table_privilege(oid, 'SELECT')) AS can_select,
              count(*) FILTER (WHERE has_table_privilege(oid, 'INSERT') OR has_table_privilege(oid, 'UPDATE')
                                  OR has_table_privilege(oid, 'DELETE') OR has_table_privilege(oid, 'TRUNCATE')) AS can_write
       FROM (${APP_TABLES}) t`,
    )
  ).rows[0];
  out.push({ check: "SELECT on every app table", ok: Number(p.tables) > 0 && p.can_select === p.tables, detail: `${p.can_select}/${p.tables}` });
  out.push({ check: "no write privilege on any table", ok: p.can_write === "0", detail: `${p.can_write} writable` });
  const w = await probe(c, "UPDATE ingestion_runs SET status = status WHERE false");
  out.push({ check: "an UPDATE is refused", ok: !w.ok, detail: w.ok ? "UPDATE was allowed" : `refused (${w.code})` });
  return out;
}

export async function checkWriterRole(c: Client): Promise<RoleCheck[]> {
  const out: RoleCheck[] = [];
  await common(c, out);
  const ro = (await c.query<{ v: string }>("SELECT current_setting('default_transaction_read_only') AS v")).rows[0].v;
  out.push({ check: "sessions can write", ok: ro === "off", detail: `default_transaction_read_only=${ro}` });
  const p = (
    await c.query<{ tables: string; can_write: string; can_truncate: string; owned: string; can_create: boolean }>(
      `SELECT count(*) AS tables,
              count(*) FILTER (WHERE has_table_privilege(oid, 'SELECT') AND has_table_privilege(oid, 'INSERT')
                                 AND has_table_privilege(oid, 'UPDATE') AND has_table_privilege(oid, 'DELETE')) AS can_write,
              count(*) FILTER (WHERE has_table_privilege(oid, 'TRUNCATE')) AS can_truncate,
              count(*) FILTER (WHERE pg_get_userbyid((SELECT relowner FROM pg_class WHERE pg_class.oid = t.oid)) = current_user) AS owned,
              has_schema_privilege('public', 'CREATE') AS can_create
       FROM (${APP_TABLES}) t`,
    )
  ).rows[0];
  out.push({ check: "SELECT/INSERT/UPDATE/DELETE on every app table", ok: Number(p.tables) > 0 && p.can_write === p.tables, detail: `${p.can_write}/${p.tables}` });
  out.push({ check: "no TRUNCATE", ok: p.can_truncate === "0", detail: `${p.can_truncate} truncatable` });
  out.push({ check: "owns no table (cannot ALTER/DROP)", ok: p.owned === "0", detail: `${p.owned} owned` });
  out.push({ check: "no CREATE in schema public", ok: !p.can_create, detail: String(p.can_create) });
  const u = await probe(c, "UPDATE ingestion_runs SET status = status WHERE false");
  out.push({ check: "an UPDATE (matching nothing, rolled back) is allowed", ok: u.ok, detail: u.ok ? "allowed" : `refused (${u.code})` });
  const d = await probe(c, "CREATE TABLE public.pt_role_probe (x int)");
  out.push({ check: "a CREATE TABLE is refused", ok: !d.ok, detail: d.ok ? "CREATE TABLE was allowed" : `refused (${d.code})` });
  const l = (await c.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('prospect-terminal:role-probe', 0)) AS ok")).rows[0].ok;
  await c.query("SELECT pg_advisory_unlock(hashtextextended('prospect-terminal:role-probe', 0))");
  out.push({ check: "advisory locks work (job lock)", ok: l, detail: String(l) });
  return out;
}

export async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 15_000, application_name: "pt-check-db-roles" });
  c.on("error", () => {});
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

async function main() {
  const web = process.env.PT_WEB_DATABASE_URL, writer = process.env.PT_WRITER_DATABASE_URL;
  if (!web && !writer) throw new Error("set PT_WEB_DATABASE_URL and/or PT_WRITER_DATABASE_URL");
  const report: Record<string, RoleCheck[]> = {};
  if (web) report.web = await withClient(web, checkWebRole);
  if (writer) report.writer = await withClient(writer, checkWriterRole);
  const ok = Object.values(report).every((checks) => checks.every((x) => x.ok));
  process.stdout.write(`${JSON.stringify({ ok, ...report }, null, 2)}\n`);
  for (const [role, checks] of Object.entries(report))
    for (const x of checks) if (!x.ok) process.stderr.write(`[check-db-roles] FAIL ${role}: ${x.check} (${x.detail})\n`);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && /check-db-roles\.ts$/.test(process.argv[1]))
  main().catch((error: unknown) => {
    process.stderr.write(`[check-db-roles] could not check: ${(error as { code?: string }).code ?? (error instanceof Error ? error.name : "error")}\n`);
    process.exitCode = 2;
  });
