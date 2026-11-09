import { Client } from "pg";
import type { JobLock } from "./job";

/**
 * Job-wide mutual exclusion for writers: a PostgreSQL session advisory lock, held on a dedicated
 * connection for the whole job. It protects across processes and machines (scheduled job, manual
 * `ingest:*` applies, a second timer), and it is released by the server the moment the holding
 * connection closes, so a killed or crashed job never leaves a stale lock behind.
 *
 * It is NOT the per-transaction source lock the writer already takes
 * (`pg_advisory_xact_lock(hashtextextended(provider, 0))` in PostgresIngestionSink): that one
 * serializes individual applies; this one stops two jobs from running (and fetching) at once.
 *
 * Session locks need a session-pinned connection. A transaction-mode pooler (Neon's `-pooler`
 * endpoint is PgBouncer in transaction mode) may run each statement on a different server
 * connection, so the lock is always taken on the DIRECT endpoint: Neon's pooled host
 * `ep-x-pooler.region…` becomes `ep-x.region…` (same credentials, same database).
 */
export const JOB_LOCK_NAME = "prospect-terminal:ingestion-job";

export function directConnectionString(url: string): string {
  const u = new URL(url);
  const host = u.hostname.replace(/^(ep-[a-z0-9-]+?)-pooler\./, "$1.");
  if (host === u.hostname) return url;
  u.hostname = host;
  return u.toString();
}

export class PgJobLock implements JobLock {
  private client: Client | null = null;
  private readonly lost = new AbortController();
  /** Aborted if the lock's connection fails while held (the lock is gone; the job must stop). */
  readonly lostSignal = this.lost.signal;

  constructor(private readonly url: string) {}

  async acquire(): Promise<boolean> {
    const client = new Client({
      connectionString: directConnectionString(this.url),
      application_name: "pt-ingestion-job-lock",
      keepAlive: true,
      connectionTimeoutMillis: 15_000,
    });
    // An error on an idle client would otherwise be thrown asynchronously and crash the process.
    client.on("error", () => this.lost.abort(new Error("ingestion job lock connection lost")));
    await client.connect();
    try {
      const r = await client.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
        [JOB_LOCK_NAME],
      );
      if (!r.rows[0]?.ok) {
        await client.end();
        return false;
      }
      this.client = client;
      return true;
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  }

  async release(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      // After a lost connection there is nothing to unlock: the server released the lock when the
      // session ended. Release must never throw, or the job's outcome would be lost.
      if (!this.lost.signal.aborted)
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [JOB_LOCK_NAME]).catch(() => {});
    } finally {
      // Closing the session releases the lock even if the unlock statement failed.
      await client.end().catch(() => {});
    }
  }
}

/**
 * For manual writers (`ingest:milb --apply`, `ingest:afl --apply`, `backfill:milb --apply`): take the
 * job lock or refuse, so a manual run never overlaps the scheduled job (or another manual run).
 * Returns the release function.
 */
export async function requireJobLock(url: string): Promise<() => Promise<void>> {
  const lock = new PgJobLock(url);
  if (!(await lock.acquire()))
    throw new Error(
      "Another ingestion job holds the database job lock (scheduled refresh or a manual apply); try again when it has finished",
    );
  return () => lock.release();
}

/**
 * How long the current holder of the job lock has held it (ms), from pg_stat_activity: every holder
 * connects with application_name 'pt-ingestion-job-lock' just before taking the lock and closes the
 * connection right after releasing it. Null when no holder is visible (e.g. a role that cannot see
 * other sessions).
 */
export async function lockHolderAgeMs(query: (sql: string) => Promise<{ rows: { age_ms: string | number | null }[] }>): Promise<number | null> {
  const r = await query(
    `SELECT (extract(epoch FROM now() - min(backend_start)) * 1000)::bigint AS age_ms
     FROM pg_stat_activity WHERE application_name = 'pt-ingestion-job-lock' AND pid <> pg_backend_pid()`,
  );
  const v = r.rows[0]?.age_ms;
  return v === null || v === undefined ? null : Number(v);
}
