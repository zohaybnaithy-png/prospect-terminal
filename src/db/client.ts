import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { z } from "zod";
import { instrumentPool } from "./instrument";
import * as schema from "./schema";

const databaseUrl = z
  .string()
  .url()
  .refine(
    (url) => /^postgres(ql)?:/.test(url),
    "Use a PostgreSQL connection URL",
  );

/**
 * Bounds for the site's pool. Without them a request could wait indefinitely: pg's defaults are
 * no connect/acquire timeout and no read timeout.
 * - max 6: one connection per competition level loading in parallel, plus one for the version
 *   probe of a background refresh that can start while levels are still loading.
 * - connectionTimeoutMillis: opening a connection (TCP + TLS + auth) or waiting for a free one.
 * - keepAlive: TCP keepalive so a silently dropped connection is detected instead of hanging.
 * - idleTimeoutMillis: data stays in memory between reloads, so idle connections are released.
 */
export const DB_POOL_OPTIONS = {
  max: 6,
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 10_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
} satisfies PoolConfig;

/**
 * A query still running after this long has its connection closed by the watchdog
 * (src/db/instrument.ts). The slowest normal statement is a level's batting lines: ~0.1 s on the
 * server and a few seconds of transfer on a slow (~1 MB/s) link.
 */
export const QUERY_DEADLINE_MS = 45_000;

/**
 * A query whose connection receives nothing for this long, counted in time the process was free to
 * read it (event-loop idle, so CPU-heavy startup work does not count), is treated as stalled and
 * closed (see
 * src/db/instrument.ts for the measurements behind it: healthy transfers pause < 1 s; degraded
 * connections paused 4.5-18 s). Covers server execution too: the slowest level statement runs in
 * ~0.1 s on the server and statement_timeout is 30 s, but no level statement legitimately runs
 * silent for 8 s.
 */
export const QUERY_STALL_MS = 8_000;

/**
 * A query that has been receiving for 6 s at under 50 kB/s (both measured in event-loop idle time,
 * not wall time: a busy process cannot read its socket) is on a degraded connection and is
 * closed (then retried on a fresh one). Healthy level queries ran at >=127 kB/s and finished in
 * <=4.1 s on a ~1 MB/s home link; degraded ones ran at 10-19 kB/s for 20-45 s.
 */
export const QUERY_SLOW_AFTER_MS = 6_000;
export const QUERY_MIN_BYTES_PER_SEC = 50_000;

// One pool per server process: Next.js bundles src/instrumentation.ts separately from the routes,
// and a module-level variable would give each bundle its own pool.
const POOL_KEY = Symbol.for("prospect-terminal.pg-pool");
const slots = globalThis as typeof globalThis & { [POOL_KEY]?: Pool };

/** Lazy initialization: importing this module never opens a connection. */
export function getDatabase() {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL is required for database operations. The demo UI does not require it.",
    );
  const connectionString = databaseUrl.parse(process.env.DATABASE_URL);
  let pool = slots[POOL_KEY];
  if (!pool) {
    pool = new Pool({ ...DB_POOL_OPTIONS, connectionString });
    // An idle client's socket error would otherwise be an unhandled 'error' event.
    pool.on("error", () => {});
    instrumentPool(pool, {
      queryDeadlineMs: QUERY_DEADLINE_MS,
      stallMs: QUERY_STALL_MS,
      slowAfterMs: QUERY_SLOW_AFTER_MS,
      minBytesPerSec: QUERY_MIN_BYTES_PER_SEC,
      onDeadline: (label, ms, reason) =>
        console.error(`[db] closed a ${reason} ${label} query after ${(ms / 1000).toFixed(1)}s`),
    });
    slots[POOL_KEY] = pool;
  }
  return drizzle(pool, { schema });
}
export async function closeDatabase() {
  await slots[POOL_KEY]?.end();
  slots[POOL_KEY] = undefined;
}
