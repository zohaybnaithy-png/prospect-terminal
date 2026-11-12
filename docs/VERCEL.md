# Vercel Hobby + Neon Free (Phase 6B)

**Status: code ready for a private Vercel staging deployment. Nothing is deployed.** No Vercel
project, Neon branch or domain was created, no Neon data was changed and ingestion stays disabled.
Steps marked **YOU** are console actions for the project owner. Public launch is still blocked on
data licensing ([DATA-LICENSING.md](./DATA-LICENSING.md)); see *Public launch* below.

This is a second deployment target next to the single server ([DEPLOYMENT.md](./DEPLOYMENT.md),
Lightsail + Caddy). The single server is unchanged: every new behaviour below switches on only
with `PT_DATA_SOURCE=snapshot` or on Vercel (`VERCEL=1`, set by the platform).

## Why the code had to change

The site keeps every level in process memory. On one long-running server that's ideal. On Vercel,
every new function instance reloaded all levels from Neon, and the free tiers **pause or suspend
instead of billing** when a cap is reached:

| Problem on Vercel Hobby + Neon Free | Cap | Fix |
|---|---|---|
| ~16 MB from Neon per cold instance | Neon Free: 5 GB egress/month, about 300 cold loads | Build-time snapshot: zero runtime database traffic |
| A version probe once a minute kept Neon awake | Neon Free: 100 CU-hours/month | Snapshot mode never probes |
| 50–65 router prefetches per page view (docs/TRAFFIC.md) | Vercel Hobby: 1M invocations, 1M edge requests | Prefetch off by default |
| Every request rendered (nothing cacheable) | 4 Active CPU hours/month | CDN caching of public pages |
| The limiter's identity header comes from Caddy; a held refusal is billed time | — | Vercel identity header, immediate refusals |
| Several `pt_web` sessions per cold instance | role `CONNECTION LIMIT 20` | No runtime connections |

## 1. Build-time data snapshot

`npm run build:vercel` = `npm run -s snapshot:export && next build` (`vercel.json` runs it).

1. **`snapshot:export`** (`scripts/export-snapshot.ts`, logic in
   `src/services/competition/snapshot-export.ts`)
   - Reads the ingestion version and every level once, through the site's own read layer, all
     inside **one** `READ ONLY`, `REPEATABLE READ` transaction
     (`src/services/competition/consistent-read.ts`), using `DATABASE_URL`. Use the `pt_web`
     role.
   - Writes `.data-snapshot/` (git-ignored, never committed):
     - `manifest.json`: format version, season, ingestion version, snapshot id, and per level the
       file, SHA-256, size and record counts;
     - one `<level>.json.gz` per level that has data.
2. **`next build`** with `PT_DATA_SOURCE=snapshot`
   - Traces `.data-snapshot/**` into every server function (`outputFileTracingIncludes`).
   - Refuses to build if the manifest is missing (`next.config.ts`).
3. **At runtime** (`PT_DATA_SOURCE=snapshot`, `src/services/competition/data-source.ts`)
   - The level cache loads from the files (`snapshotSource`, `snapshot-store.ts`).
   - Its version is the snapshot id, constant per deployment, so nothing is ever reloaded or
     probed.
   - The database client is never created. `DATABASE_URL` is used only by the build.

**Guarantees** (each tested in `scripts/vercel.test.ts` and `scripts/snapshot-db.integration.ts`):

- **Exact data.** The packed format (`snapshot-format.ts`) writes repeated object shapes as tables.
  - Packing refuses anything JSON can't carry exactly: NaN/Infinity, Date, Map, bigint, class
    instances, undefined array elements.
  - The export reads every written file back through the server's path and compares it with the
    database read. A difference fails the export.
  - Momentum, risers, the map, Trending, profiles and analytics views computed from a snapshot
    equal the database-served ones (tested on fictional fixtures and on PostgreSQL).
  - No formula, weight, threshold or statistic changed.
- **Integrity.** Each file's size and SHA-256 are checked before parsing.
  - The manifest must list exactly the site's levels, for the site's season, with
    `<level>.json.gz` names (no path traversal) and a matching id.
  - A bad file fails that level only. The page shows it "temporarily unavailable"; it never shows
    other data.
- **Consistency: one database snapshot for every level** (review finding, PR #16). See
  *Snapshot consistency* below.
- **Fail-closed.** Files are swapped in atomically. A failed export or verification leaves no
  snapshot, so the build fails rather than shipping old or partial data.
- **Read-only.** The export never writes. The integration test runs it on a session with
  `default_transaction_read_only=on` and checks that every table count is unchanged.

**Size and speed.** On a fictional MiLB-scale season (187k stat lines, close to the real 222k):
- 65.5 MB as plain JSON;
- **1.45 MB** gzipped;
- all five levels load in **0.47 s**;
- the process holds ~500 MB resident when ready.

Real data compresses less well than generated data. Expect a few MB; the export prints the real
size.

**New data means a new deployment** (Vercel → Redeploy, or a push). That fits "ingestion disabled".
Before enabling the 2027 refresh, decide how a refresh triggers a redeploy, for example a Vercel
deploy hook called after `refresh:data`. Not built.

### Snapshot consistency: the exact guarantee

**What the first version did, and why it wasn't enough.** It read the version, then each level in
its *own* transaction, then the version again, and failed if the two versions differed. That
made each level consistent but not the set:

- A commit between two level reads produced a snapshot mixing two states.
- The version (applied-run count and latest completion time) only changes when a completed
  ingestion run is recorded. A direct correction, or any other write, passed the check unnoticed.

The integration test reproduces exactly this: a correction committed between two level reads is
visible in the later level, and the version check stays equal.

**What it does now.** The version probe and all five level loads run in one transaction:

- `REPEATABLE READ`: PostgreSQL takes one snapshot at the transaction's first query and serves
  every later statement from it.
- The loaders are unchanged. Inside a transaction, Drizzle turns their own `transaction()` calls
  into savepoints, which keep the outer snapshot (their isolation options only apply at top
  level).
- The reader checks `transaction_isolation = repeatable read` and `transaction_read_only = on`
  before reading anything, and fails otherwise. So a driver change can't silently weaken this.

**Guarantee.** The snapshot files contain exactly the data committed at one instant (the start of
the export transaction), and the manifest's ingestion version is that same instant's. Anything
that commits while the export runs is invisible to it: an ingestion apply, a correction, any
write. It appears only in the next export. Readers never block writers, so a concurrent ingestion
is neither blocked nor failed by an export.

**Tested** (`npm run test:snapshot:db`, PostgreSQL 16, 8/8). While the export's transaction is
open after its first level, the test commits a real AFL ingestion apply of an upstream correction
and a direct row update on other connections. Then:

- the database shows both;
- the snapshot shows neither: the AFL level has exactly the pre-commit data, and every level
  matches the earlier export;
- the manifest carries the pre-commit version;
- a new export sees the new state.

**Limits.**

- One connection is held for the whole export (seconds).
- Each statement keeps the 30 s `statement_timeout`. The `pt_web` role's
  `idle_in_transaction_session_timeout` (60 s) bounds pauses between statements.
- Neon's pooler runs in transaction mode, so the whole transaction stays on one server connection.
  Not yet run against Neon; preview check 1 covers it.
- Row order: players, games and teams come back in the database's physical order (the loaders have
  no `ORDER BY`; that's existing behaviour, unchanged here). The snapshot freezes the order its read
  returned. Two exports of identical data can list rows in a different order; the content is equal.

### Lazy analytics preparation (Momentum performance, phase 1)

Measured cause of the ~4.4 s cold start (overnight audit): every new instance prepared
the analytics of all five levels (`prepareSnapshot`: analytics context, every role × window
Momentum result, Trending) before any page could render, and Momentum spent most of that time
re-validating identical date ranges and re-scanning each player's lines.

**What changed** (no formula, weight, threshold, classification or output changed):

1. **Snapshot mode prepares lazily** (`src/services/competition/source-cache.ts`). Levels are still
   loaded and decoded at boot, but analytics are computed by the first request that needs a level,
   through the existing per-snapshot memos, and reused afterwards. Database mode (single server)
   still prepares every level eagerly on load.
2. **Output-preserving Momentum optimizations** (`src/analytics/windows.ts`): `comparisonRanges`
   memoized per dataset; `linesInRange` binary-searches the verified date-ordered line lists.

**Guarantees:**
- `scripts/momentum-golden.test.ts` pins 2,638 Momentum outputs (every player × role × window ×
  model, timelines, profiles, discovery lists, directory rows, scales, settings variants) generated
  from the unmodified engine. It passes unchanged; the golden file was not regenerated.
- `scripts/lazy-prepare.test.ts`: identical page view models eager vs lazy; serving one level
  prepares only that level; concurrent first requests share one load and one computation.
- The original and optimized builds were compared live: 60/60 `/trends/data` responses
  byte-identical, 62/62 pages identical in content, status and CDN header.

**Measured** (local container, fictional MiLB-scale snapshot: 3,149 players, 187k stat lines;
same build settings, 1,536 MB heap cap; median of 3 cold runs):

| | Before | After |
|---|---|---|
| Startup to `/health` ready | 4.23 s, 6.5 CPU-s | 1.23 s, 1.8 CPU-s |
| Cold `/` (default level, AFL) | 4.40 s | 1.24 s |
| Cold `/?level=aa` (full MiLB level) | 4.31 s | 1.80 s |
| Cold `/players` (all levels) | 4.16 s | 2.04 s |
| Cold `/trends` / `/trends?level=aa` | 4.08 / 4.36 s | 1.09 / 1.65 s |
| Cold player profile | 4.27 s | 1.47 s |
| Warm profile (median) | 172 ms | 121 ms |
| Momentum warm-up, one MiLB level | 699 ms | 325 ms |
| Peak memory after a 300-profile crawl | 826 MB | 769 MB |

**Trade-off:** a request that is the first to need a level now computes it (about 0.5 s for a full
MiLB level, about 0.8 s for `/players` without `?level=`, which needs every level). Before, that
work happened during startup, so the same request still finishes far sooner from a cold start.
Real Vercel numbers must be read from the deployment's function metrics.

## 2. Prefetching off by default

`src/components/ui/app-link.tsx` is the site's only `Link`: Next.js's `Link` with
`prefetch={false}` unless a caller opts in. ESLint (`no-restricted-imports`) forbids importing
`next/link` anywhere else.

| Page view (Chromium, built server) | Before (docs/TRAFFIC.md) | After |
|---|---|---|
| Router prefetches | 50–65 | **0** |
| Server requests per page view (document, analytics script, icon) | ~60+ | **3** |

Clicking a player link still navigates client-side with one RSC request (`?_rsc=…`), which the CDN
can serve.

### Navigation: router cache and pending hint (Phase 2A)

Every page is dynamic, and Next.js 16 keeps dynamic pages in the browser's router cache for 0 s by
default, so every click (including a revisit) was one RSC request reaching a function, and a slow
(cold) one showed nothing until it answered.

- **Router cache:** `next.config.ts` sets `experimental.staleTimes.dynamic` to 300 s
  (`ROUTER_CACHE_DYNAMIC_SECONDS`). A page visited in the last 5 minutes is shown from memory with
  no request. The cache is per tab, in memory, keyed by URL including the query string, so each
  filter, search and level is its own entry. A full reload empties it. `static` (default 300 s) is
  not overridden. `staleTimes` is still experimental (14.2+; Next.js 15 changed the dynamic default
  from 30 s to 0), so `scripts/navigation.e2e.ts` pins the behaviour across upgrades.
- **Staleness bound:** cached pages can be up to 5 minutes older than the server. The data changes
  only per snapshot build (a deployment), so in practice this is "up to 5 minutes after a deploy".
  After a deployment, the first navigation that reaches the server sees a different build and
  Next.js loads a full document from the new deployment, which empties the cache; builds are never
  mixed in one page (e2e-verified, with different data in the two builds).
- **Pending hint:** `src/components/ui/link-pending-hint.tsx` (`useLinkStatus`, stable since
  15.3) renders a 2 px bar along the bottom of the clicked header tab or player-name link. It is
  absolutely positioned (no layout shift), `aria-hidden`, and hidden for the first 150 ms, so
  cached and fast navigations never show it. Reduced motion: shown without the pulse.
- **Not used:** `loading.tsx`. A loading boundary streams the page, which fixes the status at 200
  before the profile is looked up, so an unknown player would become a soft 404 (200 with a "not
  found" body). `scripts/navigation.test.ts` fails if one is added under `src/app`. Prefetching
  stays off (no hover or viewport requests).

| Navigation flow (13 steps, Chromium, `next start`, snapshot, median of 3) | Cache off (main) | Cache on |
|---|---|---|
| Server requests for the flow | 9 | **5** |
| Revisit within 5 min | 1 request, 112 ms | **0 requests, 85 ms** |
| Revisit with +300 ms simulated server/network latency | 406 ms | **84 ms** |
| First visit | 1 request (unchanged) | 1 request |
| Back / Forward | 0 requests (Next.js history cache) | 0 requests |
| Hover | 0 requests | 0 requests |

Single-core runs show the same shape (revisit 117 → 78 ms; with +300 ms, 395 → 85 ms).

## 3. CDN caching (`src/lib/cdn-cache.ts`)

Only for snapshot builds (content is fixed per deployment). Switch it off with `PT_CDN_CACHE=off`
and a redeploy.

**Rules.**

- **Pages.** `Vercel-CDN-Cache-Control: max-age=300, stale-while-revalidate=86400` on `/`,
  `/players`, `/players/:id`, `/trends`, `/data`, `/robots.txt` and `/sitemap.xml`, set through
  next.config `headers()`. Only plain requests get it: **no** `RSC`, `Next-Router-Prefetch`,
  `Next-Router-Segment-Prefetch`, `Next-Router-State-Tree`, `Next-Url` or `Next-Action` header, and
  **no** `_rsc` parameter. Browsers keep Next.js's `Cache-Control: private, no-store`.
- **`/trends/data`.** The route handler sets the same header itself, on its successful answer only.
- **Proxy.** It marks every non-plain request `no-store` at runtime.
- **Never cached:** `/health`, `/analytics/*`, retired-route redirects, everything not listed.

### Audit (review finding, PR #16) and fixes

| Area | Finding | Fix | Regression test |
|---|---|---|---|
| RSC payloads | Next.js keeps RSC and HTML apart by validating `_rsc` against the router headers (a mismatch gets a 307), but **only outside minimal mode**, and Vercel runs Next.js in minimal mode (`next/dist/server/base-server.js`). The first version cached RSC requests that carried `_rsc`, so on Vercel a forged RSC request with a real `_rsc` value could have stored a wrong payload under a key real visitors use | RSC and router requests are **never** cached. Cost: each client-side navigation (one RSC request per click; prefetching is off) reaches a function | unit (Next's own `has`/`missing` matcher), e2e |
| HTML under a router URL | The first version cached HTML requested with `?_rsc=…` and no RSC header, which stored HTML under a router cache key | The rule requires no `_rsc` | unit, e2e |
| Empty `_rsc` | `has`/`missing` treat an empty value as absent, so `?_rsc` (exactly where Next.js redirects a bare RSC request) still matched the rule | The proxy sets `no-store` for any `_rsc` or router header. Measured: the proxy's header wins over the rule | unit, e2e |
| Status codes | A next.config header **overrides a route handler's header of the same name**. So `/trends/data`'s 503/404 `no-store` lost, and those data-state answers were marked cacheable (measured) | `/trends/data` removed from the rule; the handler adds the header only to its 200 | e2e |
| Status codes | The rule cannot see the status: page 404s (unknown player) get it | Correct: deterministic per deployment. Next.js's 308 for `/players/` and the retired-route 307s get no header (measured) | e2e |
| Status codes | A transient bad 200 (e.g. "temporarily unavailable" after a failed load, streamed with status 200) would be cached | Bounded: `max-age=300`, then revalidated. Accepted | — |
| Query parameters | Part of the cache key; unknown ones are ignored by the pages | Correct content per key. Varying them bypasses the cache, which the per-client limiter bounds | unit, e2e |
| Refusals | The proxy's 429 must not be stored | `no-store`; measured to win over the rule | unit, e2e |

### Verified locally vs only on a Vercel preview

**Locally** (`npm run test:cdn:e2e`: a real `next build` and `next start` from a fictional
snapshot, with `VERCEL=1` emulated and an unreachable `DATABASE_URL`; also run in CI):

- which responses carry the header, for every route, status, query form and router-header form
  above;
- that proxy-set `no-store` and route-handler headers behave as described;
- that browsers never get a cacheable `Cache-Control`;
- that pages render with no database.

**Only on a Vercel preview** (checks 3 and 8 below). Vercel's CDN can't be emulated locally:

1. Vercel acts on `Vercel-CDN-Cache-Control` for a function response whose `Cache-Control` is
   `private, no-store`: the second identical request shows `x-vercel-cache: HIT`.
2. Vercel applies next.config headers, and the proxy's headers, **before** its cache decision. If
   it only honoured headers set by the function itself, the rule would be a no-op. That's a safe
   failure (nothing cached, higher usage), and the fix would be per-page headers.
3. The statuses Vercel stores: 200 and 404 yes, 5xx and 429 no. The cache is scoped per
   deployment, so a redeploy starts empty.
4. Whether the proxy runs on cache hits. That decides whether a cached page still costs a proxy
   invocation, and whether rate limiting applies to cached pages.
5. That Deployment Protection is checked before the cache, so cached preview pages stay private.
6. Vercel runs Next.js in minimal mode, so the 307 for a bare RSC request seen locally does not
   happen there. The rules don't depend on it.

## 4. Traffic protection on Vercel (no paid features)

The in-app limiter (docs/TRAFFIC.md) stays on. It is the free protection layer.

- **Identity.** On Vercel the client is keyed by `x-vercel-forwarded-for`, which Vercel's edge
  sets from the connection it accepted.
  - Vercel documents that it does not forward client-supplied `X-Forwarded-For` values, to prevent
    spoofing. Enterprise "trusted proxy" setups are the exception, and they aren't used here.
  - It is the default when `PT_CLIENT_IP_HEADER` is unset. On Vercel any other configured header
    is **refused**: nothing overwrites it there. A copied `x-pt-client-ip` makes `/health`
    report 503 instead of silently limiting nobody.
  - Off Vercel, `x-vercel-forwarded-for` is client-controlled (Caddy passes it through), so it is
    refused there.
- **Immediate refusals.** `PT_REFUSAL_DELAY_MS` defaults to 0 on Vercel. Holding a 429 keeps a
  function invocation open, which is billed provisioned memory, while Vercel's edge, not this
  process, holds the client's connection.
- **Per instance.**
  - Each function instance has its own limiter, so one address is refused by every instance it
    reaches, and a single heavy client is still stopped (tested end to end through the proxy).
  - A flood spread over many addresses and instances is bounded by:
    - the CDN cache: most requests never reach a function;
    - Vercel's included DDoS mitigation;
    - the Hobby caps, which **pause the project and never bill**.
- **Health.** On Vercel `/health` never gives the detailed report, because every request arrives
  through Vercel's edge with forwarding headers. The monitor (`scripts/ops/monitor.ts`) is a
  single-server tool.
- **Proxy matcher.** It skips `/_vercel/*` (analytics) and `/_next/image` as well as
  `/_next/static/`, so analytics beacons cost no proxy invocation.
- **Optional, free on Hobby (YOU, dashboard; no code depends on them):**
  - *Attack Challenge Mode* as an emergency switch;
  - up to 3 WAF custom rules, one of which may be a rate-limit rule. If you add one, don't
    challenge verified search-engine bots.

## 5. Visitor analytics

Vercel Web Analytics (`@vercel/analytics`, pinned exactly).

- **Where.** Rendered by the root layout only on Vercel (`src/lib/web-analytics.ts`); off with
  `PT_WEB_ANALYTICS=off`.
- **Privacy.** Cookieless. Page views carry the **path only**: query strings (search text,
  filters) and fragments are removed in `beforeSend`.
- **CSP unchanged.** The script `/_vercel/insights/script.js` and its beacons are same-origin, and
  a browser check found no CSP violations.
- **Hobby allowance.** 50,000 events a month, then collection pauses (no charge).
- **Privacy note.** The Data & methodology page has a *Privacy* section stating what is counted.
- **YOU:** enable Web Analytics in the Vercel project.

## 6. Private staging on Vercel

**Indexing on Vercel is off unless `VERCEL_ENV=production` and `PT_INDEXING=on`.**
- Preview and development deployments are never indexed, whatever the variable says.
- A missing variable can't make production public by accident.
- Off Vercel the old rule is unchanged (unset = on).
- Everything `PT_INDEXING=off` did before still applies: robots.txt disallows everything, the
  sitemap is empty, pages carry `noindex` meta, and every proxied response carries
  `X-Robots-Tag: noindex, nofollow`.

**Site origin.** `PT_SITE_URL` is optional on Vercel. Canonical URLs then use Vercel's own
deployment hostname from the platform variables, never the request's Host header. An invalid
explicit `PT_SITE_URL` is not silently replaced.

**Region.** `vercel.json` pins functions to `pdx1` (Portland), next to Neon `us-west-2`.

### Setup (all YOU; approvals per CLAUDE.md)

1. **Neon** (docs/NEON-STAGING.md): the `staging` branch and the `pt_web` role, plus
   `npm run -s check:db-roles`.
   - **Measure storage first**, read-only: `SELECT pg_size_pretty(pg_database_size('neondb'));`.
     Neon Free allows 0.5–1 GB per project (the vendor's pages disagree), shared by all branches.
   - Don't install the Neon–Vercel integration. It injects owner credentials and creates a branch
     per preview.
2. **Vercel project.** Import the GitHub repository on the Hobby plan. `vercel.json` sets the
   framework, `npm ci`, the build command and the region.
   - Node.js 24.x (or 22.x) in project settings.
3. **Environment variables**, from `deploy/vercel-env.example`:
   - for **Preview**: `PT_DATA_SOURCE=snapshot`, `PT_INDEXING=off`,
     `NODE_OPTIONS=--max-old-space-size=1536`, and `DATABASE_URL` = `pt_web` on `staging`, pooled,
     `sslmode=require&channel_binding=require`, marked *Sensitive*;
   - leave **Production** without `DATABASE_URL` until launch, so a production build fails
     instead of serving anything.
4. **Deployment Protection.** Vercel Authentication for previews (included on Hobby). Staging is
   then visible only to members of your Vercel account.
5. **Web Analytics.** Enable it in the project.
6. **Deploy a preview** from a branch, then run the checks below.

### Checks on the preview

1. The build log shows `[snapshot] verified 5 levels` and the snapshot size: the single export
   transaction worked through Neon's pooler. `/health` returns `{"status":"ready"}`.
2. Neon console: connections only during the build, nothing while you browse.
3. `curl -sI` a page twice: `x-vercel-cache: HIT` the second time, and `x-robots-tag: noindex,
   nofollow`.
4. `/robots.txt` disallows everything; `/sitemap.xml` is empty.
5. In the browser's network panel: no prefetch requests, no CSP errors, and
   `/_vercel/insights/script.js` loads. The Analytics dashboard shows the visit, path only.
6. Vercel → Usage, after ~20 page views: invocations and Active CPU per page view.
7. Rate limiting and identity, from one machine (the preview needs a Vercel Authentication bypass
   token, or test right after disabling protection briefly):
   - **Honest run:** 260 sequential requests to `/players?n=1` … `?n=260`. The distinct query
     strings miss the CDN, and the page class allows 240 per client. Expect 429s near the end.
   - **Forged run:** the same, with a different forged `-H 'x-vercel-forwarded-for: 192.0.2.N'`
     on each request. Expect the same 429s, which means Vercel replaced the forged value.
   - If the honest run is refused and the forged run is not, the identity is spoofable: set
     `PT_RATE_LIMIT=off` and report it.
   - If neither run is refused, requests were spread over several instances. Repeat with a faster
     loop.
8. CDN details (each answers one preview-only question from section 3):
   - Fetch a profile twice. The second response must show `x-vercel-cache: HIT`; otherwise Vercel
     ignores routing-layer headers (question 2: safe, but no caching).
   - `curl -sI '<url>/players?_rsc=x' -H 'RSC: 1'` twice: never `HIT`.
   - `curl -sI '<url>/players?_rsc='` twice: never `HIT`.
   - `/trends/data?view=map&level=<an empty level>&role=hitter&window=14d` twice: 404, never `HIT`.
   - An unknown profile twice: `HIT` the second time is fine.
   - A rate-limited 429 (check 7) never shows `HIT`.
   - Signed out, request a cached preview page: Vercel's login, not the page (question 5).
   - After a redeploy, the first request is a `MISS` (per-deployment scoping, question 3).

## Free-tier budget (estimates from local measurements; check 6 gives real numbers)

At ~10k page views a month plus a full crawl of ~3.3k profiles:

- **Vercel**
  - 3 requests per page view, most of them CDN hits, so well under 100k of the 1M invocations and
    edge requests.
  - Active CPU: cold starts ~0.5 s of load and warm-up per instance, plus ~50 ms per uncached
    profile render, so well under 1 of the 4 CPU-hours.
  - Provisioned memory: well under the 360 GB-hours.
- **Neon:** one export per build (a few seconds of 0.25 CU, a few MB of egress), so effectively 0
  of 100 CU-hours and 5 GB.
- **Web Analytics:** one event per page view, so 10k of 50k.

| Item | Cost |
|---|---|
| Vercel Hobby | $0. Non-commercial use only. Caps pause the project; nothing is billed |
| Neon Free | $0. Caps suspend compute until next month |
| Domain (only at public launch) | ~$10–20/year |
| If outgrown | Vercel Pro $20/month per member; Neon Launch usage-based (~$5–20/month here) |

## CI

`.github/workflows/ci.yml` (added with the review fixes; there was no CI before) runs on every pull
request and on pushes to `main`, read-only (`contents: read`), with no secrets:

- **checks:** `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` (the
  default single-server build).
- **cdn-e2e:** `npm run test:cdn:e2e` (snapshot build plus cache-header matrix, fictional data,
  unreachable database).
- **nav-e2e:** `npm run test:nav:e2e` (two snapshot builds, `next start`, headless Chromium:
  router cache, pending hint, filters and levels across history, 404s, headers, redeploy).

Not in CI yet: the seven PostgreSQL integration suites (`test:*:db`). They need a disposable
PostgreSQL service and migrations per suite, which is a natural next step. They were run locally
for this change.

## What was verified, and where

| Check | Where | Result |
|---|---|---|
| Unit tests (`scripts/vercel.test.ts`, 57) plus the full suite | local | 509/509 |
| Export against PostgreSQL 16, including concurrent commits (`npm run test:snapshot:db`) | local disposable DB | 8/8 |
| Existing AFL and MiLB read suites (`test:afl:db`, `test:milb:db`) | local disposable DBs | 5/5, 14/14 |
| Export CLI through the single transaction; unreachable-DB failure (URL not printed, old snapshot removed) | local | as designed |
| Snapshot build, file tracing into every function, missing-snapshot guard | `next build` | as designed |
| Cache-header matrix, header precedence, no-database serving (`npm run test:cdn:e2e`) | `next build` + `next start` | 8/8 |
| Prefetch count, click navigation, analytics script request, CSP | Chromium | 0 prefetches, no violations |
| Router cache, pending hint, filters/levels across history, 404s, headers, redeploy (`npm run test:nav:e2e`) | `next build` + `next start` + Chromium | 8/8 |
| Lint, typecheck, default build | local; CI on every PR | clean |
| Vercel CDN behaviour, edge headers, minimal mode, Analytics collection, real capacity, Hobby usage | **not verified** | preview checks 1–8 |

## Public launch (not part of this phase)

Still blocked on the data-licensing decision ([DATA-LICENSING.md](./DATA-LICENSING.md)). A Vercel
deployment doesn't change it:

- Hobby is non-commercial only, which suits the MLB Stats API's terms, but it is no licence.
- Bulk storage and republication remain open questions.

Only after that decision:

1. Production `DATABASE_URL`.
2. A domain, with `PT_SITE_URL` and a redirect from `*.vercel.app`.
3. `PT_INDEXING=on` on Production.
4. Search Console verification (DNS TXT record) and sitemap submission.
