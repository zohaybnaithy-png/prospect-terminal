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
| Crawler or scraper fetching profiles as fast as it can from one address | A profile render is ~50–65 ms of server time and ~155 kB. One process renders ~16/s, then every visitor queues | Saturated the server (visitor p50 965 ms, 13× baseline) | Limited to a burst of 60, then 1/s; visitor p50 66–410 ms over three runs |
| The same from many addresses (botnet, cloud IP ranges), each staying slow | Same saturation; per-address limits never trigger | Visitor p50 4.3 s | Server-wide budget with fair share: visitor p50 313–404 ms after the first ~45 s |
| Crawler walking every filter/sort/page/`?level=` combination | Thousands of URLs, each a full render, duplicate content | Nothing discouraged it | `robots.txt` disallows query URLs; each page declares a query-free canonical; sitemap lists canonical URLs |
| Forged `X-Forwarded-For` / `X-Real-IP` / `Forwarded` to get a fresh budget per request | Bypass | (no limiter) | Ignored. Identity is one header Caddy overwrites; verified through Caddy |
| Flood of distinct addresses to grow the limiter's memory | Memory | — | At most 20k clients per class, O(1) LRU eviction (eviction only forgives) |
| Random/unknown profile IDs, bogus parameters | CPU | Already cheap: UUID check, in-memory lookup, 404; never a database query | Unchanged; also counted against the client's budget |
| Database exhaustion | Connections | Already safe: pages never query per request (in-memory snapshot, one tiny version probe a minute while traffic flows; pool max 5) | Unchanged; a refused request never reaches any data code |

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
                                       └─ refuse: 429 + Retry-After (held 1 s, max 1000 held)
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
- **Fail open**: with the variable unset or the header missing/invalid, requests are not limited
  per client (a guessed identity would be either spoofable or one shared bucket for everyone).
  In production this is logged once: `[traffic] ... per-client rate limiting is OFF`.
- Found while testing: `{client_ip}` (the placeholder in Caddy's docs) does not exist before
  Caddy 2.7 and is then forwarded literally as the text `{client_ip}`, which would silently turn
  limiting off. The Caddyfile uses `{remote_host}`, which works in every Caddy 2 release.

### Budgets (`src/lib/traffic/policy.ts`)

Token buckets per client: a burst, then a steady refill. A refused request does not extend the
wait.

| Class | What | Burst | Refill | Why |
|---|---|---|---|---|
| `profile` | Full player-profile renders (document or client navigation) | 60 | 1/s | The expensive page. A reader opens one every several seconds at most |
| `page` | Every other render, `/trends/data`, image optimizer | 120 | 3/s | Cheap pages; generous for shared addresses |
| `prefetch` | Requests with `Next-Router-Prefetch: 1` | 400 | 15/s | One page view issues 50–65 prefetches (measured). They render only the shell (~1.3 kB, ~15 ms vs ~155 kB, ~65 ms), so a forged prefetch header buys nothing expensive, and its own budget caps even that |
| exempt | `/health`, `/robots.txt`, `/sitemap.xml`, icons, `/_next/static/` | — | — | Monitoring and crawl policy must always work |

Shared addresses (offices, campuses, carrier NAT): tested with 20 people behind one address each
opening a profile every 30 s with prefetches: no refusals. A heavy reader (a profile every 10 s
plus directory pages and all prefetches, for 10 minutes): no refusals.

Search engines: a crawler that fetches one profile every 2 s per address is never limited (tested
for an hour of simulated crawling). User agents are not trusted (anyone can claim to be
Googlebot, and reverse-DNS verification costs a lookup per request). A crawler that does exceed
a budget gets `429` + `Retry-After`, which major search engines treat as "slow down", not as an
error page to index.

### Overload shedding (profiles only)

Per-client limits cannot see 64 addresses that each stay under their own limit. Measured with
the limiter off: 64 addresses saturated the server at ~16 profiles/s and readers waited 4.3 s
(p50). So profile renders also draw on one **server-wide budget** (default 6/s, burst 12;
`PT_PROFILE_BUDGET_RPS` to tune). When it is spent, a profile request is still served if its
client has a **fair share** left (10 profiles, refilled at one per 30 s, spent on every profile
request). People reading at human pace always keep their share and are never refused; addresses
pulling profiles continuously are refused, and only while the server is over budget.

### Refusals

`429 Too Many Requests`, `Retry-After: <seconds until the next token>`, `Cache-Control: no-store`,
`X-Robots-Tag: noindex`, a one-line plain-text body. Built in the proxy, so no data access, no
database query and no render ever happen for a refused request (a test checks that the proxy
imports no data or database code). Answered after 1 s (at most 1,000 held at once, beyond that
immediately): a client that ignores Retry-After then costs one cheap refusal per connection per
second instead of hundreds (measured: ~1 ms of Next's request handling per refusal; a single
address at 16 connections sent 18,911 requests in 30 s before the delay, 2,401 in 150 s with it).

Once a minute, only if something was refused, the server logs counts (never addresses):
`[traffic] refused N requests in the last minute (profile P of which S for server overload, ...)`.

## Measurements (10 readers each opening a profile every 10 s; last 60 s of a 150 s attack)

| Scenario | Limiter | Attacker served | Reader p50 / p95 | Readers refused |
|---|---|---|---|---|
| No attack | on | — | 76 / 180 ms | 0 |
| 1 address, 16 connections | off | 15.9 profiles/s | 965 / 1,344 ms | 0 |
| 1 address, 16 connections | on | 1.0/s | 66–410 / 172–492 ms (3 runs) | 0 |
| 64 addresses, 1 connection each | off | 15.9/s | 4,250 / 4,790 ms | 0 |
| 64 addresses, 1 connection each | on | 7.4–7.5/s | 313–404 / 1,046–1,119 ms (2 runs) | 0 |

- **Transient**: in a distributed attack the first ~45 s are still bad (reader p95 12–14 s)
  while 64 addresses spend their fair shares (640 renders) before shedding engages.
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
| `PT_CLIENT_IP_HEADER` | `x-pt-client-ip` | Must match the Caddyfile `header_up` line. Unset: no per-client limiting (logged once) |
| `PT_SITE_URL` | `https://<domain>` | Canonical URLs, robots.txt, sitemap |
| `PT_PROFILE_BUDGET_RPS` | unset (6) | Server-wide profile renders/s before shedding heavy clients (1–100). Raise on a bigger host |
| `PT_RATE_LIMIT` | unset | `off` disables limiting (emergency switch); needs a restart |

## Limitations and when to add more

- **In-memory, per process.** Correct for the one-server deployment. With N servers behind a load
  balancer, each counts separately: a client gets up to N× the budget, and the server-wide budget
  becomes per-server (which is still the right unit for overload). A shared store (e.g. Redis) or
  limiting at the load balancer would be needed for exact global limits. A restart resets all
  budgets.
- **Refusals still cost ~1 ms each in Node.** A large flood (thousands of requests/s) or a
  botnet with hundreds of addresses needs shedding before Node: a CDN/WAF in front (free tiers
  exist; then `PT_CLIENT_IP_HEADER` must change to the CDN's verified client header and Caddy must
  accept only the CDN's ranges), or Caddy's `rate_limit` plugin (needs a custom Caddy build).
- **Distributed attacks with many slow addresses** are only partly handled: N addresses add N/30
  renders/s via their fair shares, and the first ~45 s of an attack degrade service.
- **Shared addresses with many heavy users** (e.g. a whole newsroom pulling profiles at once)
  can be shed during server overload. They are never refused while the server has capacity.
- **Search engines are not verified**; they are treated like everyone else, with budgets a
  polite crawler never reaches.
- Not tested: real CDNs, IPv6 clients through Caddy (unit-tested only), multi-server setups.
