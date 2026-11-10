# Production readiness audit (Phase 5, updated after the pre-merge remediation and Phase 6A)

Review of `main` (`c22c095`, Phases 1–5A) together with the open, remediated Phase 5B
(traffic protection, PR #12, head `77ffdb9`) and Phase 5C (data refresh, PR #13, head `0054a0a`)
branches. Updated after a pre-merge remediation pass that found and fixed several defects in both
(listed below), so earlier versions of this audit overstated readiness.

## Verdict

**Not ready for a public launch.** Two hard blockers remain:

1. **Data licensing (B1).** All data comes from the MLB Stats API, whose terms restrict use.
2. **Nothing has run on production infrastructure (B2).** No production database, server, domain or
   DNS exists, and **none of Phase 5A–5C has been verified against Neon or any production-like
   host.**

**What the evidence supports:** after #12 and #13 are merged, the code is ready for a
**staged rehearsal**. That means the runbook on a real Lightsail instance against a non-production
Neon branch, with the launch checks below. It is not ready for real users.

## Phase 6A update (pre-staging): ranked gap list

PRs #10–#14 are merged into `main`. Phase 6A verified `main` (426/426 tests, lint, typecheck,
build, 49/49 database integration tests), fixed the defects below, and prepared staging
(docs/STAGING-CHECKLIST.md). It still ran **only on local disposable infrastructure**. This list
replaces the severity tables further down where they differ.

**Fixed in 6A** (each with a regression test):

| Defect | Severity before | Fix |
|---|---|---|
| The scheduled writer accepted whatever `INGESTION_DATABASE_URL` it was given. A copied prod URL on staging (or the reverse) would write to the wrong database | High | `PT_WRITE_TARGET_ENDPOINT` pin, checked before connecting; required in production |
| A deploy's build (~1 GB) could overlap a refresh (≤ 1.5 GB) on a 4 GB host, and a refresh could start mid-deploy | High | `deploy.sh` refuses during a refresh; the refresh unit skips during a deploy (`ExecCondition`) |
| `deploy.sh` ran `npm ci` without dev dependencies when `NODE_ENV=production` was set in the shell, so tests and `tsx` units broke | Medium | `npm ci --include=dev` |
| A database failure **after** start was invisible: `/health` stayed `ready`, and only the journal showed it | Medium | `/health` `refreshFailing`; monitor alert |
| No 5xx, memory or "job stopped running" alerting | Medium | `scripts/ops/monitor.ts` and its timer (disabled), optional free ping |
| Staging would have been indexable and public | Medium | `PT_INDEXING=off` (robots, sitemap, meta, `X-Robots-Tag`); `deploy/Caddyfile.staging` basic auth |
| No writer-role definition; the only writer was the owner role | Medium | `deploy/neon-writer-role.sql`, `check:db-roles`, an integration test that runs the real job as that role |
| `shellcheck -x deploy/*.sh` reported findings, while the runbook says "no output = OK" | Low | scripts fixed; a test runs shellcheck |
| Public `/health` (also unauthenticated on staging) disclosed memory, uptime, per-level and database-failure state, configuration reasons (env and header names) and whether rate limiting was off | Medium | Public answer is only `ready`/`unavailable` plus the HTTP status; full report only for direct local requests (two independent signals, not forgeable through Caddy) |
| `PT_RATE_LIMIT=off` was reported as `disabled` and the monitor treated it as healthy | Medium | Monitor `traffic` check alerts on anything but `protected` (and on a missing traffic field); tests keep staging templates protected by default |

**Remaining, ranked:**

| Rank | Severity | Gap | Owner action |
|---|---|---|---|
| 1 | Blocker | **Data licensing** (B1): docs/DATA-LICENSING.md, 12 questions | Legal/commercial decision |
| 2 | Blocker | **Nothing verified on Neon or a real server** since Phase 4 (B2) | Staging rehearsal: docs/STAGING-CHECKLIST.md B and C |
| 3 | High | **Refresh job never run against Neon or the live API** (pooler vs direct lock, timings, memory) | Staging rehearsal check 9 |
| 4 | High | **Distributed floods** (H2): no CDN/WAF | Decide before a public launch |
| 5 | High | **Alert delivery** depends on an external ping or uptime service you create; nothing is enabled | Create free checks; enable the monitor timer |
| 6 | Medium | **Privacy:** IP addresses in logs, player birth dates, no notice or retention policy (M6) | Notice and log retention before launch |
| 7 | Medium | **Writer credential** on the web host's disk when both run on one host (M5) | Separate host or CI scheduler later |
| 8 | Medium | Prefetch classification depends on Next.js internals (M1); profile render capacity ~16/s (M2) | Re-run the end-to-end check after upgrades; per-player index |
| 9 | Medium | **Real capacity unknown:** all load numbers are from a shared local container | Staging check 13 |
| 10 | Low | No error tracking with stack traces, no metrics history | Add when traffic justifies it |
| 11 | Low | Season windows are dates, not the schedule (L1); AFL 2026 ended Nov 7, before the default Nov 20 | Set `PT_SEASON_WINDOWS=afl=10-01..11-07` |
| 12 | Low | Caddy 2.6 locally vs ≥ 2.8 on the server; the Caddyfiles validate on 2.6 only | Staging step 2 confirms |

## What was verified where

| Environment | What ran there | What it proves | What it does not |
|---|---|---|---|
| **Local, synthetic** (this phase) | Production builds (`next start`), Caddy 2.6.2 with the repo's Caddyfile, PostgreSQL 16, nftables; the synthetic MiLB fixture and a generated MiLB-scale fictional season (1,040 players, 1,160 games, 32k stat lines) loaded through the real ingestion pipeline; mock Stats API (fetch mock and a local HTTPS mock); real Chromium. All on one 4-vCPU container shared with the load generator | Logic, failure handling, integrity and relative performance (on/off, before/after) | Absolute latency and capacity on the target host; real-data volume (222k lines); Neon network behaviour; the live API; Caddy ≥ 2.7 from the official repository (production installs that, not 2.6) |
| **Neon test branch** (Phase 4 only) | Level loads, memory and throughput of the site *before* 5A–5C | Memory ~1.1–1.25 GB on full data; ~15–19 profiles/s per process; bounded cold loads | Anything added in 5A/5B/5C; the refresh job and its locks against Neon (pooler/direct endpoints, `pg_stat_activity` visibility for the roles used) |
| **Production** | Nothing | — | Everything |

Credentials for Neon were not available in this environment and were not requested.

## Defects found and fixed in the pre-merge remediation

Each was reproduced by a failing test first.

| PR | Defect | Severity before fix | Fix |
|---|---|---|---|
| #12 | **Prefetch detection broken in the running server.** Next.js deletes the router headers before Proxy runs, so every prefetch spent the *profile* budget. In an end-to-end test, 50 browsers behind one address got 21 of 140 navigations through. Unit tests built on `NextRequest` could not see this | High | `skipProxyUrlNormalize: true`; now 156/156. A refused prefetch was verified invisible to a real browser, with no retry storm |
| #12 | **The server-wide budget had no hard bound.** Admitted renders were 6 + N/30 per second; with 1,000 addresses, 100/s in the first minute and 37/s steady against ~16/s capacity | High | Capped fair-share overflow, plus a reserve that light clients get first. Admitted ≤ ~10/s for any number of addresses |
| #12 | **Rate limiting failed open silently.** An unset header variable, or a Caddyfile without `header_up`, left limiting off, with one log line | High | In production, `/health` returns 503 `misconfigured`, so deploy rolls back and the uptime monitor alerts. Verified end to end for both cases |
| #12 | **Held refusals** were capped only in total (1,000), with no per-client bound and no file-descriptor headroom (systemd default soft limit 1,024) | Medium | ≤32 per client and ≤256 total; `LimitNOFILE=16384`; measured against immediate refusal (below) |
| #13 | **Freshness used one global "last success."** A recent AFL or previous-season capture made stale MiLB data look fresh (reproduced on PostgreSQL) | High | Each level is judged by its own source and season's captures |
| #13 | **Fatal errors were not notified.** Missing config, unreachable database or lock failures exited without the failure ping | High | Status `error` in the log plus a `/fail` ping with a credential-free reason. Verified end to end |
| #13 | **Lock contention was always exit 0.** A stuck holder was indistinguishable from a normal overlap | Medium | `locked` vs `locked-stale` (holder age from `pg_stat_activity`); `check:freshness` flags a long-held lock |
| #13 | **Releasing a lock whose connection had died threw,** losing the job's outcome. Found by the new lost-lock test | Medium | Release never throws; lost-lock jobs report `aborted` / `lock-lost` |

## Remaining issues by severity

### Blockers

| # | Issue | Action |
|---|---|---|
| B1 | **Data licensing.** MLB Stats API terms (individual, non-commercial, non-bulk use) | Legal decision: permission/licence or a licensed provider (the `SourceAdapter` boundary exists for this) |
| B2 | **No production infrastructure, and no Neon or production verification of 5A–5C** | Runbook with approvals; then the staged rehearsal below |

### High

| # | Issue | Action |
|---|---|---|
| H1 | #12 and #13 are unmerged | Review and merge. They are independently mergeable: each alone, both in either order (identical trees) and with #14; 426/426 tests, 0 cancelled, plus typecheck, lint and build on the combined tree |
| H2 | **Large or distributed floods.** No app-level strategy survives hundreds of concurrent connections (Node saturates on ~1–1.6 ms refusals). A per-address kernel limit contains one address. Many addresses that each behave like readers are indistinguishable from readers: load stays bounded (~10 renders/s), but readers then share it and some get 429s | Install `deploy/nftables-conn-limit.nft` (runbook). Put a CDN/WAF in front before any promotion |
| H3 | **Scheduled ingestion is not enabled,** and the refresh job has never run against Neon or the live API | Staged rehearsal: one manual `refresh:data --apply` against a non-production Neon branch (direct-endpoint lock, `pg_stat_activity` visibility, timings), then enable the timer before the 2027 season (approval) |
| H4 | **Alerting is still minimal.** Uptime monitor (now also catches misconfigured traffic protection), refresh ping (now including fatal errors and stuck locks), `check:freshness`. There's no error tracking and no 5xx-rate alert | Add error tracking or a journald-based alert as traffic grows |

### Medium

| # | Issue | Action |
|---|---|---|
| M1 | **Prefetch classification depends on Next.js internals.** It relies on `skipProxyUrlNormalize` keeping router headers. A Next upgrade could change this; only an end-to-end check detects it | After any Next.js upgrade, re-run the shared-address end-to-end check (`docs/TRAFFIC.md`) |
| M2 | **Profile renders are the capacity limit.** ~16–17/s locally; `playerLevels` scans all stat lines per request | Per-snapshot player index (not done) |
| M3 | **A single crawler gets more than in the first version of #12,** up to 6 profiles/s, the price of not penalizing shared addresses. It can never take the reserve kept for readers | Monitor; tune `PT_PROFILE_BUDGET_RPS` on the real host |
| M4 | **Memory.** Plateaus ~1.0 GB on the synthetic season (no leak over 6 full crawls); 1.1–1.25 GB on Neon data (Phase 4) | 4 GB instance as planned |
| M5 | **Writer credential** on the web host's disk if the timer runs there (root-only, separate user) | Separate host or CI scheduler when practical |
| M6 | **Privacy.** Caddy access logs keep IP addresses; no privacy notice | Notice and retention policy before a public launch |
| M7 | **Build-tool advisories.** 12 moderate (dev tooling only); 0 in production dependencies | Update when fixed upstream |

### Low

| # | Issue |
|---|---|
| L1 | Season windows are configured dates (`PT_SEASON_WINDOWS`), not read from the schedule; a schedule-aware design is documented in DATA-REFRESH.md |
| L2 | The lock-holder age is visible only to roles that can see the holder's session (use the writer role for `check:freshness`) |
| L3 | A NAT of more than ~50 simultaneous visitors may need the nftables limit raised above 64 |
| L4 | If the lock is lost after an apply's last abort check, that capture still commits while another job could start. The writer's per-transaction source lock serializes them, so integrity holds (documented, not separately tested) |
| L5 | CSP `'unsafe-inline'` (Next.js inline payload, Recharts); acceptable without accounts or user content |
| L6 | Not tested anywhere: IPv6 through Caddy (unit-tested only), a real CDN, real screen readers, Windows High Contrast, 200–400% zoom |

## Measured on local synthetic infrastructure (not production numbers)

- **`main` after 5A** (populated synthetic data):
  - 0 axe violations across 36 page-states.
  - 6 full profile crawls (6,240 renders): 0 errors, memory plateau ~1.0 GB.
  - 6 database transactions in 2 minutes of crawling.
- **#12 after remediation** (150 s attacks; 10 readers each opening a profile every 10 s):

  | Scenario | Readers served | Reader p50 / p95 |
  | --- | --- | --- |
  | No attack | 60/60 | 73 / 153 ms |
  | One crawler address | 146/146 | 230 / 595 ms |
  | 64 addresses | 146/148 | 252 / 556 ms |
  | 50-browser NAT | 156/156 navigations | 76 / 258 ms |

  With the limiter off, readers saw p50 965 ms (one address) and 4,250 ms (64 addresses). Flood tests: held refusals beat immediate refusals in every scenario. A 32-per-address kernel limit held one address's 600 connections to 38% app CPU, with reader p50 629 ms.
- **#13 after remediation:**
  - Unit: 30 refresh tests.
  - PostgreSQL integration: refresh 13/13, freshness 1/1, existing MiLB 14/14.
  - End-to-end CLI checks against a mock API and a local ping receiver.

## Staged rehearsal (before any real launch)

1. Merge #12 and #13; provision per the runbook against a **non-production** Neon branch.
2. Launch checks: `/health` shows `"traffic":{"status":"protected"}`; robots/sitemap/canonical; the spoof-resistance check; the nftables table is present.
3. Repeat the load tests from a separate machine against the instance (never against third parties), and record real capacity. Adjust `PT_PROFILE_BUDGET_RPS` if needed.
4. One manual `refresh:data --apply` and `check:freshness` with the writer role. Confirm the lock uses the direct endpoint and that the holder age is visible.
5. Only then: licensing decision (B1), production branch, domain, and enabling the timer.

## Next three priorities

1. Licensing decision (B1).
2. Merge #12 and #13 and run the staged rehearsal: the first Neon and production-like verification of 5A–5C.
3. Edge protection and capacity: a CDN/WAF in front, a per-player index for profile throughput, and error tracking.
