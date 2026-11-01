# Prospect Terminal

A baseball prospect intelligence workspace: the density of a financial terminal with a focus on baseball’s next generation. The long-term product will bring discovery, rankings, news, highlights, and historical prospect intelligence across NCAA, JUCO, MiLB, and high school baseball into one place.

## Current status

Phase 1 foundation. A responsive, dark application includes Market, Players, player profiles, Teams, team rosters, an initial Screener, and News. Search and basic filters operate on **entirely fictional development data**: four invented teams, 18 invented players (including a two-way player), season statistics, six weekly score observations per player, and three fictional stories. Snapshot date: April 18, 2026, independent of today’s date.

**Every player, team, statistic, Prospect Grade, Momentum value, and story is fictional.** Scores are hand-authored illustrative fixtures. No scoring algorithm, scraping, external baseball integration, authentication, or real player statistics are implemented. The breakout card is an editorial demo selection, not a calculated signal.

## Stack

- Next.js 16 App Router, React 19, strict TypeScript
- Tailwind CSS 4 with a shared terminal-inspired visual system
- PostgreSQL and Drizzle ORM / Drizzle Kit
- Recharts for interactive score-history visualization
- Zod for runtime database configuration validation
- ESLint (Next.js core web vitals and TypeScript)

## Local setup

Node.js 22 or newer (validated with Node 24), npm, and Git are required. PostgreSQL is optional for the UI.

```sh
npm ci
npm run dev
```

Open the development server on port 3000. No `.env` file or database is needed: the UI deliberately uses the demo repository, even if `DATABASE_URL` is set. It makes no external data requests. Fonts use the local system stack.

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

`npm start` serves the production build on port 3000. Set `PORT` to use another port. Type checking includes the database and seed scripts. The tests exercise fixture integrity, repository behavior without credentials, baseball formatting, and schema metadata.

## Environment variables

See [.env.example](.env.example). Never commit credentials or local environment files.

| Variable          | Purpose                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`    | PostgreSQL URL, required only for migration, seed, Studio, or future database-backed services |
| `ALLOW_DEMO_SEED` | Set to `true` explicitly to permit fictional data seeding into a development database         |
| `PORT`            | Optional Next.js server port (default 3000)                                                   |

The database client is lazy and uses a small connection pool. Importing it does not connect. SSL behavior comes from the database URL/provider configuration; verification is not disabled in code. Use your provider’s recommended TLS settings.

## Database workflow

The initial migration is checked in under `drizzle/`. SQL generation works offline:

```sh
npm run db:generate
```

To migrate a database, export `DATABASE_URL` in the shell or inject it through environment settings. Next.js reads `.env.local` for the app; the standalone database scripts intentionally use the shell environment and do not load `.env.local` automatically.

```sh
export DATABASE_URL='postgresql://postgres:postgres@localhost:5432/prospect_terminal'
npm run db:migrate
ALLOW_DEMO_SEED=true npm run db:seed
npm run db:studio
```

Use a disposable development database for the seed. It is transactional, has fixed IDs and unique conflict keys, preserves existing demo records on repeated runs, and refuses `NODE_ENV=production`. Never point it at a real production dataset. Seeding is optional, never occurs during rendering, and does not switch the UI to database mode.

Optional local PostgreSQL with Docker (example development credentials only):

```sh
docker run --name prospect-postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=prospect_terminal -p 127.0.0.1:5432:5432 -d postgres:17-alpine
# Wait until: docker exec prospect-postgres pg_isready -U postgres
# Run the migration and seed commands above.
# Remove the disposable database when finished:
docker stop prospect-postgres
docker rm prospect-postgres
```

The schema covers leagues, levels, conferences, teams, stable players, dated memberships, seasons, games, batting/pitching at game and season granularity, source-scoped rankings, current scores, score history, news/player links, and highlights. Batting averages and ERA are derived from counting statistics. Pitching innings use integer outs, not decimal arithmetic.

## Structure

```text
src/app/                 Shared layout and App Router pages
src/components/layout/   Navigation and global search
src/components/market/   Dashboard, player table, chart, filters, news, spotlight
src/components/ui/       Small shared visual primitives
src/data/                Deterministic fictional fixtures
src/services/            Typed read-model repository boundary
src/types/               UI/domain read-model types
src/db/                  Drizzle schema and lazy PostgreSQL client
src/lib/                 Baseball and display formatting
scripts/                 Opt-in database seed and foundation tests
drizzle/                 Generated SQL migrations and snapshots
docs/                    Architecture and phased roadmap
```

See [Architecture](docs/ARCHITECTURE.md) and [Roadmap](docs/ROADMAP.md).

## Deployment

The app is compatible with Vercel’s Next.js runtime. The current demo needs no secrets. Add `DATABASE_URL` securely when database-backed services are implemented; use a provider-supported pooled URL and apply reviewed migrations separately from the application build. Do not seed production. Authentication, real ingestion, monitoring, and production analytics remain future work.
