# Production readiness audit (Phase 5, 2026-11-09)

Read-only review of `main` (`c22c095`, Phases 1–5A) together with the open Phase 5B
(traffic protection, PR #12) and Phase 5C (data refresh, PR #13) branches. Every number below
was measured in this session on disposable local infrastructure: a production build
(`next start`), Caddy 2.6 with `deploy/Caddyfile`, and PostgreSQL 16 holding a generated
MiLB-scale fictional season loaded through the real ingestion pipeline (1,040 players, 1,160
games, 32k stat lines). No production system, Neon branch or live API was touched. The
Neon-measured figures quoted from [DEPLOYMENT.md](./DEPLOYMENT.md) come from Phase 4 and are
labelled as such.

**Verdict.** Technically ready for a controlled single-server launch (private beta / soft
launch) once 5B and 5C are merged and the runbook's approval steps are done. **Not ready for a
public launch** until the data-licensing question is resolved (blocker 1).

## Findings by severity

### Blockers (must be resolved before a public launch)

| # | Finding | Evidence | Action |
|---|---|---|---|
| B1 | **Data licensing.** All data comes from the MLB Stats API, whose terms restrict use to individual, non-commercial, non-bulk use. A public site, especially a commercial one, needs permission or a licensed source. | `CLAUDE.md` *Data licensing*; DEPLOYMENT.md risk 1; the footer says "development use" | Legal decision: obtain written permission/licence, or move to a licensed provider (the adapter boundary `SourceAdapter → normalized records` exists for this). |
| B2 | **Production is not provisioned.** No production Neon branch, read-only `pt_web` role, server, domain or DNS. | DEPLOYMENT-RUNBOOK phases 1–3 (all need approval or purchase) | Run the runbook with approvals. |

### High

| # | Finding | Evidence | Action |
|---|---|---|---|
| H1 | **Traffic protection and data freshness are not merged.** On `main`, an aggressive crawler saturates the server (measured: visitor p50 965 ms with one address, 4.3 s with 64 addresses), and nothing refreshes data. | PR #12 and #13 measurements | Review and merge #12 and #13. They are independent: merged in either order they produce identical trees with no conflicts, and 406/406 tests pass, 0 cancelled, with typecheck, lint and build green (verified locally). |
| H2 | **5B needs deployment configuration in the same release.** Without `PT_CLIENT_IP_HEADER=x-pt-client-ip` plus the Caddy `header_up X-PT-Client-IP {remote_host}` line, rate limiting fails open (logged once). Without `PT_SITE_URL`, canonical URLs point at localhost and robots/sitemap omit absolute URLs. | `docs/TRAFFIC.md`, runbook 2.5 / launch checks (PR #12) | Apply the env and Caddyfile changes with the deploy; run the runbook's spoof-resistance check and grep the journal for "rate limiting is OFF". |
| H3 | **Large or widely distributed floods need protection in front of Node.** Each refusal still costs ~1 ms of Node; a distributed attack degrades service for the first ~45 s; hundreds of addresses each add 1/30 render/s. | `docs/TRAFFIC.md` measurements | Before any promotion: a CDN/WAF (free tiers exist), or Caddy's `rate_limit` plugin (custom build). Re-point `PT_CLIENT_IP_HEADER` to the CDN's verified header and restrict Caddy to the CDN's ranges. |
| H4 | **Scheduled ingestion must be enabled before the 2027 season.** 5C ships the job, lock, recovery, `check:freshness` and a disabled timer. Off-season now (the AFL ended 2026-11-07), so this is not urgent today. | `docs/DATA-REFRESH.md` (PR #13) | After approval: install the units (separate `prospect-ingest` user and env file), one manual run, enable the timer, add a freshness check and the dead-man's-switch ping. |
| H5 | **Alerting is minimal.** There is no error tracking and no 5xx-rate alert. Signals today: the `/health` uptime monitor (runbook), journald lines (`[competition-data] … failed`, `[traffic] refused …`), Caddy access logs, the 5C ping and freshness exit codes. | Logging review | At launch, wire up the uptime monitor, the 5C ping and a daily `check:freshness`. Add error tracking (e.g. a free tier) or a journald-based 5xx alert as traffic grows. |

### Medium

| # | Finding | Evidence | Action |
|---|---|---|---|
| M1 | **Profile renders are the capacity limit.** One process renders ~16–17 profiles/s (measured: 8 concurrent, p50 ~460 ms, 0 errors over 6 full crawls = 6,240 profiles). `playerLevels` scans every stat line of every level per request (222k lines on the real data). | Crawl test; code review | A per-level player index (player → lines) built once per snapshot would cut most of that scan. PR #12 already removed one duplicate resolution per request (A/B: 56–58 → 47.5–54.4 ms p50). |
| M2 | **Memory plateaus near 1 GB on the test data** (360 MB fresh → 935, 993, 990, 1,012, 1,009, 1,011 MB over 6 full crawls: stable, no leak). Phase 4 measured 1.1–1.25 GB on the full Neon data. | Crawl test; DEPLOYMENT.md | Fine with the recommended 4 GB instance (heap cap 1.5 GB, `MemoryMax=3G`). Don't run on 2 GB without swap. |
| M3 | **Single server.** A crash is covered by systemd (~15 s); losing the machine means a snapshot restore (~1 h). Budgets in the rate limiter reset on restart. | DEPLOYMENT.md | Acceptable for launch; revisit with traffic. |
| M4 | **Writer credential placement.** If the 5C timer runs on the web host, the writer credential sits on that disk (root-only, separate user), though never in the web process environment. | DATA-REFRESH.md | Prefer a separate small host or CI scheduler once that's practical. |
| M5 | **Privacy.** Caddy access logs keep client IP addresses (5 × 50 MB rotation). There is no privacy notice. | Caddyfile | Add a privacy notice and a log-retention statement before a public launch; consider shorter retention. |
| M6 | **Build-tool advisories.** `npm audit`: 0 in production dependencies; 12 moderate in build-time tools only (esbuild via drizzle-kit, minimatch via eslint). | `npm audit --omit=dev` / `npm audit` | Not in the running server; update when fixed upstream. |

### Low

| # | Finding | Action |
|---|---|---|
| L1 | CSP allows `'unsafe-inline'` (Next.js inline payload, Recharts styles). Acceptable without accounts or user content. | Revisit if accounts or user content are added. |
| L2 | 5C season windows are fixed dates (MiLB Apr 1–Sep 30, AFL Oct 1–Nov 20, plus grace). | Adjust `ACTIVE_WINDOWS` if a season shifts. |
| L3 | Level-specific views (`?level=`) are not indexed separately (canonical consolidation, 5B). | Intentional; revisit if SEO wants per-level landing pages. |
| L4 | Not verifiable here: live Stats API and Neon behaviour of 5C, a real CDN, IPv6 through Caddy, real screen readers, Windows High Contrast, 200–400% zoom. | Include in launch checks. |

## Area by area

### Performance and memory under realistic traffic

- **Profile pages:**
  - ~50–65 ms of server time each.
  - ~16–17/s per process.
  - p50 ~460 ms at 8 concurrent, with 0 errors across 6,240 renders.
- **Other pages:** 10–20 ms. A router prefetch (~1.3 kB) never computes a profile.
- **Memory:** steady at ~1.0 GB on the test data; 1.1–1.25 GB on the real data (Phase 4).
- **Under attack, with 5B:** one aggressive address is held to 1 profile/s, and readers stay at a p50 of 66–410 ms (baseline 76 ms). 64 addresses get ~7.5/s, readers p50 313–404 ms, never refused.

### Database connections and queries

- **Pages never query per request.** All data comes from an in-memory snapshot per level.
- **One version probe a minute while traffic flows**, reloading a level only after an ingestion was applied. Measured: 6 database transactions during two full crawls (2 min).
- **The web pool and its bounds:**
  - Pool: max 6, 15 s connect timeout, 10 s idle timeout.
  - Each level load runs in a READ ONLY transaction with a 30 s statement timeout.
  - The query watchdog limits a stall to 8 s, a slow transfer to 50 kB/s, and any query to 45 s.
  - A whole level load is bounded at 90 s.
- **A database outage after start does not take the site down.** The last loaded data keeps being served (Phase 4, tested).
- **5C adds at most** one lock connection, a 2-connection pool for job metadata and a 3-connection sink pool per step. All are on the writer role and only while a job runs.

### Data freshness and ingestion reliability

- **Guarantees unchanged:** one transaction per capture, strict validation, quarantine, provenance, idempotency and stale-snapshot checks.
- **What 5C adds:**
  - A season-aware schedule with bounded retries, where permanent errors and quarantine are not retried.
  - A job lock shared with every manual writer.
  - Recovery of abandoned runs, and `check:freshness` with exit codes.
  - Tests: 23 unit, 10 database integration (3 fresh-database runs), and an end-to-end run of the real CLI against a local HTTPS mock of the API.

### Error handling and observability

- **Pages:** generic error pages (no server details). 404s for unknown pages and players are `noindex`.
- **Logs:**
  - Logs never contain credentials or SQL parameters (tests check redaction).
  - Errors log only coarse codes.
  - Rate-limit summaries contain no addresses.
- **Gaps:** H5.

### Accessibility

- **0 violations** on `main` with populated data: 36 page-states, WCAG 2.0–2.2 A/AA.
- **Regression tests:** `scripts/accessibility.test.ts` is part of `npm test`.
- **Manual checks still needed:** L4.

### Deployment and rollback

- **Deploys:** build next to the running release, health-gated switch, and automatic rollback.
- **Rollback:** `rollback.sh` with a restore check.
- **Rehearsed** on every `npm test`: failed first deploy, failed deploy, failed rollback, failed restore.
- **The 5C units are never installed by `deploy.sh`,** and a test checks that.
- **5B needs** the env and Caddyfile changes (H2).

### Security and exposed endpoints

| Endpoint | Exposure |
|---|---|
| `/`, `/players`, `/players/{uuid}`, `/trends`, `/data` | Public pages; read-only in-memory data; inputs validated (UUIDs, enums, query length) |
| `/trends/data` | Public JSON for client-side switching; strict parameter validation (400 otherwise); `private, max-age=60` |
| `/health` | Level readiness only; no error details; no database query |
| `/analytics/models` | 404 in production unless `ANALYTICS_DEBUG=1` |
| `/_next/image` | Local images only (no remote patterns) |
| `/robots.txt`, `/sitemap.xml` (5B) | Public crawl policy |

- **Process:** the app binds `127.0.0.1`. HTTPS and HSTS come from Caddy.
- **Security headers:** CSP, nosniff, `X-Frame-Options: DENY`, Referrer-Policy and Permissions-Policy are set; there's no `X-Powered-By`.
- **Credentials:**
  - The web role is SELECT-only and read-only by default; the writer credential is never in the web environment.
  - No secrets in the tree or history: only test fixtures with fake values, and 0 Neon-style passwords anywhere in `git log -p --all`.
- **Dependencies:** 0 production advisories.

## Recommended next three engineering priorities

1. **Resolve data licensing (B1)** and, in parallel, provision production per the runbook (B2), with approvals.
2. **Merge 5B and 5C and launch safely:**
   - deploy with the 5B configuration (H2);
   - set up the uptime monitor, the 5C ping and the freshness check (H5);
   - enable the refresh timer before the 2027 season (H4).
3. **Capacity and edge hardening:**
   - put a CDN/WAF in front (H3);
   - precompute a per-player index per snapshot to lift profile throughput (M1);
   - add error tracking.
