# Traffic protection and crawler policy

Phase 5B. Goal: one abusive client, or a moderate number of them, cannot make the single
production server slow or unavailable for people. Normal browsing, shared addresses and search
engines are not penalized.

Measured on a production build (`next build && next start`) behind Caddy 2.6 with this repo's
`deploy/Caddyfile`. Data: a generated, MiLB-scale fictional season (1,040 players, 1,160 games,
32k stat lines) in a disposable local PostgreSQL. Host: a 4-vCPU cloud container; the load
generator, Caddy and the app share it, so absolute numbers are noisy (repeat runs are reported as
ranges). Never run against production or a third party.

## Threat model

| Threat | Cost to us | Before 5B | Now |
|---|---|---|---|
| Crawler or scraper fetching profiles as fast as it can from one address | A profile render is ~50–65 ms of server time and ~155 kB. One process renders ~16/s, then every visitor queues | Saturated the server (visitor p50 965 ms, 13× baseline) | Its per-address budget, and as a heavy client it may only use the server budget above a reserve: readers 146/146 served, p50 230 ms |
| The same from many addresses (botnet, cloud IP ranges), each staying slow | Same saturation; per-address limits never trigger | Visitor p50 4.3 s | Server-wide budget + capped fair-share overflow: admitted renders ≤ ~10/s whatever the number of addresses; readers 146/148 served, p50 252 ms |
| Hundreds of connections from one address | Even ~1 ms refusals saturate the single Node thread | — | Kernel per-source connection limit (`deploy/nftables-conn-limit.nft`) + bounded held refusals (measured below) |
| Unprotected release (header or env missing) | Limiting silently off | — | `/health` 503 `misconfigured` in production: deploy rolls back, the uptime monitor alerts |
| Crawler walking every filter/sort/page/`?level=` combination | Thousands of URLs, each a full render, duplicate content | Nothing discouraged it | `robots.txt` disallows query URLs; each page declares a query-free canonical; sitemap lists canonical URLs |
| Forged `X-Forwarded-For` / `X-Real-IP` / `Forwarded` to get a fresh budget per request | Bypass | (no limiter) | Ignored. Identity is one header Caddy overwrites; verified through Caddy |
| Flood of distinct addresses to grow the limiter's memory | Memory | — | At most 20k clients per class, O(1) LRU eviction (eviction only forgives) |
| Random/unknown profile IDs, bogus parameters | CPU | Already cheap: UUID check, in-memory lookup, 404; never a database query | Unchanged; also counted against the client's budget |
| Database exhaustion | Connections | Already safe: pages never query per request (in-memory snapshot, one tiny version probe a minute while traffic flows; pool max 6). Measured: 6 database transactions during two full crawls of every profile (2 min) | Unchanged; a refused request never reaches any data code |

Expensive routes, measured server time (p50): profile navigation ~50–57 ms (largest:
`playerLevels` scans every stat line of every level); profile prefetch ~15 ms (shell only);
`/players`, `/`, `/trends` ~10–20 ms; `/trends/data` (JSON, client-side switching) small;
`/sitemap.xml` 20 ms (1,044 URLs); `/health` and refusals ~1 ms.

## Design

```
client ──TLS──▶ Caddy (sets X-PT-Client-IP = TCP peer, overwriting) ──▶ 127.0.0.1:3000 Next.js
                                                                           │
                                       src/proxy.ts (before any render) ◀──┘
                                       ├─ exempt: /health, robots, sitemap, icons, build assets
                                       ├─ per-client token bucket by class
                                       ├─ profiles: server-wide budget + per-client fair share
                                       └─ refuse: 429 + Retry-After (held 1 s; ≤32/client, ≤256 total)
```

### Client identity (`src/lib/traffic/client-identity.ts`)

- The app listens on `127.0.0.1` only (systemd unit), so every request comes through Caddy.
- Caddy runs `header_up X-PT-Client-IP {remote_host}`, which **replaces** whatever a client sent in
  that header with the address of the TCP connection Caddy accepted. Verified with Caddy 2.6.2:
  requests sending forged `X-PT-Client-IP`, `X-Forwarded-For`, `X-Real-IP` and `Forwarded`
  values all reached the app with the real peer address.
- The app reads only `PT_CLIENT_IP_HEADER` (set to `x-pt-client-ip`). It refuses to use
  `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `CF-Connecting-IP`, `True-Client-IP` and similar
  even if configured, because clients can set them and proxies append rather than replace.
- The value must be exactly one IP literal (lists, ports and hostnames are rejected). IPv4-mapped
  IPv6 counts as IPv4. **IPv6 is keyed per /64**: one subscriber usually holds a whole /64 and could
  otherwise rotate through addresses for a fresh budget on every request.
- **Fail open per request, fail closed per release**: a request without a trustworthy identity is
  not limited (a guessed identity would be either spoofable or one shared bucket for everyone).
  But in production (`NODE_ENV=production`) the server is then **not healthy**
  (`src/lib/traffic/health.ts`): `/health` returns **503 `misconfigured`** when
  `PT_CLIENT_IP_HEADER` is unset, invalid or a client-controlled header, when `PT_SITE_URL` is
  unset or invalid, or for 10 minutes after any request that came *through a proxy* without a
  valid identity header (Caddy's `header_up` line missing). deploy.sh's health gate therefore
  refuses and rolls back such a release, and the uptime monitor alerts. Verified end to end:
  Caddy without the `header_up` line → 503 through Caddy and directly; env unset → 503;
  explicit `PT_RATE_LIMIT=off` → 200 with `"traffic":{"status":"disabled"}`. "Through a proxy"
  means a non-loopback first `X-Forwarded-For` entry: Next.js itself fills that header with the
  loopback address for direct requests (`x-forwarded-for ??= socket.remoteAddress`), so deploy
  health checks and an operator's `curl 127.0.0.1:3000` never count. `next dev` is never
  affected; a local `next start` needs `PT_SITE_URL` plus either the header variable or
  `PT_RATE_LIMIT=off` for `/health` to report ready. The OFF warning is logged every 10 minutes.
- Found while testing: `{client_ip}` (the placeholder in Caddy's docs) does not exist before
  Caddy 2.7 and is then forwarded literally as the text `{client_ip}`, which would silently turn
  limiting off. The Caddyfile uses `{remote_host}`, which works in every Caddy 2 release.

### Budgets (`src/lib/traffic/policy.ts`)

Token buckets per client: a burst, then a steady refill. A refused request does not extend the
wait.

| Class | What | Burst | Refill | Why |
|---|---|---|---|---|
| `profile` | Full player-profile renders (document or client navigation) | 120 | 6/s | Generous because one address can be a whole office or campus (50 people each opening a profile every 10 s = 5/s). Total load is bounded by the server-wide budget, not by this |
| `page` | Every other render, `/trends/data`, image optimizer | 240 | 8/s | Cheap pages; generous for shared addresses |
| `prefetch` | Requests with `Next-Router-Prefetch: 1` | 400 | 15/s | One page view issues 50–65 prefetches (measured). They render only the shell (~1.3 kB, ~15 ms vs ~155 kB, ~65 ms), so a forged prefetch header buys nothing expensive, and its own budget caps even that. A refused prefetch is invisible to the visitor: verified in a browser with an exhausted prefetch budget (navigation rendered in 348 ms; no retry storm, 43 prefetches in the first 5 s and none after) |
| exempt | `/health`, `/robots.txt`, `/sitemap.xml`, icons, `/_next/static/` | — | — | Monitoring and crawl policy must always work |

**Prefetch detection needs `skipProxyUrlNormalize: true` (next.config.ts).** By default Next.js
deletes `rsc`, `next-router-prefetch` and the other router headers before Proxy runs
(`next/dist/server/web/adapter.js`), so the proxy saw every prefetch as a full profile render.
Found in the end-to-end shared-address test (all refusals were counted as `profile`, none as
`prefetch`); unit tests built on `NextRequest` could not see it. The proxy reads only the pathname
and never rewrites or redirects, so the option changes nothing else.

Shared addresses (offices, campuses, carrier NAT), end to end through Caddy: 50 browsers behind
one address, each opening a profile every ~10 s with 30 prefetches: **156/156 navigations
served** (p50 76 ms); before the fixes above, 21 of 140. Unit-tested: 20 people at a profile every
30 s, 50 people at a profile every 10 s, a heavy reader for 10 minutes: no navigation refused.

Search engines: a crawler that fetches one profile every 2 s per address is never limited (tested
for an hour of simulated crawling). User agents are not trusted (anyone can claim to be
Googlebot, and reverse-DNS verification costs a lookup per request). A crawler that does exceed
a budget gets `429` + `Retry-After`, which major search engines treat as "slow down", not as an
error page to index.

### Overload shedding (profiles only)

Per-client limits cannot see many addresses that each stay under their own limit (measured with
the limiter off: 64 addresses saturated the server at ~16 profiles/s; readers waited 4.3 s). So:

- **Server-wide budget**: 6 renders/s, burst 12 (`PT_PROFILE_BUDGET_RPS` to tune).
- **Fair share per client**: 10 profiles, one more every 10 s, spent on every profile request. A
  client with at least 8 left after this request is **light** (a reader); otherwise **heavy**.
- **Priority**: heavy clients may use the server budget only while it is above half its burst
  (a reserve kept for light clients), so one crawler, or many, can never take all of it. Light
  clients may use all of it, then a **capped overflow** of 4/s (burst 8).
- **Hard bound**: admitted profile renders never exceed budget + overflow (6 + 4 = 10/s, ~60% of
  measured capacity), however many addresses take part.

Pre-merge review quantified the original design's excess: every address's fair-share refill
bypassed the budget, so admitted renders were 6 + N/30 per second at steady state, and in the
first minute every address could spend its full fair share at once:

| Addresses (each 1 profile / 10 s) | Before: first 60 s / steady | Now: first 60 s / steady |
|---|---|---|
| 64 | 6.4 / 6.1 per s | 6.4 / 6.1 per s |
| 200 | 20 / 10.7 | 10.3 / 10.0 |
| 1,000 | **100 / 37.3** | 10.3 / 10.0 |
| 5,000 | **500 / 170.7** | 10.3 / 10.0 |

Tradeoff: when many addresses all behave like readers, they are indistinguishable from readers;
then readers share the bounded 10/s with them and some get `429` + `Retry-After` instead of a
server that is slow for everyone. Unit-tested: with one crawler at its full rate or 64 crawler
addresses, readers opening a profile every 10 s are never refused after the first 15 s.

### Refusals

`429 Too Many Requests`, `Retry-After: <seconds until the next token>`, `Cache-Control: no-store`,
`X-Robots-Tag: noindex`, a one-line plain-text body. Built in the proxy, so no data access, no
database query and no render ever happen for a refused request (a test checks that the proxy
imports no data or database code).

**Held refusals** (`src/lib/traffic/hold.ts`): a refusal is answered after 1 s
(`PT_REFUSAL_DELAY_MS`, 0–5000; 0 = immediate), at most **32 held per client and 256 in total**;
beyond either bound it is answered immediately. A client that ignores Retry-After then costs one
cheap refusal per held connection per second instead of hundreds (~1–1.6 ms of Node per refusal).
Each held refusal keeps two sockets and one app file descriptor, hence the bounds and
`LimitNOFILE=16384` in the service (systemd's default soft limit is 1,024).

Measured (30 s floods through Caddy, app at a 1,024 descriptor limit, 10 readers at 1 req/3 s):

| Flood | Strategy | Flood req/s reaching Node | App CPU | Max app FDs | Readers |
|---|---|---|---|---|---|
| 1 address, 600 connections | held (≤8/client, 256 total) | 719 | 118% | 255 | p50 20.9 s |
| 1 address, 600 connections | immediate | 746 | 116% | 222 | p50 25.0 s |
| same + nft 32 conns/address | held (≤32/client) | 27 (rest reset by the kernel) | 38% | 72 | p50/p95 629/714 ms |
| same + nft 32 conns/address | immediate | 311 | 83% | 75 | p50/p95 758/2,135 ms |
| same + nft 64 conns/address | held (≤32/client) | 352 | 86% | 103 | p50/p95 685/2,043 ms |
| 300 addresses × 2 connections | held (256 total) | 290–381 | 121% | 399 | 14–17 of 20–25 served, p50 8–14 s |
| 300 addresses × 2 connections | immediate | 257–345 | 124% | 211 | 0 of 10–19 served |
| 300 addresses × 2 connections | held, 1,024 total (old bound) | 360 | 116% | 638 | 19 of 41 served |

Conclusions: holding beats immediate refusal in every case; raising the total from 256 to 1,024
brings no benefit and uses 2.5× the descriptors (closer to the 1,024 default), so the total is
256; **no app-level strategy survives hundreds of connections** (Node saturates on refusals), so a
kernel per-source connection limit is the effective defence against one address and a CDN/WAF
against many. No descriptor exhaustion (EMFILE) occurred in any run.

Practical safeguards in front of the app (no paid service, no custom Caddy build):

- `deploy/nftables-conn-limit.nft` (not applied by deploy; runbook step): at most 64 concurrent
  connections per IPv4 address / IPv6 /64 on 80/443. 64 rather than 32 leaves room for a NAT
  (50 browsers behind one address were unaffected end to end); 32 is stronger against floods.
- Caddyfile: header/body read timeouts (10 s) and idle timeout (2 min) against connection
  hoarding; request bodies capped at 64 kB (the site serves only GETs).
- Standard Caddy has no request rate limiter; the `rate_limit` plugin needs a custom build
  (not done).

Once a minute, only if something was refused, the server logs counts (never addresses):
`[traffic] refused N requests in the last minute (profile P of which S for server overload, ...)`.

## Measurements (10 readers each opening a profile every 10 s; 150 s attacks)

Final configuration (after the pre-merge remediation):

| Scenario | Attacker renders/s (last 60 s) | Readers served | Reader p50 / p95 (whole run) |
|---|---|---|---|
| No attack | — | 60/60 | 73 / 153 ms |
| 1 address, 16 connections | 4.8 | 146/146 | 230 / 595 ms |
| 64 addresses, 1 connection each | 5.0 | 146/148 (2 refused, at the start) | 252 / 556 ms (last 60 s: 273 / 418) |
| 50 browsers behind 1 address (NAT) | — | 156/156 navigations | 76 / 258 ms |

For comparison, with the limiter off: 1 address → readers 965 / 1,344 ms; 64 addresses →
4,250 / 4,790 ms (the original PR's design: 66–410 / 172–492 and 313–404 / 1,046–1,119 ms, with a
~45 s transient at p95 12–14 s in the distributed case, now gone).
- Memory: resident ~780–890 MB through every test (bounded limiter; no growth).
- Profile render, A/B on the same build and data: 56–58 ms p50 before, 47.5–54.4 ms after
  deduplicating the per-request profile lookup (`generateMetadata` and the page both resolved
  the player; React `cache()` now does it once per request).

Reproduce: `npm test` (`scripts/traffic.test.ts`: limiter and proxy behaviour) and
`npm run -s traffic:load -- single|distributed|none <seconds>` (`scripts/ops/traffic-load.ts`,
loopback only; setup in its header). It binds distinct 127.0.x.y source addresses so Caddy sees
distinct clients.

## Crawl policy (`src/app/robots.ts`, `src/app/sitemap.ts`, `src/lib/crawl-policy.ts`)

**robots.txt is advisory.** Well-behaved crawlers follow it; abusive ones ignore it. It manages
crawl budget and duplicates; it is not access control. Protection is the rate limiter.

```
User-Agent: *
Allow: /
Allow: /_next/
Disallow: /*?
Disallow: /trends/data
Disallow: /health
Disallow: /analytics/

Sitemap: https://<PT_SITE_URL>/sitemap.xml
```

- Crawlable: `/`, `/players`, `/trends`, `/data`, every `/players/{id}`, and `/_next/` assets
  (needed by crawlers that render pages).
- Not crawled: any URL with a query string (filters, sorts, pages, `?level=` views, profile level
  variants), internal JSON, health, development pages.
- **Canonical URLs**: each page declares its query-free canonical (`/`, `/players`, `/trends`,
  `/data`, `/players/{id}`), so links to query variants consolidate on one indexed URL. A
  consequence: level-specific views (e.g. Triple-A Trends) are not indexed as separate pages.
- **Sitemap**: the four pages plus every player with a game line at any level, once, at the
  canonical URL, with `lastModified` from the latest ingestion (1,044 URLs on the test data;
  ~3.3k on the full season; the limit is 50,000). Built from memory, no database query.
- 404 pages (unknown paths, unknown player IDs) are `noindex` (Next.js default) and return 404.
- The origin for canonical URLs, robots.txt and the sitemap comes from `PT_SITE_URL` at request
  time (the build has no environment). Never from the request's Host header. Unset or invalid:
  canonical URLs fall back to `http://localhost:3000` and robots.txt/sitemap omit absolute URLs,
  so **set it in production**.

## Configuration

| Variable | Value | Effect |
|---|---|---|
| `PT_CLIENT_IP_HEADER` | `x-pt-client-ip` | Must match the Caddyfile `header_up` line. Unset/invalid in production: `/health` 503 `misconfigured`. On Vercel leave it unset (`x-vercel-forwarded-for` is used; anything else is refused) |
| `PT_SITE_URL` | `https://<domain>` | Canonical URLs, robots.txt, sitemap. Unset/invalid in production: `/health` 503 |
| `PT_REFUSAL_DELAY_MS` | unset (1000; 0 on Vercel) | How long a refusal is held (0–5000; 0 = immediate) |
| `PT_PROFILE_BUDGET_RPS` | unset (6) | Server-wide profile renders/s before shedding heavy clients (1–100). Raise on a bigger host |
| `PT_RATE_LIMIT` | unset | `off` disables limiting (emergency switch, reported as `disabled` in `/health`); needs a restart |

## On Vercel (Phase 6B, docs/VERCEL.md)

The same limiter runs in each Vercel function instance:

- **Identity:** keyed on `x-vercel-forwarded-for`, set by Vercel's edge. It is the default there,
  and every other header is refused on Vercel. Off Vercel the same header is refused, because a
  client could send it through Caddy.
- **Refusals:** answered immediately (`PT_REFUSAL_DELAY_MS` defaults to 0 on Vercel; a held
  refusal there is billed function time). They carry `Vercel-CDN-Cache-Control: no-store` so the
  CDN never stores them.
- **Limits are per instance.** A single heavy client is refused. A distributed flood is absorbed
  first by the CDN cache, then by Vercel's DDoS mitigation and the Hobby caps (pause, never bill).
- **Prefetching is off by default** (`src/components/ui/app-link.tsx`), so a page view is ~3
  requests instead of ~60. The `prefetch` budget remains for any link that opts in.
- **Router cache (Phase 2A, docs/VERCEL.md *Navigation*):** a page revisited within 5 minutes in the
  same tab makes no request; first visits still make one RSC request each. A 13-step browsing flow
  went from 9 to 5 server requests. Budgets are unchanged: the cache only removes requests.

## Limitations and when to add more

- **In-memory, per process.** Correct for the one-server deployment. With N servers behind a load
  balancer, each counts separately: a client gets up to N× the budget, and the server-wide budget
  becomes per-server (which is still the right unit for overload). A shared store (e.g. Redis) or
  limiting at the load balancer would be needed for exact global limits. A restart resets all
  budgets.
- **Refusals still cost ~1–1.6 ms each in Node.** Hundreds of connections from one address need
  the kernel connection limit; hundreds of addresses need a CDN/WAF in front (free tiers exist;
  then `PT_CLIENT_IP_HEADER` must change to the CDN's verified client header and Caddy must accept
  only the CDN's ranges), or Caddy's `rate_limit` plugin (custom build).
- **Many addresses that each behave like readers** are indistinguishable from readers: server load
  stays bounded (~10 renders/s) but readers then share that capacity and some get 429s.
- **Shared addresses with many heavy users** (e.g. a whole newsroom pulling profiles at once)
  can be shed during server overload. They are never refused while the server has capacity. A
  very large NAT (more than ~50 simultaneous visitors) may also need the nftables limit raised.
- **One crawler gets more than before** (up to its 6/s address budget while the server has room,
  vs 1/s in the first version): the price of not penalizing shared addresses. It can never take
  the reserve kept for readers.
- **Search engines are not verified**; they are treated like everyone else, with budgets a
  polite crawler never reaches.
- Not tested: real CDNs, IPv6 clients through Caddy (unit-tested only), multi-server setups.
