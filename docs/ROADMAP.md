# Roadmap

## Phase 1 — MiLB-first product foundation and UI

Implemented: player-first discovery, Prospect Priority/Pure Performance demo modes, timeframe/context/type controls, compact statistical tables, player pages, organization/affiliate context, league pages, Data, Screener, chronological news, and fictional development trajectories. Preserve the Next.js/Drizzle core, stable identities, historical memberships, and database-independent demo mode. No real discovery/scoring methodology exists yet.

## Phase 2 — Research legitimate MiLB/AFL data sources

Determine permitted APIs, public datasets, licensed feeds, and external-link options. Verify licensing, coverage, field definitions, historical availability, rate limits, and redistribution rights. Evaluate organization/affiliate/AFL identifiers and player identity coverage. Do not assume access to FanGraphs or Baseball Savant proprietary data.

The project owner verified local Stats API access and AFL identifiers (league 119, sport 17, season 2026). A local live-source-capable adapter is implemented and tested using synthetic native-shaped responses. Actual source verification runs locally; this cloud task intentionally makes no connectivity probe.

## Phase 3 — Real game/season ingestion and identity resolution

Infrastructure implemented with fictional fixtures: adapter contracts, Zod validation, separate external-ID mappings, provenance, atomic idempotent game writes, quarantine, and correction/ownership checks. The local MLB adapter now supports discovery, rosters, schedule and completed boxscores. Synthetic contract and database tests pass; real local dry-run validation, additional response variants, provider season comparisons, and production reconciliation remain. Preserve assignments, parent-organization history, two-way roles, and separate regular/fall-team statistics. Quarantine ambiguous identities and test incremental updates. Select an explicit database repository only after validation.

Stored-game rolling aggregation is implemented for 7D/14D/30D/season and custom inclusive dates, scoped by league and season. It remains disconnected from the UI.

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
