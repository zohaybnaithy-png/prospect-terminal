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
   - Reads every level once, through the site's own read layer (`dbLevelLoader`: each level in a
     `READ ONLY`, `REPEATABLE READ` transaction), using `DATABASE_URL`. Use the `pt_web` role.
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
- **Consistency.** The ingestion version is read before and after the levels. An apply in between
  fails the export.
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

## 3. CDN caching (`src/lib/cdn-cache.ts`)

Only for snapshot builds (content is fixed per deployment). Switch it off with `PT_CDN_CACHE=off`
and a redeploy.

- **Header.** `Vercel-CDN-Cache-Control: max-age=300, stale-while-revalidate=86400` on `/`,
  `/players`, `/players/:id`, `/trends`, `/trends/data`, `/data`, `/robots.txt` and
  `/sitemap.xml`. Only Vercel's CDN acts on it. Browsers keep Next.js's
  `Cache-Control: private, no-store`.
- **Never cached:** `/health`, `/analytics/*`, everything else.
- **Cache poisoning.** RSC and HTML share a pathname.
  - The header is added only to requests without an `RSC` header, or with the router's `_rsc`
    cache-key parameter.
  - Next.js itself answers an `RSC` request without `_rsc` with a 307 to the `_rsc` URL. Measured,
    with no CDN header on that 307.
- **Errors.**
  - The proxy's 429 and `/trends/data`'s 503/404 data-state answers send
    `Vercel-CDN-Cache-Control: no-store`, which overrides the rule (measured: the 429 carries
    `no-store`).
  - Vercel does not cache 5xx.
  - A bad 200 (e.g. a level "temporarily unavailable") is cached for at most ~5 minutes before a
    background revalidation replaces it.
- **Request-independent content.** No cached page reads cookies or request headers (tested), and
  Vercel scopes the cache per deployment.

Measured against the built server (`next start`, snapshot build) with emulated Vercel variables:

| Request | Status | `Vercel-CDN-Cache-Control` |
|---|---|---|
| `/`, `/players?level=aa`, a profile, `/trends/data?…`, `/robots.txt` | 200 | `max-age=300, stale-while-revalidate=86400` |
| Unknown profile | 404 | cached (deterministic per deployment) |
| `/health`, `/analytics/models` | 200 / 404 | none |
| `/players` with `RSC: 1`, no `_rsc` | 307 | none |
| `/players?_rsc=…` with `RSC: 1` | 200 | cached (own key) |
| Rate-limited profile | 429 | `no-store` |

**YOU, on the preview:** confirm Vercel honours it: `curl -sI <url>/players` twice. The second
response shows `x-vercel-cache: HIT`.

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

1. The build log shows `[snapshot] verified 5 levels` and the snapshot size. `/health` returns
   `{"status":"ready"}`.
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

## What was verified, and where

| Check | Where | Result |
|---|---|---|
| Unit tests (`scripts/vercel.test.ts`, 49) plus the full suite | local | 501/501 |
| Export against PostgreSQL 16 (`npm run test:snapshot:db`) | local disposable DB | 6/6 |
| Export CLI success, unreachable-DB failure (URL not printed, old snapshot removed) | local | as designed |
| Snapshot build, file tracing into every function, missing-snapshot guard | `next build` | as designed |
| Server with an unreachable `DATABASE_URL`: ready, real pages, no database errors | `next start` | as designed |
| Cache headers, 307 for RSC without `_rsc`, 429 `no-store` | `next start` | table above |
| Prefetch count, click navigation, analytics script request, CSP | Chromium | 0 prefetches, no violations |
| Vercel CDN, edge headers, Analytics collection, real capacity, Hobby usage | **not verified** | preview checks |

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
