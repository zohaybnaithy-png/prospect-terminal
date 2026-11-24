# Decisions

Architecture and product decisions with their reasons. Newest last. A decision changes only by a new entry
that supersedes it. Proposals awaiting the owner are at the end. Details live in the linked docs.

| Id | Decision | Why | Where |
|---|---|---|---|
| D-001 | **Player is the central object**; orgs, teams, levels, games are context. Internal UUIDs; provider ids only in `source_identities`. | Survives promotions, trades, provider changes. | ARCHITECTURE.md, INGESTION.md |
| D-002 | **Statistics and Momentum are per level.** Never summed or normalized across levels without an approved method. | Level-of-competition adjustment is unsolved; blending misleads. | ANALYTICS.md, PRODUCT.md |
| D-003 | **Hosting: Vercel (Hobby) + build-time snapshot.** The Lightsail + Caddy + systemd target (deploy/) is a dormant alternative, kept but not run. | Zero ops, free tier, no runtime DB. | VERCEL.md, DEPLOYMENT.md |
| D-004 | **Snapshot-only runtime on Vercel.** `PT_DATA_SOURCE=snapshot`; the build exports a consistent READ ONLY snapshot and fails otherwise (`src/lib/vercel-build-guard.ts`). Runtime never opens a DB connection. | No DB credentials or connection limits at runtime; deterministic pages. | VERCEL.md §1, PR #22 |
| D-005 | **Precomputed per-level view models** are byte-verified at build and fall back to live computation on any mismatch (source fingerprint, V8 version, Math probes). | Cold start 4.4 s → ~1.1 s without risking wrong output. | VERCEL.md, `src/services/competition/views-store.ts` |
| D-006 | **Prefetch off by default** (`@/components/ui/app-link`); router cache `staleTimes.dynamic=300`. | 50–65 prefetches per page view would exhaust Hobby invocation limits. | VERCEL.md §2 |
| D-007 | **No `loading.tsx`.** | Streaming fixes the status at 200 and turns unknown-player 404s into soft 404s. | VERCEL.md §2 |
| D-008 | **CDN caches plain page requests only** (`Vercel-CDN-Cache-Control: max-age=300, swr=86400`); RSC/router requests and `/health` are never cached. | Vercel minimal mode would let a forged RSC request poison a shared key. | VERCEL.md §3 |
| D-009 | **CSP allows `'unsafe-inline'`** for scripts/styles. | Next.js inline payload and Recharts; acceptable with no accounts or user content. Revisit before accounts. | PRODUCTION-READINESS.md L5 |
| D-010 | **Momentum V1 Balanced is the only shipped model.** Grade, P(MLB), Similarity, Breakout, Prospect Priority, Pure Performance need owner-approved methodology. | Formulas must be defensible before users rely on them. | ANALYTICS.md, CLAUDE.md |
| D-011 | **Ingestion guarantees are never weakened for performance**; one transaction per apply; bulk writer (~30 round trips). | Data integrity and replay safety. | CLAUDE.md, INGESTION.md |
| D-012 | **MLB Stats API is development-only** until licensing is resolved; no scraping of proprietary sites; no bulk export. | Terms: individual, non-commercial, non-bulk. | DATA-LICENSING.md |
| D-013 | **Agent workflow:** agents branch from `staging`, open PRs, watch CI, run `verify:preview`; merges, Production, settings, secrets and ingestion need the owner. Project settings deny merge/Production commands. | Autonomy with hard safety boundaries. | AUTONOMOUS-WORKFLOW.md |
| D-014 | **Deployment Protection stays on for all deployments**; agents use one Protection Bypass for Automation secret, header-only, scoped to the deployment's own host. | Private previews without disabling protection. | AUTONOMOUS-WORKFLOW.md §3 |
| D-015 | **The Momentum golden test is bit-exact and Linux is the canonical platform.** It fails on macOS arm64 (1 of 2638 outputs, `Math.tanh` last bit). Never regenerate or loosen it; verify on CI. | Exactness catches real regressions; libm differences are not regressions. | TASKS.md T-305 |
| D-016 | **Staging merges are human until the owner approves the guarded path** (`npm run gate:staging` is check-only). Sensitive paths (CI, agent rules, config, schema, ingestion writes, gates, lockfile) always need a human. | Least privilege; the gate is reviewed before it gains merge power. | `scripts/staging-gate-support.ts` |

## Proposals awaiting the owner

| Id | Proposal | Status |
|---|---|---|
| P-001 | Guarded staging merges: one allowed command (`npm run merge:staging`) that re-runs the gate and merges with `--match-head-commit` only on `ready`; raw `gh pr merge` stays denied. | needs-approval (T-105) |
| P-002 | Branch protection for `main` and `staging` (PR required, CI checks required, no force push). | needs-approval (T-106) |
| P-003 | Age relative to level: level median age from the snapshot, shown as ± years. | needs-approval (T-401) |
| P-004 | Breakout detection, Prospect Grade, Similarity: methodology documents first, validation plan, no implementation until approved. | needs-approval (T-402..404) |
