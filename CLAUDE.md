@AGENTS.md

# Prospect Terminal

Player-first baseball prospect / player-development analytics platform. The central object is the **player**; organizations, affiliates, leagues, levels and games are context. Not a generic sports dashboard, not team-first navigation.

## Correct checkout

Work only in `/Users/ZohaybNaithy/prospect-terminal/prospect-terminal` (the inner directory, which has the `ingest:afl` script). The outer `/Users/ZohaybNaithy/prospect-terminal` is an older, separate repo copy — do not edit it.

## Stack

Next.js App Router (a recent version with breaking changes — see AGENTS.md), TypeScript, Tailwind, PostgreSQL (Neon for live dev), Drizzle ORM, Zod, Recharts, Node ingestion scripts run via `tsx`. Don't add infrastructure without justification. Future modeling may use Python/pandas/scikit-learn.

Scripts are in `package.json`; check it rather than assuming. There is no `db:check` script.

## Current phase: trustworthy real data (AFL only)

- Target: Arizona Fall League, season 2026, MLB Stats API (`mlb-stats-api`), leagueId 119, sportId 17, six clubs.
- Do not expand to all of MiLB until the AFL pipeline is reliable.
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

Light, information-dense, Baseball Savant / FanGraphs-like: white background, charcoal text, thin gray borders, restrained teal accent, compact data typography, desktop-first. Avoid dark AI dashboards, gradients, neon/glow, glassmorphism, oversized cards, excess whitespace. Don't revert to dark mode or redesign unless asked. Logo is a stitched baseball circle, no tagline (`prospect-terminal-logo.png` at repo root, imported by `src/components/layout/header.tsx`). Homepage demo data is intentional until AFL data is wired in.

## Data licensing

MLB Stats API use is for development; licensing must be checked before public/commercial launch. Never scrape FanGraphs, Baseball Savant, Baseball America, TrackMan or other proprietary sources without explicit discussion and rights.

## Working style

Inspect before editing; targeted changes; no unrelated refactors while debugging. Run relevant tests, `npm run typecheck`, `npm run lint`, and `npm run build` when appropriate. Never weaken or delete tests, or replace validation with permissive behavior, to get green. Don't commit or push unless asked. For significant fixes report: root cause, files changed, before/after behavior, safeguards preserved, tests run, open uncertainty.
