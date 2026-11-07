/**
 * Write-target guard for guarded ingestion runs (the MiLB backfill). Stricter than the read-only
 * helper (scripts/ops/pg-readonly.mjs): the connection string must name exactly the approved Neon
 * endpoint and database, use a certificate-verifying sslmode, and carry no parameter outside a
 * small allow-list (so nothing can redirect the host, weaken TLS or change session settings).
 *
 * Errors never include the connection string or any part of its credentials.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export class TargetGuardError extends Error {}

export interface WriteTarget {
  endpoint: string;
  database: string;
}

export interface CheckedTarget {
  endpoint: string;
  database: string;
  pooled: boolean;
  sslmode: string;
}

/** Parameters a Neon connection string may carry. Everything else (host, options, sslrootcert,
 * sslcert, sslkey, uselibpqcompat, ssl, application_name, …) is refused. */
const ALLOWED_PARAMS: Record<string, readonly string[]> = {
  sslmode: ["require", "verify-full"],
  channel_binding: ["require", "prefer"],
};

/** Validates a writer connection string against the approved target. Returns safe facts only. */
export function checkWriteTarget(url: string | undefined, expected: WriteTarget): CheckedTarget {
  if (!expected.endpoint || !/^ep-[a-z0-9-]+$/.test(expected.endpoint))
    throw new TargetGuardError("expected endpoint is not configured");
  if (!expected.database) throw new TargetGuardError("expected database is not configured");
  if (!url) throw new TargetGuardError("INGESTION_DATABASE_URL is not set");
  if (/\s/.test(url)) throw new TargetGuardError("connection string contains whitespace");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new TargetGuardError("connection string is not a valid URL");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:")
    throw new TargetGuardError("connection string is not a postgres URL");
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || !host.endsWith(".neon.tech"))
    throw new TargetGuardError("host is not a Neon endpoint host");
  const label = host.split(".")[0];
  const pooled = label.endsWith("-pooler");
  const endpoint = pooled ? label.slice(0, -"-pooler".length) : label;
  if (endpoint !== expected.endpoint)
    throw new TargetGuardError(`endpoint ${endpoint} is not the approved endpoint ${expected.endpoint}`);
  if (u.port && u.port !== "5432") throw new TargetGuardError("unexpected port");
  if (!u.username || !u.password) throw new TargetGuardError("connection string has no credentials");
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (database !== expected.database)
    throw new TargetGuardError(`database ${database || "<none>"} is not ${expected.database}`);
  const seen = new Set<string>();
  for (const [key, value] of u.searchParams) {
    if (seen.has(key)) throw new TargetGuardError(`repeated parameter ${key}`);
    seen.add(key);
    const allowed = ALLOWED_PARAMS[key];
    if (!allowed) throw new TargetGuardError(`connection parameter ${key} is not allowed`);
    if (!allowed.includes(value)) throw new TargetGuardError(`${key}=${value} is not allowed`);
  }
  const sslmode = u.searchParams.get("sslmode");
  if (!sslmode) throw new TargetGuardError("connection string must set sslmode=require or verify-full");
  return { endpoint, database, pooled, sslmode };
}

export interface ExpectedMigration {
  tag: string;
  hash: string;
  createdAt: number;
}

/** Migrations as drizzle records them: sha256 of each checked-in SQL file, `when` from the journal. */
export function expectedMigrations(drizzleDir: string): ExpectedMigration[] {
  const journal = JSON.parse(readFileSync(join(drizzleDir, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  return journal.entries.map((e) => ({
    tag: e.tag,
    hash: createHash("sha256").update(readFileSync(join(drizzleDir, `${e.tag}.sql`), "utf8")).digest("hex"),
    createdAt: e.when,
  }));
}

/** Public tables the checked-in migrations create. */
export function expectedTables(drizzleDir: string): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(drizzleDir).filter((f) => f.endsWith(".sql")))
    for (const m of readFileSync(join(drizzleDir, file), "utf8").matchAll(/CREATE TABLE "([a-z_]+)"/g))
      names.add(m[1]);
  return [...names].sort();
}

export interface ServerFacts {
  database: string;
  schema: string;
  migrations: { hash: string; createdAt: number | string }[] | null;
  tables: string[] | null;
}

/** Compares server facts with the checked-in schema; returns problems (empty = matches). */
export function schemaProblems(
  facts: ServerFacts,
  expected: { database: string; migrations: ExpectedMigration[]; tables: string[] },
): string[] {
  const problems: string[] = [];
  if (facts.database !== expected.database)
    problems.push(`connected database is ${facts.database}, expected ${expected.database}`);
  if (facts.schema !== "public") problems.push(`current schema is ${facts.schema}, expected public`);
  const applied = facts.migrations ?? [];
  if (applied.length !== expected.migrations.length)
    problems.push(`expected ${expected.migrations.length} migrations, found ${applied.length}`);
  expected.migrations.forEach((m, i) => {
    const a = applied[i];
    if (a && (a.hash !== m.hash || Number(a.createdAt) !== m.createdAt))
      problems.push(`migration ${m.tag} does not match the checked-in file`);
  });
  const tables = new Set(facts.tables ?? []);
  const missing = expected.tables.filter((t) => !tables.has(t));
  const extra = [...tables].filter((t) => !expected.tables.includes(t));
  if (missing.length) problems.push(`missing tables: ${missing.join(", ")}`);
  if (extra.length) problems.push(`unexpected tables: ${extra.join(", ")}`);
  return problems;
}
