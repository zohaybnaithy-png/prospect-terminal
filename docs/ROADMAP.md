# Roadmap

## Phase 1 — MiLB-first product foundation and UI

Implemented: player-first discovery, Prospect Priority/Pure Performance demo modes, timeframe/context/type controls, compact statistical tables, player pages, organization/affiliate context, league pages, Data, Screener, chronological news, and fictional development trajectories. Preserve the Next.js/Drizzle core, stable identities, historical memberships, and database-independent demo mode. No real discovery/scoring methodology exists yet.

## Phase 2 — Research legitimate MiLB/AFL data sources

Determine permitted APIs, public datasets, licensed feeds, and external-link options. Verify licensing, coverage, field definitions, historical availability, rate limits, and redistribution rights. Evaluate organization/affiliate/AFL identifiers and player identity coverage. Do not assume access to FanGraphs or Baseball Savant proprietary data.

## Phase 3 — Real game/season ingestion and identity resolution

Build provider contracts, Zod validation, normalized external-ID mappings, provenance, idempotent writes, and reconciliation workflows. Preserve assignments, parent-organization history, two-way roles, and separate regular/fall-team statistics. Quarantine ambiguous identities and test incremental updates. Select an explicit database repository only after validation.

## Phase 4 — Real recent-performance discovery

Implement verified game-window aggregation for 7D/14D/30D/season, date bounds, sample sizes, context eligibility, and data freshness. Establish trustworthy raw-stat leaderboards before interpreting developmental importance. Never mix missing data with fabricated fallback records.

## Phase 5 — Prospect Priority / Pure Performance methodology

Design, document, and evaluate the two methods using real data. Establish developmental context, age/level treatment, sample reliability, and transparency. Independently define Prospect Grade and Momentum; version and backtest models, preserve history, and expose uncertainty. The current hand-authored demo arrays are not a starting mathematical formula.

## Phase 6 — Development trajectories, promotions, news, highlights

Connect sourced events and memberships to timelines and historical context. Add licensed news/highlights, transaction provenance, evidence-backed explanations, and more complete historical statistical views. Preserve organization identity during AFL assignments and support trades without replacing player IDs.

## Phase 7 — Advanced analytics / scouting / ML

Explore permitted tracking data, traditional scouting information, richer splits, comparisons, and evaluated modeling only when reliable coverage and appropriate rights exist. Do not fabricate unavailable measurements. Authentication, monitoring, and operational security need separately scoped work before personalized/public production features.

## Phase 8 — Potential NCAA/amateur expansion

Evaluate NCAA, JUCO, and high school sources and identity continuity with professional baseball. Reuse existing League/Level/Conference, memberships, stable players, and stat models. MiLB/AFL remain the immediate product focus.
