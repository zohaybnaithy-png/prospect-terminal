/**
 * Read-only performance profile of the site's data layer on the Neon TEST branch.
 *
 *   npm run -s profile:site > ~/pt-runs/site-profile.json
 *   PROFILE_ROUNDS=10 PROFILE_SKIP_SEQUENTIAL=1 PROFILE_SKIP_PAGES=1 npm run -s profile:site
 *
 * Each round opens a fresh pool (like a server cold start) and loads every level in parallel, as
 * the site does; the first round can also load each level alone first. Every level load is traced
 * (src/db/instrument.ts): pool acquire, per-query first byte / transfer / client parse, decode and
 * warm-up compute, so a slow load shows whether the time went to the database, the network, the
 * pool or the application. Page view-model compute is profiled on the last round's data.
 *
 * Sessions are forced read-only at the server; credentials are never printed.
 */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../src/db/schema";
import { instrumentPool, summarizeTrace, type LoadTrace } from "../../src/db/instrument";
import { checkWriteTarget } from "../../src/ingestion/db-target";
import { redact } from "../../src/ingestion/progress";
import { dbLevelLoader, loadCompetition, tracedLevelLoader } from "../../src/services/competition/load";
import { prepareSnapshot } from "../../src/services/competition/prepare";
import { LEVEL_IDS } from "../../src/services/players/levels";
import { profilePages } from "../../src/services/competition/profile";
import {
  DB_POOL_OPTIONS,
  QUERY_DEADLINE_MS,
  QUERY_MIN_BYTES_PER_SEC,
  QUERY_SLOW_AFTER_MS,
  QUERY_STALL_MS,
} from "../../src/db/client";

const APPROVED_ENDPOINT = "ep-spring-cake-ak5jqlqp";
const SEASON = 2026;

for (const key of Object.keys(process.env))
  if (key === "DATABASE_URL" || key.startsWith("PG")) delete process.env[key];

const secs = (ms: number) => Math.round(ms) / 1000;

async function main() {
  const url = process.env.INGESTION_DATABASE_URL;
  checkWriteTarget(url, { endpoint: APPROVED_ENDPOINT, database: "neondb" });
  const rounds = Number(process.env.PROFILE_ROUNDS ?? 1);
  const traces: { round: number; phase: string; level: string; ok: boolean; totalMs: number; trace: LoadTrace }[] = [];
  const rows: { round: number; sequential: Record<string, number>; parallel: number }[] = [];
  let last: Awaited<ReturnType<typeof loadCompetition>> | undefined;
  for (let round = 1; round <= rounds; round++) {
    const pool = new Pool({
      ...DB_POOL_OPTIONS,
      connectionString: url,
      options: "-c default_transaction_read_only=on",
    });
    const stop = instrumentPool(pool, {
      queryDeadlineMs: QUERY_DEADLINE_MS,
      stallMs: QUERY_STALL_MS,
      slowAfterMs: QUERY_SLOW_AFTER_MS,
      minBytesPerSec: QUERY_MIN_BYTES_PER_SEC,
      onDeadline: (label, ms, reason) =>
        process.stderr.write(`[profile] watchdog closed a ${reason} ${label} after ${secs(ms)}s\n`),
    });
    try {
      let phase = "sequential";
      const loader = tracedLevelLoader(dbLevelLoader(drizzle(pool, { schema }), SEASON), {
        prepare: (_l, s) => s && prepareSnapshot(s),
        onTrace: (trace, totalMs, ok) => {
          traces.push({ round, phase, level: trace.name, ok, totalMs: secs(totalMs), trace });
          process.stderr.write(`[profile] r${round} ${phase} ${ok ? "" : "FAILED "}${summarizeTrace(trace, totalMs)}\n`);
        },
      });
      const sequential: Record<string, number> = {};
      if (round === 1 && !process.env.PROFILE_SKIP_SEQUENTIAL)
        for (const level of LEVEL_IDS) {
          const t = performance.now();
          await loader(level).catch(() => null);
          sequential[level] = secs(performance.now() - t);
        }
      phase = "parallel";
      const t = performance.now();
      last = await loadCompetition(loader);
      const parallel = secs(performance.now() - t);
      process.stderr.write(`[profile] r${round} all levels in parallel: ${parallel}s\n`);
      rows.push({ round, sequential, parallel });
    } finally {
      stop();
      await pool.end();
    }
  }
  const pages = last && !process.env.PROFILE_SKIP_PAGES ? profilePages(last) : undefined;
  // Memory held with every level loaded and its view models warmed (run with --expose-gc for a
  // post-collection figure). `last` is still referenced, so its snapshots are counted.
  (globalThis as { gc?: () => void }).gc?.();
  const m = process.memoryUsage();
  const memoryMB = { rss: Math.round(m.rss / 1e6), heapUsed: Math.round(m.heapUsed / 1e6), levels: last?.status === "ok" ? last.levels.length : 0 };
  process.stderr.write(`[profile] memory with all levels loaded: rss ${memoryMB.rss} MB, heap ${memoryMB.heapUsed} MB\n`);
  process.stdout.write(`${JSON.stringify({ season: SEASON, rounds: rows, traces, pages, memoryMB }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`[profile] ${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 2;
});
