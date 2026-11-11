# Phase 6: staging-readiness checklist

`[x]` done and verified in the repository (Phase 6A, local disposable infrastructure only).
`[ ]` needs you: approval, a purchase, credentials or a console action. Nothing below has been
verified against Neon or a real server yet.

## A. Codebase (Phase 6A)

- [x] PRs #10–#14 are in `main` (merge commits for #10–#14; #12–#14 heads `77ffdb9`, `0054a0a`,
      `a1f5ccc` are ancestors of `main`).
- [x] `npm test`, lint (0 warnings), typecheck and production build pass on `main` and on the 6A
      branch. 0 failed, 0 cancelled, 0 skipped.
- [x] All seven database integration suites pass on fresh local databases (ingestion, mlb, afl,
      milb, refresh, freshness, roles).
- [x] Deploy ↔ refresh: no build during a refresh (`deploy.sh`), no refresh during a deploy
      (`ExecCondition`). Rehearsal-tested.
- [x] `npm ci --include=dev` in `deploy.sh` (tests and the refresh/monitor units need dev
      dependencies). Rehearsal-tested with `NODE_ENV=production` set.
- [x] `shellcheck -x deploy/*.sh` is clean, as the runbook expects (it wasn't: SC2148 and three notes).
- [x] Scheduled writer pinned to one database (`PT_WRITE_TARGET_ENDPOINT`, required in production).
- [x] Staging can't be indexed (`PT_INDEXING=off`) and is private (`deploy/Caddyfile.staging`,
      basic auth except `/health`). Verified end to end through Caddy.
- [x] `/health` reports database refresh failures, memory and uptime. A local monitor covers app
      down, 5xx, database, ingestion, freshness and memory. Verified end to end.
- [x] Role SQL for the web (read-only) and writer roles, and `check:db-roles`. Verified against the
      checked-in SQL; the real refresh job runs as the writer role.

## B. Neon staging (docs/NEON-STAGING.md)

- [ ] **Approve** and create branch `staging` from the test branch; note `<STAGING_EP>`.
- [ ] Integrity and readiness checks against `<STAGING_EP>` (read-only).
- [ ] **Approve** and create `pt_web` and `pt_ingest` on `staging` (SQL Editor, new passwords).
- [ ] `npm run -s check:db-roles` → exit 0.

## C. Staging server (docs/STAGING-SERVER.md)

- [ ] **Approve the purchase:** Lightsail 4 GB in us-west-2, static IP, firewall; a 2 GB swap file.
- [ ] Base system with Caddy ≥ 2.8 from the official repository; users; units copied but not
      enabled; log ACL.
- [ ] Both env files filled in (web with `PT_INDEXING=off`; ingest with `PT_WRITE_TARGET_ENDPOINT`).
- [ ] First deploy healthy.
- [ ] **Approve** the DNS record for `staging.<domain>`; staging Caddyfile with a hashed password;
      nftables limit.
- [ ] Rehearsal checks 1–12 (13 optional) recorded.
- [ ] Optional: enable the monitor and refresh timers for a few days and read their results.
- [ ] Teardown, or keep for the next rehearsal (Neon *Reset from parent*).

## C′. Vercel staging, the free alternative to C (docs/VERCEL.md)

- [x] Snapshot mode, prefetch off, CDN caching, Vercel traffic protection, Web Analytics,
      indexing off by default on Vercel. Tested locally (Phase 6B).
- [ ] Measure Neon storage against the Free cap (read-only query).
- [ ] **Approve** and create the Vercel project (Hobby) from the GitHub repository. Node 24.x.
- [ ] Preview environment variables from `deploy/vercel-env.example`. `DATABASE_URL` = `pt_web` on
      `staging`, marked *Sensitive*. No Production `DATABASE_URL` yet.
- [ ] Deployment Protection (Vercel Authentication) for previews; Web Analytics enabled; no Neon
      integration.
- [ ] Preview deployment, then checks 1–8 in docs/VERCEL.md recorded (8: the CDN questions only a preview can answer).
- [x] CI workflow (`.github/workflows/ci.yml`): lint, typecheck, tests, default build, snapshot/CDN e2e.

## D. Before any production launch (not part of staging)

- [ ] **Data licensing decision** (docs/DATA-LICENSING.md).
- [ ] Privacy notice and log retention (IP addresses in Caddy logs; player personal data).
- [ ] Production branch, roles, server, domain: DEPLOYMENT-RUNBOOK.md with approvals.
- [ ] External uptime check and the monitor/refresh pings (free tier; you create the accounts).
- [ ] CDN/WAF decision for large or distributed floods (docs/TRAFFIC.md).
