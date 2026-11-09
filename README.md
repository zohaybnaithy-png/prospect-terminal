# Prospect Terminal

A **MiLB-first, player-first discovery and development platform** built around “Who should I know about right now?” Discover a performer, understand the performance and development, then explore organization, affiliate, or league context. Organizations are useful context, not the gate to finding players.

## Current status — Showcase V1

Prospect Terminal is a player-first prospect analytics product. The core loop is **Home → spot a trending prospect → Players (search/filter/sort) → Player profile (performance, trajectory, Momentum, recent games)**. Every number shown in the app comes from real ingested box scores; anything without a legitimate source shows an honest "not available" state instead of placeholder content.

| Route           | What it shows                                                                                                                                                                                                                                                            | Data            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `/`             | Score strip, **Trending Prospects** (Momentum risers/cooling, hitters/pitchers, 7D/14D/30D), Latest Results (top box-score lines from the latest game date), Recent Leaders (OPS / strikeouts), **Level Moves** (first game at a new MiLB level, from box scores), Data Coverage, Not Yet Available (news, video, transactions, rankings: need a source). Live panels are tagged | Real AFL + MiLB |
| `/players`      | Scouting-style directory: search, level, team, organization, position, min PA/BF, stat window, sortable columns incl. Momentum, pages of 50/100/250. Filtered, sorted and paginated on the server; all state in the URL (works without JavaScript) | Real AFL + MiLB |
| `/players/[id]` | Identity/bio, season + last-14-day stat strips, Momentum panel (value, band, confidence, persistence, 7D/14D/30D, decomposition), recent games, Momentum and recent-vs-earlier charts, What changed?, window splits, same-level percentiles, levels this season, full game log, roster observations | Real AFL + MiLB |
| `/trends`       | Biggest Risers & Fallers by component, Performance × Momentum map. The page embeds hitters · 14D; other role/window selections load from `/trends/data` | Real AFL + MiLB |
| `/data`         | Coverage, level status, Momentum methodology, statistics glossary, metrics in development                                                                                                                                                                                | Real AFL + MiLB + docs |
| `/health`       | Health check for the host: 200 once every level's data is loaded, 503 while starting (in-memory state only, no database query) | Server state |

**Real data:** 2026 Triple-A, Double-A, High-A, Single-A and Arizona Fall League (MLB Stats API, development use), each loaded as its own level: schedule/scores, rosters and MLB organization observations, player bio fields, and per-game batting/pitching lines. Stats count only final games with complete box scores. Without `DATABASE_URL` (or if the database is unreachable) every real-data section shows a not-connected / temporarily-unavailable notice in place; the layout stays intact and nothing falls back to fictional data.

**Momentum:** V1 (Balanced weighting) from `src/analytics`, unchanged by Showcase V1 — see [docs/ANALYTICS.md](docs/ANALYTICS.md) and `/data#momentum`. It measures change vs. a player's own earlier games, with confidence (sample size) and persistence; it is not a talent grade or MLB projection.

**Not available yet (honest empty states, no formulas implemented):** MLB-wide top-prospect rankings (`src/services/rankings.ts` returns `unavailable`), Prospect Grade, P(MLB), breakout detection, similarity, news, highlights and call-ups. The former fictional demo routes (`/news`, `/highlights`, `/screener`, `/organizations`, `/teams`, `/leagues`, `/market`) were removed and redirect to the closest real page. The fictional fixtures in `src/data/demo.ts` remain only for automated tests and the opt-in dev seed; no route imports them.

### Levels: MiLB + AFL integration

All five levels share one read path and one player identity:

- `src/services/competition/` — `getCompetitionData()` (server-only) loads the AFL with `loadAflSnapshot` and each MiLB level with `loadMilbLevelSnapshot` (no new queries), each in its own read-only transaction, and reports per-level status (`ok` / `empty` / `unavailable`) so partial coverage is shown honestly. `model.ts` holds pure selectors: default level (most recent completed game), per-level coverage, and a player's presence across levels.
- `src/services/players/adapter.ts` — maps any level snapshot onto `PlayerDirectoryRow`. A level scope lists that level's rows; "All levels" shows **one row per player** from the level of their most recent game, with the other levels listed beside it.
- **Momentum per level.** Momentum, percentiles and trending lists run the unchanged V1 engine on one level's snapshot: each player's recent games vs. their own earlier games *at that level*, normalized by that level's population. Nothing is summed, averaged or ranked across levels, and no level-of-competition adjustment is applied (none is approved).
- **Routes.** `/`, `/trends` and `/players` take `?level=` (`aaa`, `aa`, `high-a`, `single-a`, `afl`). Profiles are `/players/<uuid>?level=…` and default to the player's most recent level, with a level switcher and a per-level season table.

The safe Neon load procedure is in [docs/MILB-NEON-RUNBOOK.md](docs/MILB-NEON-RUNBOOK.md).

## Stack and local setup

Next.js 16 App Router, React 19, strict TypeScript, Tailwind CSS 4, PostgreSQL/Drizzle, Recharts, Zod, and ESLint. The visual system is light and dense (Baseball Savant / FanGraphs-like): white backgrounds, thin gray borders, restrained teal accent, compact tables.

Node.js 22+ and npm are required; Node 24 was used for validation. PostgreSQL is **optional** for the UI.

```sh
npm ci
npm run dev
```

The server uses port 3000. Without `DATABASE_URL`, real-data sections render an explicit "not connected" state; they never fall back to fictional data.

## Real AFL data in the UI

`src/services/afl/` is the server-side read layer between the existing Drizzle schema and the pages:

- `queries.ts` loads the AFL season once per request window inside a single `READ ONLY`, `REPEATABLE READ` transaction (PostgreSQL rejects any write; all reads see one consistent snapshot). League and season are resolved through `source_identities` (`mlb-stats-api`, league 119, season `afl-2026`); provider IDs never leave this file, and `players.external_ids` is not selected.
- `read-model.ts` holds pure, unit-tested selectors (directory rows, recent performers, scoreboard, player profiles). Rates reuse `src/statistics/aggregate.ts`, windows reuse `windowBounds`, and only final games with complete box scores count — the same rules as `GameStatisticsRepository`. Windows end at the latest completed AFL game date, not the wall clock.
- `src/services/competition/index.ts` (`server-only`) reads `DATABASE_URL`, keeps each level in a stale-while-revalidate cache (`cache.ts`: a cheap ingestion-version probe at most every 60 s, background reload only when a run was applied, previous snapshot served meanwhile; warmed at server start by `src/instrumentation.ts`), and maps failures to `not-configured` / `empty` / `unavailable` states. Only a coarse error code is logged; connection details never reach logs or the browser.

Player → AFL team / MLB organization comes from the latest `source_roster_observations` row (participation evidence, not dated transactions); a missing affiliation is shown as unresolved, never inferred. AFL team and organization links open the filtered player directory (`/players?team=…`, `/players?org=…`).

Homepage view models live in `src/services/home.ts` (pure, tested). Recent Leaders and Latest Results are descriptive raw-stat sorts (stated in the UI), not ranking models. Because the score strip in the root layout reads request-time data, all routes render dynamically.

Use a read-only database role for the app's `DATABASE_URL` where possible. `npm run test:afl:db` checks the read layer's SQL against a fresh, migrated, disposable `prospect_afl_read_test` database (`AFL_READ_TEST_DATABASE_URL`); never point it at Neon.

```sh
npm run typecheck   # Generate Next.js route types, then tsc --noEmit
npm run lint
npm test
npm run build
npm start
```

Use `PORT` for another server port. `npm test` covers ingestion, the AFL read model, analytics/Momentum, the Showcase view models (`scripts/showcase.test.ts`), and the fictional fixtures.

## Environment variables

See [.env.example](.env.example). Never commit credentials.

| Variable          | Purpose                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`    | Server-side PostgreSQL URL. The app reads AFL data from it (read-only transactions); also used by database commands. Optional: without it, real-data sections show a "not connected" state |
| `ALLOW_DEMO_SEED` | Explicit `true` opt-in to seed a disposable development database                                                                                                                           |
| `PORT`            | Optional Next.js server port (default 3000)                                                                                                                                                |

The lazy database client opens a pool only when requested. TLS behavior comes from provider-supported connection settings; verification is not disabled.

## Database workflow

`drizzle/0000_*.sql` is the preserved foundation migration. `drizzle/0001_*.sql` is **additive**: organizations, dated player/organization memberships, nullable parent organization on Team, and an assignment-type field on existing team memberships. It does not delete or replace existing player IDs, membership records, statistics, or history.

```sh
npm run db:generate                  # Offline schema/migration generation
export DATABASE_URL='postgresql://postgres:postgres@localhost:5432/prospect_terminal'
npm run db:migrate
ALLOW_DEMO_SEED=true npm run db:seed  # Disposable development DB only
npm run db:studio
```

Standalone database commands use shell-injected variables; they do not automatically load `.env.local`. Next.js itself loads its usual environment files.

Use a **fresh disposable database** for the new fictional MiLB seed. It refuses production mode and refuses a database containing the previous `demo-ncaa` dataset, leaving those historical records unchanged. Do not erase an existing database to refresh demo context. The new seed is transactional and repeatable with fixed IDs/conflict keys. It stores organization and team memberships separately and retains regular-season and fall-team statistics as distinct stints. It never runs during application rendering. The selected-window fixture snapshots and demo ranking orders are UI-only fixtures; they are not inserted as game logs or model results.

Optional local PostgreSQL (development credentials only):

```sh
docker run --name prospect-postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=prospect_terminal -p 127.0.0.1:5432:5432 -d postgres:17-alpine
# Wait for: docker exec prospect-postgres pg_isready -U postgres
# Then run the migration/seed commands above.
# When finished: docker stop prospect-postgres && docker rm prospect-postgres
```

## Important directories

| Path                     | Responsibility                                                           |
| ------------------------ | ------------------------------------------------------------------------ |
| `src/app`                | Routes: `/`, `/players`, `/players/[id]`, `/trends`, `/data`             |
| `src/components/home`    | Homepage panels (Trending Prospects, Latest Results, Level Moves, coverage, not-yet-available) |
| `src/components/players` | Player directory controls and one server-queried page of rows            |
| `src/components/player`  | Player profile                                                           |
| `src/services/afl`       | Server-only AFL read layer and pure selectors                            |
| `src/services/players`   | Level registry, directory contract, level adapter, `directory-query.ts` (URL state, filter/sort/pagination) |
| `src/services/competition` | All-level loading (AFL + MiLB) and cross-level selectors               |
| `src/services/home.ts`   | Homepage view models; `rankings.ts` is the top-prospects boundary        |
| `src/analytics`          | Momentum V1 (unchanged)                                                  |
| `src/ingestion`          | AFL ingestion worker                                                     |
| `src/data/demo.ts`       | Fictional fixtures for tests / dev seed only — not used by any route     |
| `scripts`                | CLIs and tests                                                           |

## Deployment

Use a read-only database role for the deployed app's `DATABASE_URL`. Do not seed production. Before any public or commercial launch, confirm MLB Stats API licensing.

See [Architecture](docs/ARCHITECTURE.md), [Analytics](docs/ANALYTICS.md), [Ingestion](docs/INGESTION.md), [Roadmap](docs/ROADMAP.md), [Deployment](docs/DEPLOYMENT.md) and the [deployment runbook](docs/DEPLOYMENT-RUNBOOK.md).

## AFL ingestion: local live source and offline fixtures

A separate worker supports the MLB Stats API for **AFL 2026 (league 119, sport 17)**, plus the preserved offline fixture source. First local test:

```sh
npm run ingest:afl -- --source=live --season=2026 --dry-run
```

For real writes, export INGESTION_DATABASE_URL, migrate that database with `DATABASE_URL="$INGESTION_DATABASE_URL" npm run db:migrate`, then add `--apply`. Source discovery, rosters/organization observations, schedule, completed boxscores, raw game lines, and rolling-stat queries are implemented separately from web rendering. `--from`, `--to`, `--team`, `--games-only`, and `--rosters-only` support incremental work. Optional `--record-dir` preserves raw responses for debugging.

The source adapter was tested offline against native-shaped synthetic fixtures, including PostgreSQL replay/correction and aggregation tests. The project owner verified local API access; this cloud task intentionally made no Stats API request. See [INGESTION.md](docs/INGESTION.md) for exact setup, formulas, source boundaries, additive migrations 0002/0003, and known limitations.
