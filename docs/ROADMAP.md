# Roadmap

Prioritized path from today's state (see docs/PROJECT_STATUS.md) to launch readiness. Tasks with ids,
acceptance criteria and status live in docs/TASKS.md; this file is the order and the reasoning.
Replaces the 2025 phase list (demo era), which no longer matched the product.

Context that shapes the order (2026-11-24): the 2026 MiLB regular season is complete and the AFL is in
its last weeks, so data freshness matters little until spring 2027; MLB data licensing (docs/DATA-LICENSING.md)
blocks any public launch and is a human/legal decision; advanced models need owner-approved methodology.

## Milestone 1 — Engineering foundation (now)

Goal: agents can ship safely and quickly. Mostly done.

- Autonomous loop, Preview verification, staging merge gate (done: docs/AUTONOMOUS-WORKFLOW.md).
- Project source-of-truth docs (this set) and stale-doc cleanup (ROADMAP, ARCHITECTURE, README deployment status).
- Real-deployment performance baseline captured by `verify:preview` (cold/warm timings per page).
- Remove dead demo-era code paths that no route uses.
- Guarded staging merges and branch protection (needs owner approval: docs/PROJECT_STATUS.md).

## Milestone 2 — Discovery and comparison (high user value, fully unblocked)

- **Player comparison** (`/compare`): 2–4 players, same level, side-by-side lines, within-level percentiles, Momentum, sample sizes.
- **Watchlist** (per-browser, no accounts): star players, a watchlist page with their latest lines and Momentum.
- **Directory depth:** ISO and BABIP columns, age and stat-threshold filters, column presets for hitters/pitchers.
- **Organization and team pages** as context hubs (players by affiliate and level), linked from profiles.
- Typeahead player search.

## Milestone 3 — Performance and reliability

- Per-snapshot player index (removes the `playerLevels` full scan; profile capacity, docs/PRODUCTION-READINESS.md M2).
- Precomputed profile view models if measurements show profiles dominate cold cost.
- DB integration suites in CI with a disposable Postgres service (sensitive: touches .github; owner merges).
- Verify Vercel CDN/identity behavior on a real deployment (VERCEL.md Preview checks 3, 7, 8).
- Mobile and accessibility pass with `scripts/ops/a11y-scan.ts` against the Preview.

## Milestone 4 — Analytics depth (methodology first)

- Standard contextual stats that need no constants: ISO, BABIP, K-BB% (HR/FB and other batted-ball metrics are impossible: no batted-ball data; wOBA/FIP need season constants we cannot derive honestly yet).
- Age relative to level (level median age from the snapshot): proposal → approval → build.
- Methodology proposals (docs/DECISIONS.md, owner decides): Breakout detection, Prospect Grade, Similarity.
  Nothing ships until approved; each needs validation against held-out data.

## Milestone 5 — Data breadth (needs approvals)

- Prior seasons (2024–2025) for history and baselines: ingestion run approval + Neon capacity check.
- Automatic snapshot refresh in-season: scheduled `refresh:data` + Vercel deploy hook (needs a deploy hook and a scheduler secret: owner).
- Transactions / injuries only with a licensed source.

## Milestone 6 — Launch readiness (owner gates)

- Data licensing resolved (permission or licensed provider) — **hard blocker**.
- Vercel plan suitable for the intended use (Hobby is non-commercial).
- Privacy notice, log retention, error monitoring, production verification run (docs/RELEASE_CHECKLIST.md).
- Accounts (only if watchlists/sharing need them).
