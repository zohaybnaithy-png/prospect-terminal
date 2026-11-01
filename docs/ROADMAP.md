# Roadmap

## Phase 1 — Foundation

Implemented: Next.js App Router, TypeScript, Tailwind, ESLint, PostgreSQL/Drizzle schema and initial migration, lazy database utilities, fictional fixture/seed data, responsive shared layout, market dashboard, player and team routes, basic demo filtering, score-history visualization, and documentation. No real baseball data, authentication, or score algorithms.

## Phase 2 — Real NCAA data ingestion

Select an authorized NCAA D1 data source and confirm licensing and coverage. Define validated provider adapters, normalized identity mapping, provenance, idempotent ingestion, historical season retention, and transfer handling. Test against provider fixtures and reconcile records before replacing demo mode. Add data freshness and failure reporting.

## Phase 3 — Player/team discovery

Connect repository read models to verified database records. Add paginated search, level/conference filters, deeper profiles, game logs, complete rosters, and richer screening. Preserve historical affiliations and test two-way players and transfers.

## Phase 4 — Prospect Grade + Momentum

Define and validate separate quality and momentum methodologies. Evaluate calibration and bias, version models, retain historical observations, and make changes explainable with verified evidence. Backtest before presenting either metric as decision support.

## Phase 5 — News/highlights

Add licensed news and highlight sources, multi-player story links, optional game-linked media, deduplication, provenance, and reliable editorial context. Validate outbound links and media handling.

## Phase 6 — MiLB expansion

Extend provider adapters to AAA, AA, High-A, Single-A, and Rookie classifications using the existing core entities. Resolve cross-level identities and movement without replacing player IDs or historical statistics. NCAA D2/D3, JUCO, and high school follow source availability and licensing.

## Phase 7 — Advanced analytics/ML

Develop reproducible feature pipelines, evaluation datasets, uncertainty estimates, and model monitoring. Explore cohort comparisons and forecasting only after sufficient reliable historical data exists. Authentication, authorization, operational monitoring, and production access policies require their own scoped work before a public personalized product launch.
