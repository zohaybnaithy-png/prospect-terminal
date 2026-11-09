# Deployment

Nothing is deployed yet. This document records the production architecture, the hosting decision
and the reasons for both. The step-by-step procedure is in
[DEPLOYMENT-RUNBOOK.md](./DEPLOYMENT-RUNBOOK.md); the files it installs are in `deploy/`.

Measurements: production build (`next start`) on a Mac against the Neon test branch (2026 season,
5 levels, about 8.4k games and 222k stat lines) over a home connection, 2026-11-08, unless stated
otherwise.

## Architecture: one persistent Node.js server, next to the database

`next build`, then `next start` as one long-running process. At start, `src/instrumentation.ts`
loads every level in the background; requests that arrive first share those loads. After that
every page is served from memory. A one-row `ingestion_runs` probe runs at most once a minute while
there is traffic (never while idle), and a level reloads in the background only after an
ingestion run was applied, while the previous snapshot keeps being served. A Neon compute that
scaled to zero is woken by that background probe, not by a waiting visitor.

| Setting | Value | Why |
|---|---|---|
| Instances | 1 | Each process holds its own copy of all levels and loads it at start |
| Memory | 4 GB recommended (2 GB minimum) | See *Memory* below |
| `NODE_OPTIONS` | `--max-old-space-size=1536` | Tested heap cap (full profile crawl, no failures) |
| CPU | 2 vCPU | Warm-up is ~0.5 s per MiLB level; a profile render costs ~50 ms of CPU |
| Region | AWS `us-west-2` (Oregon), same as Neon | Cold loads transfer ~16 MB per process start |
| `DATABASE_URL` | SELECT-only role `pt_web`, pooled endpoint | `deploy/neon-readonly-role.sql`; queries already run in `READ ONLY` transactions |
| Health check | `GET /health` | 200 once every level is loaded; see below |
| `PT_DATA_TIMING` | Unset (`1` for diagnosis) | Slow (>15 s) and failed level loads are always logged |

### Memory

| State | Resident memory |
|---|---|
| All levels loaded and warmed | ~690 MB |
| After every one of 3,312 player profiles was requested, twice, plus 600 page loads at 20 concurrent | 1.1–1.25 GB, level (not growing) |
| `next build` (all build processes) | ~1.06 GB peak |
| Before the fix below: after ~500 distinct profiles | 1.9 GB, then **crash: JavaScript heap out of memory** |

**Fixed in this branch (launch blocker):** each profile request computed Momentum at every date of
the season and stored those results in the shared per-snapshot analytics caches, which are never
cleared while the data is unchanged (~0.5 MB per distinct profile). A crawler walking the player
pages would have crashed the server. Profiles now use a request-scoped context
(`requestContext` in `src/analytics/views.ts`) that reads the shared caches but keeps its own
additions, which are discarded with the response. Results are identical (the caches memoize
deterministic functions; Momentum V1 formulas, weights and thresholds are unchanged), and render
time is unchanged (7.3 vs 8.1 ms per profile offline). Regression tests in
`scripts/frontend.test.ts` fail without the fix.

Why 4 GB: the server levels off at ~1.25 GB, a background reload briefly holds two copies of a
level, and deploys build on the same machine while the old release serves (~1 GB). 2 GB works for
serving alone but leaves no room for an on-machine build without swap.

### Throughput (one process)

| Page | 20 concurrent |
|---|---|
| Home `/` | ~95 req/s, p50 185 ms |
| `/players` | ~105 req/s, p50 170 ms |
| `/trends?level=aaa` | ~160–190 req/s, p50 100 ms |
| Player profile (distinct players, 8 concurrent) | ~15–19 req/s, p50 ~450 ms |

Profiles are the expensive page (each is computed on request). Ample for an early-stage site, but
an aggressive crawler can saturate the process; see *Risks*.

## Health check, restarts and rollback

`GET /health` (`src/app/health/route.ts`) reads only the in-memory cache state, never queries the
database, never caches, and returns no error details:

- `200 {"status":"ready"}`: every level has its data (a level not yet ingested counts as loaded).
- `503 {"status":"starting"}`: still loading (about 12 s after start, measured).
- `503 {"status":"degraded"}`: a first load failed and is backing off. The health check also
  restarts the warm-up once the backoff expires, so a failed start keeps retrying without visitors.

Once ready, a server stays ready through later database outages, because it keeps serving the last
loaded data. A restart therefore never turns a database blip into downtime.

- **Deploys** (`deploy/deploy.sh`): build next to the running release; switch only after install,
  tests and build pass; restart; keep the new release only if `/health` reaches 200 within 180 s,
  otherwise switch back to the previous release automatically. A failed first deploy (nothing to
  fall back to) removes `current` instead of leaving it on the broken build, is recorded, and the
  next deploy starts normally (the deploy user may also clear systemd's restart limit).
- **Rollback** (`deploy/rollback.sh`): switch to an already-built earlier release in ~15 s. If the
  target fails its health check, the release that was running is restored and checked; a failed
  restore is reported separately (exit 2).
- **Restarts**: systemd `Restart=always` (crash or out-of-memory), `MemoryMax=3G`; the service
  starts at boot. Caddy holds requests for up to 30 s while the app restarts instead of returning
  502.
- **Data rollback**: Neon point-in-time restore or a branch from an earlier point (the web server
  never writes).

Rehearsed locally against throwaway commits: first deploy, a release whose health check never
passes (rolled back automatically, set aside so it can never be selected later), a release that
fails to build (nothing changed, error shown), a concurrent deploy (refused), invalid refs and
release names (refused), rollback to the previous and to a named release. The failure paths are
also exercised on every `npm test` (`scripts/deploy-rehearsal.test.ts`): failed first deploy and
recovery, failed deploy rolled back, failed rollback restored, and failed restore reported.

## Security

- **Secrets**: `DATABASE_URL` lives only in `/etc/prospect-terminal/env` (root, mode 600), read
  by systemd. Never in the repository, the unit file, logs or error output (errors log only coarse
  codes). The writer credential (`INGESTION_DATABASE_URL`) never goes on the web server.
- **Database**: the `pt_web` role can only `SELECT`, and its sessions default to read-only with a
  30 s statement timeout (`deploy/neon-readonly-role.sql`). TLS with certificate verification
  (`sslmode=require` is treated as `verify-full` by the pg client) and channel binding.
- **Network**: the app listens on `127.0.0.1:3000` only; Caddy terminates HTTPS (free, auto-renewed
  Let's Encrypt certificates) and adds HSTS. Firewall: 80 and 443 open, 22 only from your IP.
- **Headers** (`next.config.ts`, every response): Content-Security-Policy (same-origin only;
  `'unsafe-inline'` scripts/styles are required by Next.js's inline payload and Recharts, see the
  comment there), `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `X-Frame-Options: DENY`, `Permissions-Policy`; no `X-Powered-By`. Verified in a browser on
  every page type: no CSP violations or console errors.
- **Development pages**: `/analytics/*` return 404 in production unless `ANALYTICS_DEBUG=1`.
- **Dependencies** (`npm audit`, 2026-11-08): 0 vulnerabilities in production dependencies. 12
  moderate advisories in build-time tools only (esbuild via drizzle-kit, minimatch via eslint);
  they are not part of the running server. Revisit when those tools release fixes.

## Hosting options (AWS us-west-2 unless stated)

Prices are USD per month, from the providers' pricing pages on 2026-11-08 (Lightsail) or
approximate list prices (others); confirm at purchase.

| Option | Monthly | Memory / CPU | Operations | Verdict |
|---|---|---|---|---|
| **Lightsail instance, 4 GB** (Ubuntu 24.04) | **$24** (+ ~$4 snapshots) | 4 GB, 2 vCPU, 80 GB SSD, 4 TB transfer, static IP included | You run one Linux server: systemd, Caddy, security updates (automatic). Scripts and runbook provided | **Recommended**: cheapest reliable fit, same region as Neon, headroom for builds and reloads |
| Lightsail instance, 2 GB | $12 | 2 GB, 2 vCPU | Same | Budget option; add a 2 GB swap file for builds |
| Lightsail container service, Medium | $40 | 2 GB, 1 vCPU | Managed HTTPS endpoint; deploy a Docker image. Docs: a deployment whose containers fail to launch keeps the previous one; automatic restart is not documented; logs kept 3 days | Viable later; needs a Dockerfile and Docker (not set up), costs more for less memory |
| ECS Fargate + Application Load Balancer | ~$55–60 (Fargate 1 vCPU/2 GB ~$36, ALB ~$16–20, IPv4 ~$4) | 2 GB, 1 vCPU | Most AWS concepts (VPC, task definitions, target groups) | Overkill for one process |
| App Runner | — | — | — | Closed to new customers since 2026-04-30 |
| Render (Oregon region), 1 CPU / 2 GB | ~$25 (third-party listings; not confirmed) | 2 GB, 1 CPU | Git-push deploys, managed TLS, rollbacks | Simplest to operate, but outside your AWS account and Render does not state which data center its Oregon region uses |
| Serverless (e.g. Vercel Functions) | — | — | — | Not suitable for this data layer (below) |

Other costs: a domain (~$10–20/year); Neon (the production branch's compute and storage on your
current Neon plan; a branch shares storage with its parent until it diverges).

## Why not serverless (for now)

The data layer is an in-memory, per-process cache. Serverless platforms break each of its
assumptions:

- **Every cold instance repeats the full load.** That is about 16 MB from Neon plus about 2.5 s of
  warm-up compute. Concurrency spreads traffic across instances, so each one pays it, and each
  holds about 700 MB or more.
- **Background work after a response is not guaranteed.** A frozen instance never completes the
  stale-while-revalidate refresh, or completes it late.
- **Frozen instances pause timers.** The query watchdog tolerates pauses, but deadlines measured
  across a freeze are not meaningful.
- **Process-global state doesn't help.** The cache and connection pool are shared within one
  process, never across instances.

Serverless becomes reasonable after a data-architecture change: precomputed per-level aggregates
or view models in the database, or a shared cache. That is a separate change to discuss.

## Logging and monitoring

- **App logs**: stdout/stderr to the systemd journal (`journalctl -u prospect-terminal`), made
  persistent and capped at 500 MB by the runbook. Lines to watch: `[competition-data] … load
  failed`, `refresh failed`, `[db] closed a … query`. Logs never contain credentials or SQL
  parameters.
- **Access logs**: Caddy, `/var/log/caddy/access.log` (rotated, 5 × 50 MB).
- **Uptime**: an external monitor (e.g. UptimeRobot or Better Stack free tier) on
  `https://<domain>/health` every 1–5 minutes, alerting by email; it also catches expired
  certificates and DNS problems.
- **Machine**: a Lightsail CPU-utilization alarm with email notification; automatic daily
  snapshots (7 kept, $0.05/GB-month).

## Accessibility (axe-core 4.10, WCAG 2.1 AA + best practices)

Scanned: home, players, trends, data, a profile and the 404 page at 1440 px and 390 px. Three
findings, none structural:

1. **Color contrast (serious)**: small muted text (e.g. `#788582` on white at 9 px, 3.8:1; 4.5:1
   needed) on all six pages, 208 elements. Fix: darken the muted text token and avoid text below
   ~11 px.
2. **Links within text (serious)**: team/organization links in trend rows differ from surrounding
   text only by color (1.3:1). Fix: underline links inside text blocks.
3. **Scrollable region not keyboard-focusable (serious)**: one `.table-scroll` wrapper. Fix:
   `tabIndex={0}` with an accessible label on scrollable table wrappers.

Already in place: `lang`, skip link, labelled controls, semantic tables, visible focus, correct
404 status.

## Risks before a public launch

Blockers:

1. **MLB Stats API terms.** The data comes from the MLB Stats API, which is labelled
   development-only on the site. Its terms restrict use to individual, non-commercial,
   non-bulk use. A public site needs a licensing decision (`CLAUDE.md`, *Data licensing*).
2. **Production data and read-only role** are not in place yet (runbook, phase 1; needs approval).
3. **Domain and DNS** are not chosen yet.

Should be addressed:

4. **Crawler load on profiles** (~17 profiles/s per process). Addressed in Phase 5B
   ([TRAFFIC.md](./TRAFFIC.md)): robots.txt, sitemap and canonical URLs; per-client rate limits
   with a server-wide profile budget, keyed on a header Caddy overwrites. Large or widely
   distributed floods still need a CDN/WAF in front.
5. **Accessibility findings** above (small CSS changes).
6. **Data freshness**: no scheduled ingestion in production; the data is the 2026 season as
   ingested on the test branch (AFL through 2026-11-07). Fine off-season; schedule incremental
   ingestion (writer role, separate from the web server) before the 2027 season.
7. **Single server**: a crash or reboot is covered by systemd (~15 s); losing the machine means
   restoring a snapshot or re-running the runbook (~1 hour). Acceptable at this stage.
8. **CSP allows inline scripts** (required by Next.js without nonces); acceptable without user
   accounts or user-generated content.
9. **First visitor after a restart** waits up to ~12 s for the data (Caddy holds the request).

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
