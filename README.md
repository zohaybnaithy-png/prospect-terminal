# Prospect Terminal

A **MiLB-first, player-first discovery and development platform** built around “Who should I know about right now?” Discover a performer, understand the performance and development, then explore organization, affiliate, or league context. Organizations are useful context, not the gate to finding players.

## Current development preview

The MiLB-first foundation now has a light, editorial baseball front page: a compact game strip, two lead stories, visual highlight previews, Trending Prospects, Top Prospects, and recorded fictional call-ups. Detailed research tables and filters remain on the inner pages. The shared navigation covers Home, Players, Organizations, Leagues, Data, Screener, and News. Player pages connect statistics, assignment history, trajectory, and related stories. `/teams` and existing team/player IDs remain available; `/market` redirects to the homepage.

**All players, parent organizations, affiliates, statistics, stories, assignments, Grades, and Momentum values are fictional.** The preview contains 18 stable demo players (including a two-way player), three invented parent organizations, 13 teams, five affiliated levels, and an AFL-style context. It represents a fictional snapshot ending October 24, 2026, not a real baseball schedule or live feed. No real player or club is assigned fabricated statistics.

The homepage Trending Prospects widget uses the existing priority demo order with small 7D/14D/30D and level controls. Top Prospects is a separate illustrative overall-Grade list. Scores and editorial/media presentation fixtures live in `src/data/demo-home.ts`; they are never written to the database. Original local SVG baseball artwork stands in for approved imagery. Highlight links open explicit storyboard previews, not fake video players. The call-ups section reuses existing fictional affiliate promotions and their player-development links.

### Discovery modes and filters

- On the detailed discovery pages, **Prospect Priority** is the default, with **All Levels + 14D + All players**. Its hand-authored demo order highlights higher-level performance and developmental context.
- **Pure Performance** uses a different hand-authored order. A Single-A performer can lead ahead of AAA/AA players.
- Levels/contexts: AAA, AA, High-A, Single-A, Rookie/Complex, and Arizona Fall League.
- Timeframes: 7D, 14D, 30D, and Season. Each selects an explicit fictional statistical snapshot and its independently authored order. These windows are **not calculated from game logs**. Season means the current playing-team stint; affiliated and AFL stats are not combined.
- All, Hitters, and Pitchers are supported; the two-way player appears in both role filters. Data has wider hitting/pitching tables. The Screener adds organization, team, position, age, Grade, and Momentum controls.
- Column sorting orders the displayed raw statistic; it is separate from the selected demo discovery order. The `#` column preserves the selected fixture-order reference. Grade and Momentum are as-of-snapshot illustrative values, not recomputed by the timeframe control.

There is **no** Prospect Priority formula, Pure Performance formula, real Grade/Momentum algorithm, ML, scraping, external baseball integration, authentication, or payments. Real methodology follows legitimate data-source selection and ingestion.

## Stack and local setup

Next.js 16 App Router, React 19, strict TypeScript, Tailwind CSS 4, PostgreSQL/Drizzle, Recharts, Zod, and ESLint. No new application dependencies were needed for the redesign. The shared visual system uses white backgrounds, light-gray separators, restrained teal links, compact system sans-serif typography, and traditional baseball-stat tables. The homepage is editorial rather than a full leaderboard.

Node.js 22+ and npm are required; Node 24 was used for validation. PostgreSQL is **optional** for the UI.

```sh
npm ci
npm run dev
```

The server uses port 3000. Demo rendering requires no `.env` file and no live database. Even when `DATABASE_URL` is present, the app deliberately uses the demo repository until an explicit production repository is implemented.

```sh
npm run typecheck   # Generate Next.js route types, then tsc --noEmit
npm run lint
npm test
npm run build
npm start
```

Use `PORT` for another server port. Tests cover the original foundation, fixture integrity, all discovery orders, combined filters, window samples, two-way roles, AFL affiliation, stable IDs, and schema metadata.

## Environment variables

See [.env.example](.env.example). Never commit credentials.

| Variable          | Purpose                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`    | PostgreSQL URL for database commands or future database-backed services; not required by the demo UI |
| `ALLOW_DEMO_SEED` | Explicit `true` opt-in to seed a disposable development database                                     |
| `PORT`            | Optional Next.js server port (default 3000)                                                          |

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

| Path                       | Responsibility                                                               |
| -------------------------- | ---------------------------------------------------------------------------- |
| `src/app`                  | Server-rendered routes and shared layout                                     |
| `src/components/discovery` | Compact shared discovery/filter experience                                   |
| `src/components/ui`        | DataTable, entity links, headings, Grade/Momentum display                    |
| `src/components/data`      | Statistical and affiliate tables                                             |
| `src/components/market`    | Refactored home composition, player table, trajectory chart, news list       |
| `src/data/demo.ts`         | Isolated fictional entities, windows, histories, and explicit ranking orders |
| `src/services`             | Typed repository boundary and demo discovery selection                       |
| `src/db`                   | Preserved Drizzle core, additive organization model, lazy PostgreSQL utility |
| `scripts`                  | Opt-in seed and foundation/discovery tests                                   |
| `docs`                     | Product, architecture, migration notes, roadmap, and review criteria         |

## Deployment and next phase

The demo remains compatible with Vercel and needs no credentials. Database-backed operation requires a provider-supported pooled connection, reviewed migrations, and an explicitly selected repository implementation. Do not seed production.

Next: research legitimate MiLB/AFL APIs, datasets, or licensed feeds, then define provider contracts and identity-resolution requirements. Do not start real ingestion or ranking methodology implicitly as part of this UI phase. NCAA/amateur coverage is a potential later expansion.

See [Architecture](docs/ARCHITECTURE.md), [Roadmap](docs/ROADMAP.md), [Product redesign review](docs/REDESIGN.md), and [Current visual design](docs/VISUAL-DESIGN.md).
