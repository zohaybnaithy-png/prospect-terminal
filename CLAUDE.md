# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

# Prospect Terminal

Player-first baseball prospect / player-development analytics platform. The central object is the **player**; organizations, affiliates, leagues, levels and games are context. Not a generic sports dashboard, not team-first navigation.

## Correct checkout

On the owner's Mac, work only in `/Users/ZohaybNaithy/prospect-terminal/prospect-terminal` (the inner directory, which has the `ingest:afl` script). The outer `/Users/ZohaybNaithy/prospect-terminal` is an older, separate repo copy — do not edit it. In cloud sessions the clone root is the correct checkout.

## Stack

Next.js App Router (a recent version with breaking changes — see AGENTS.md), TypeScript, Tailwind, PostgreSQL (Neon for live dev), Drizzle ORM, Zod, Recharts, Node ingestion scripts run via `tsx`. Don't add infrastructure without justification. Future modeling may use Python/pandas/scikit-learn.

Scripts are in `package.json`; check it rather than assuming. There is no `db:check` script.

## Commands

- `npm run dev` / `npm run build` / `npm start` (port 3000; without `DATABASE_URL` real-data sections show a "not connected" state).
- `npm run typecheck` (`next typegen && tsc --noEmit`), `npm run lint`, `npm test` (every `scripts/*.test.ts`, node:test via tsx).
- One file: `node --import tsx --test scripts/<name>.test.ts`; one test: add `--test-name-pattern="<substring>"`.
- E2E against a real `next build` + `next start` (fictional snapshot, unreachable DB): `npm run test:cdn:e2e`, `test:nav:e2e` (headless Chromium), `test:views:e2e`. They leave `.next/` holding a snapshot build; run `npm run build` afterwards. CI (`.github/workflows/ci.yml`) runs checks + these three.
- `*.integration.ts` (`npm run test:*:db`) need disposable PostgreSQL databases (see each file's env var); never point them at Neon.
- Momentum golden file (`scripts/fixtures/momentum-golden.json`): only regenerate with `MOMENTUM_GOLDEN_UPDATE=1` after an approved formula change, never to make a test pass.
- Next.js 16.4 refuses about every other `next build` when it detects an AI agent outside CI (`SecurityFatalError`, upgrade nudge); rerunning immediately succeeds. `test:nav:e2e` builds twice in a row, so its redeploy test cannot pass locally under an agent; CI is authoritative. Upgrading Next.js is the owner's decision.

## Request path (big picture)

Every page and `/health` go through `getCompetitionData()` (`src/services/competition/index.ts`, server-only): a process-wide level cache (`cache.ts`, `source-cache.ts`) loaded either from PostgreSQL (`load.ts` → `src/services/afl/queries.ts`, database mode) or from build-time snapshot files (`snapshot-store.ts`, `PT_DATA_SOURCE=snapshot`). `src/instrumentation.ts` starts the warm-up at boot. Pages then call pure, per-snapshot-memoized view functions: `services/competition/prepare.ts` (Trending, Trends lists/map, coverage), `services/players/adapter.ts` (directory rows), `services/competition/moves.ts`, `model.ts` (default level, cross-level presence), which call the Momentum engine in `src/analytics`. `src/proxy.ts` does rate limiting / traffic protection; `src/lib/cdn-cache.ts` the CDN header rules.

Next.js bundles instrumentation and route handlers separately, so per-process state shared between them (caches, memos, diagnostics) lives on `globalThis` via `Symbol.for(...)` / `src/lib/process-memo.ts`, never in module-level variables.

## Current phase: trustworthy real data (AFL + MiLB Data Foundation V1)

- AFL: Arizona Fall League, season 2026, MLB Stats API (`mlb-stats-api`), leagueId 119, sportId 17, six clubs.
- MiLB (ingestion + site integration): Triple-A/Double-A/High-A/Single-A = sportId 11/12/13/14, verified against `sports/{id}` names at runtime; leagues, affiliates and parent orgs (`parentOrgId` → sportId 1) are discovered per season, never hardcoded. Adapter `src/ingestion/sources/milb-stats-api.ts`, orchestrator `src/ingestion/milb-runner.ts`, CLI `npm run ingest:milb`, levels `src/domain/levels.ts`. Details: `docs/MILB-INGESTION.md`. Site: `src/services/competition` loads every level; pages take `?level=`; statistics/Momentum are always per level (no cross-level blending or normalization). Neon load procedure: `docs/MILB-NEON-RUNBOOK.md`.
- Same provider namespace as the AFL: one internal UUID per player/org/game across AFL and MiLB. Season identity `milb-{year}`; level identity `milb:{sportId}:{leagueId}` (one `levels` row per league). No per-level tables.
- MiLB backfill = structure pass + date-chunked game captures (one transaction per chunk, resumable via the summary's `resumeFrom`). `--incremental` starts a lookback before the latest stored complete game and skips boxscores of games already complete (except a short refetch window). The fixture source is a synthetic offline dry run only.
- Not yet validated against the live API or a real database; follow the validation steps in `docs/MILB-INGESTION.md` before any shared-database apply.
- Boundary: `SourceAdapter → normalized records → planner (buildPlan) → PostgresIngestionSink`. Provider-specific acquisition stays separate from normalized/internal data so providers can be swapped or licensed later.

### Ingestion guarantees — never weaken for performance

Stable external source IDs, internal UUID PKs (provider IDs live only in `source_identities`), provenance, strict validation, a single transaction per apply, replay safety/idempotency, correction handling, freshness (stale-snapshot) checks, source ownership protection, quarantine, rollback safety, optional-field preservation, source-independent normalized records.

### AFL schedule edge cases (already solved — do not undo)

- 867710, 867709: postponed Oct 12 + completed Oct 14 representations of one gamePk → reconcile via reciprocal reschedule metadata, keep completed score/time/venue, one boxscore per game. Notice `reconciled-reschedule`.
- 867649: Fall Stars exhibition (teams 1310/1311) → excluded, notice `excluded-exhibition`.
- 867642–867638: postseason placeholders with team 55 "To Be Determined" → notice `deferred-participants`.
- Notices are informational, not issues. Unlinked duplicates, contradictory metadata, malformed records and unknown opponents still quarantine. Foreign games are filtered only with explicit league+sport evidence.

### Writer performance

`PostgresIngestionSink.apply` must not issue per-record queries: Neon round trips are ~58 ms, and the old per-record writer needed ~13k of them (~13 min). It reads state in bulk, runs every safeguard in memory in planner order (tracking its own pending writes), then writes in bulk per table, all in one transaction (~30 round trips). Keep new checks inside that in-memory pass.

`contentHash` hashes the normalized batch, so it is the same across captures of unchanged data. `rawContentHash` and the stored response manifest identify the raw capture. Roster observations are keyed by capture time, so a replay with a new capture legitimately reports one insert per roster observation.

Expected clean live AFL snapshot (`afl:2026:all:season:end:all`): 2680 records, 0 issues (subject to legitimate upstream changes).

Scale rules (needed for MiLB volume): apply/preview read only identities and record state referenced by the batch; keep bulk grouping linear; large adapters must not retain raw bodies (`MlbClient` `retainBodies: false`, boxscore projection) and supply `rawContentHash` from the response manifest.

### Vercel target (Phase 6B)

`PT_DATA_SOURCE=snapshot` serves levels from a build-time snapshot (`npm run build:vercel` → `snapshot:export` → `snapshot:views` (precomputed per-level view models; `PT_PRECOMPUTED_VIEWS=off` disables) → `next build`; `.data-snapshot/` is git-ignored, never commit it). Snapshot mode never opens a database connection at runtime. On Vercel (`VERCEL=1`): identity header `x-vercel-forwarded-for`, immediate refusals, indexing off unless production + `PT_INDEXING=on`, Web Analytics path-only. Links come from `@/components/ui/app-link` (prefetch off). Details: `docs/VERCEL.md`.

- `PT_DATA_SOURCE` must be exactly `snapshot` for both the Vercel build and runtime. Otherwise the build still succeeds but silently skips snapshot tracing and the views fingerprint, and the deployment runs in database mode (on a Preview, `/health` then answers `unavailable` with views `off`).
- Precomputed views (Phase 2B, `src/services/competition/views-*.ts`): per-level view models are computed at build by the page functions and decoded lazily on a memo miss. The encoding preserves object identity (RSC payload parity), and any failed check falls back to live computation. Parity is enforced by `scripts/precomputed-views.test.ts` and `test:views:e2e`; keep it byte-identical. On Vercel Preview only, `/health` adds a coarse `views` object (`on`/`off`/`pending`, decoded/fallback counts); Production `/health` output must stay unchanged.
- Navigation (Phase 2A): `experimental.staleTimes.dynamic = 300` (router cache) and a delayed `useLinkStatus` pending hint. Do not add `loading.tsx`: streaming fixes the status at 200 and turns unknown-player 404s into soft 404s (guarded by `scripts/navigation.test.ts`).

### Database safety

- Credentials come from the shell env (`INGESTION_DATABASE_URL`, etc.). Never print, log, commit or ask for connection strings; errors must not leak them.
- Migrations: `DATABASE_URL="$INGESTION_DATABASE_URL" npm run db:migrate`. Don't add migrations unless genuinely required.
- Never run a live `--apply`, truncate/drop/reset, or destructive cleanup against Neon without explicit user approval in that conversation.
- The pg "SSL modes ... treated as aliases for verify-full" warning is cosmetic, not a failure.
- CLI progress/diagnostics go to stderr; stdout carries only the final JSON report.

## Analytics not yet defined

Prospect Grade, Momentum, Prospect Priority, Pure Performance, P(MLB), Similarity, Breakout detection are planned but their formulas are **not** finalized. Do not invent or implement final versions without discussion.

Momentum V1 lives in `src/analytics` (see `docs/ANALYTICS.md`). Balanced is the approved V1 weighting (`DEFAULT_MOMENTUM_MODEL`); production-heavy and skills-heavy remain only in the development comparison tooling. Change weights, confidence thresholds or persistence rules only with discussion.

## UI / design (preserve)

Light, information-dense, Baseball Savant / FanGraphs-like: white background, charcoal text, thin gray borders, restrained teal accent, compact data typography, desktop-first. Avoid dark AI dashboards, gradients, neon/glow, glassmorphism, oversized cards, excess whitespace. Don't revert to dark mode or redesign unless asked. Logo is a stitched baseball circle, no tagline (`prospect-terminal-logo.png` at repo root, imported by `src/components/layout/header.tsx`). Every route shows real ingested data or an honest "not available" state; `src/data/demo.ts` fixtures are for tests and the opt-in dev seed only, never imported by a route.

## Data licensing

MLB Stats API use is for development; licensing must be checked before public/commercial launch. Never scrape FanGraphs, Baseball Savant, Baseball America, TrackMan or other proprietary sources without explicit discussion and rights.

## Working style

Inspect before editing; targeted changes; no unrelated refactors while debugging. Run relevant tests, `npm run typecheck`, `npm run lint`, and `npm run build` when appropriate. Never weaken or delete tests, or replace validation with permissive behavior, to get green. Don't commit or push unless asked. For significant fixes report: root cause, files changed, before/after behavior, safeguards preserved, tests run, open uncertainty.
