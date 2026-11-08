# Deployment

Nothing is deployed yet. This is the recommended configuration for the site's current data
architecture, and the reasons for it. Measurements are from the Neon test branch (2026 season,
5 levels, about 8.4k games and 222k stat lines) on a home connection, unless stated otherwise.

## Recommendation: one persistent Node.js server, next to the database

Run `next build` and then `next start` as one long-running process. Use a container or VM on
Fly.io, Railway, Render, ECS or similar, in the same AWS region as the Neon database. The test
branch is in `us-west-2`.

| Setting | Value | Why |
|---|---|---|
| Instances | 1 (2 for redundancy at most) | Each process holds its own copy of all levels and loads it at start |
| Memory | ≥ 2 GB | ~325 MB heap and ~660 MB RSS with all levels loaded and warmed; two copies exist briefly during a reload |
| `NODE_OPTIONS` | `--max-old-space-size=1536` | Node's default heap cap on a small container can be below what a reload needs |
| CPU | 1 vCPU | Warm-up compute is about 0.5 s per MiLB level; requests are served from memory |
| Region | Same as Neon | Cold loads are transfer-bound: about 16 MB per process start |
| `DATABASE_URL` | A read-only role, if possible | The site only reads; its transactions are already `READ ONLY` |
| Health check | `GET /data` with a generous timeout | The first request after start can wait for the warm-up |
| `PT_DATA_TIMING` | Unset (`1` for diagnosis) | Slow (>15 s) and failed level loads are always logged |

At server start, `src/instrumentation.ts` begins loading every level in the background. Requests
arriving before it finishes share the same in-flight loads. After that, every page is served from
memory: 0.01–0.19 s server time on the production build. A one-row `ingestion_runs` probe runs at
most once a minute while there is traffic, and never while idle. A level reloads in the background
only when an ingestion run was applied, and the previous snapshot is served meanwhile. A Neon
compute that has scaled to zero is woken by that background probe, not by a waiting request.

## Why not serverless (for now)

The data layer is an in-memory, per-process cache. Serverless platforms (for example Vercel
Functions) break each of its assumptions:

- **Every cold instance repeats the full load.** That is about 16 MB from Neon plus about 2.5 s of
  warm-up compute. Concurrency spreads traffic across instances, so each one pays it, and each
  holds about 650 MB.
- **Background work after a response is not guaranteed.** A frozen instance never completes the
  stale-while-revalidate refresh, or completes it late.
- **Frozen instances pause timers.** The query watchdog tolerates pauses, but deadlines measured
  across a freeze are not meaningful.
- **Process-global state doesn't help.** The cache and connection pool are shared within one
  process, never across instances.

Serverless becomes reasonable after a data-architecture change: precomputed per-level aggregates
or view models in the database, or a shared cache. Then a request reads kilobytes instead of a
whole season. That is a separate change to discuss.

## Cold-load safety (any host)

Every level load is bounded, and failures are contained:

| Layer | Bound | Where |
|---|---|---|
| Connect / pool acquire | 15 s | `DB_POOL_OPTIONS.connectionTimeoutMillis` (`src/db/client.ts`) |
| Server execution | 30 s per statement | `SET LOCAL statement_timeout` in each read-only level transaction |
| No bytes received | 8 s of event-loop idle time → connection closed | Query watchdog (`src/db/instrument.ts`) |
| Degraded transfer | < 50 kB/s over 6 s of event-loop idle time → closed | Query watchdog |
| Any single query | 45 s wall time → closed | Query watchdog |
| Whole level load | 90 s → abandoned | `loadTimeoutMs` (`src/services/competition/cache.ts`) |

- **One retry:** a level whose connection the watchdog closed is retried once, on a fresh
  connection (`tracedLevelLoader`). Other failures are not retried.
- **Backoff on first load:** a failed first load backs off for 5 s, doubling up to 60 s. Requests in
  that window fail fast, and pages show that level as "temporarily unavailable" instead of each
  request starting a load.
- **Refresh failures:** a failed or timed-out background refresh keeps serving the previous
  snapshot.
- **Crash safety:** a socket error on a checked-out connection is handled, so it can't crash the
  process.

Measured diagnosis behind these bounds (instrumented, `npm run -s profile:site`):

- **Not the database:** the slow loads were not server execution, which took about 0.1 s for the
  largest statement.
- **Not Node:** pg parsing, decoding and warm-up are at most about 0.7 s.
- **Two causes:**
  1. **macOS idle sleep** during a long run. The process was suspended for 142 s, which matches
     the power log.
  2. **Degraded individual TCP connections:** 10–19 kB/s, with 1.6–18 s gaps that grow like
     retransmission backoff. Healthy connections ran at ≥ 127 kB/s and a fresh connection
     recovered in 4–6 s.
- **Effect of the bounds:** with them, 16 consecutive cold all-level loads finished in 8–16 s,
  including two that hit a degraded connection, compared with 78–123 s before. A host in the
  database's region removes most of this exposure.
