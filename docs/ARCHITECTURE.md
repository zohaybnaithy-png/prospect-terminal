# Architecture

## Product and read-model boundaries (Showcase V1)

Prospect Terminal is player-first: discovery → player → performance/trajectory → context. All user-facing routes read real data through the server-only `src/services/afl` layer (one cached, read-only snapshot per 60 s) and pure view-model functions:

- `src/services/home.ts` — Trending Prospects (V1 risers/fallers + recent-window stat lines), Latest Results, coverage.
- `src/services/players/` — level registry (derived from `src/domain/levels.ts`), the client-safe `PlayerDirectoryRow` contract, and the level adapter used for the AFL and every MiLB level.
- `src/services/competition/` — loads every level through `loadAflSnapshot` / `loadMilbLevelSnapshot` with per-level status; pure cross-level selectors (default level, coverage, player presence). Statistics and Momentum are always computed within one level.
- `src/services/rankings.ts` — MLB-wide rankings boundary; returns `unavailable` until a legitimate source or approved model exists.
- `src/analytics/views.ts` — Momentum view models (unchanged formulas).

Server components build serializable rows; small client islands handle instant filtering/sorting (Players, URL-synced via `history.replaceState`), Momentum toggles, and charts. Client components import only client-safe modules (types, formatting, filters); the analytics engine stays on the server. Failures map to `not-configured` / `empty` / `unavailable` notices inside the normal layout; error boundaries show generic messages only.

The fictional fixtures (`src/data/demo.ts`, `src/services/prospects.ts`, `src/services/discovery.ts`) remain solely for tests and the opt-in seed. Retired demo routes redirect (see `next.config.ts`).

## Preserved relational foundation

Player remains a stable internal UUID entity with optional namespaced provider IDs. League/Level remain data-driven, Conference remains available for possible amateur expansion, and Team references Level and optional Conference. The existing Team→Level→League relationship is retained. The AFL fixture uses its own League with a neutral fall-development classification; the UI exposes AFL as a **league context**, not a level above AAA. Additional contexts can be added without changing the filter component or replacing core tables.

Dated `PlayerTeamMembership` records preserve assignments, promotions, transfers, and level movement. The read-model `teamId` is an explicit current-playing-context projection, not an authoritative Player database field. Team pages show the current playing roster; development histories also retain underlying affiliations. Team conference/level realignment, if required later, should use dated affiliations rather than rewriting historical stats.

Batting and pitching remain separate game and season tables. A two-way player can have both. Game lines are unique by player/game; season statistics are unique by player/season/team. Season totals and game logs are separate source snapshots, not additive datasets. Season UI rows are team stints, and AFL/current-assignment totals are never merged with regular-affiliate totals. Pitching stores integer outs; 19 outs formats as 6.1 IP. Historical assignment rows without documented statistics do not produce fabricated historical stat rows.

Existing rankings retain source, positive rank, scope/category, and observation date. Current score snapshots and immutable-style history retain separate Grade, Momentum, observation time, version, and explanation. News/player links remain many-to-many. Highlights remain player-linked and optionally game-linked. No scouting tools, advanced tracking metrics, real game logs, or external ranking records have been invented.

## Additive organization extension (migration 0001)

The professional-development gap is parent organization affiliation. The smallest historical representation adds:

1. `organizations`: internal UUID, name, slug, abbreviation, timestamps.
2. `player_organization_memberships`: player, organization, start/end dates, timestamps; indexed by player with unique stint keys and a date-order check.
3. Nullable `teams.organization_id`: an affiliate’s parent organization. Fall teams may remain null because their roster spans multiple organizations.
4. `player_team_memberships.assignment_type`: a defaulted descriptive field (`assignment`, `promotion`, `afl-assignment` in the demo). The existing table is retained.

The original migration is unchanged. The new SQL only creates tables, adds columns, and adds indexes/foreign keys; it does not backfill invented identities or delete old data. Existing team organization fields remain null until explicitly populated. The assignment default preserves compatibility with existing memberships. A future ingestion transaction must reject inconsistent/overlapping organization stints, reconcile actual trades, and validate team/game/season consistency; those cross-table business rules are not fully encoded in SQL.

### AFL representation

A player can have an open parent-organization membership, an underlying affiliate membership, and a concurrent AFL team assignment. The fall team is not assigned that player’s organization. Two players from different organizations share one fictional fall team in the demo. Organization pages include AFL-assigned players by **player organization membership**, not by the fall team’s nullable parent organization. Player profiles link organization and current playing team separately and show both memberships in development history.

Demo projections are hand-authored and tested against dated memberships. Production current-context resolution must be date-aware and explicitly distinguish active playing assignment from retained organizational/affiliate affiliation.

## Identity and future providers

External provider IDs never become primary keys. Names are not sufficient for matching players, and IDs must survive promotions, trades, levels, fall assignments, and provider changes. The existing small `externalIds` JSON map remains optional. Before multi-provider ingestion, introduce a normalized `(provider, externalId)` mapping with provenance, uniqueness, reconciliation, and audit history rather than changing Player identity.

Research legitimate MiLB/AFL APIs, public datasets, licensed feeds, or permitted external links first. Future adapters should validate raw payloads with Zod, preserve provenance/fetch time/version, quarantine ambiguous identities, and transactionally upsert source-specific idempotency keys. Run ingestion separately from web requests. Do not scrape FanGraphs, Baseball Savant, MLB/MiLB, or proprietary sites, and do not assume redistribution rights. NCAA/amateur adapters are a later expansion; they can reuse existing identities, membership history, and statistics models.

## Development trajectory and explanations

Player anchor navigation covers Overview, Stats, Development, Trends, and News. Game logs, splits, and external rankings are explicitly marked planned because fixtures do not support them. The Development table lists dated fictional assignments/promotions. The trajectory chart preserves existing Grade/Momentum observations with a simple line, readable axes, subtle grid, and tooltip; it has no gradient or visual effects. Related events are listed in the development timeline rather than falsely attributed as causes of score movement.

“Why is this player interesting?” is an explicit fictional editorial note with a future explanation boundary. There is no model-generated causal claim. Future evidence-backed explanations should reference verified input observations and event provenance; score history should append versioned observations and update current snapshots transactionally.

## Operations and data safety

The seed requires explicit development opt-in and a fresh disposable database if the legacy NCAA demo is present. It refuses to relabel those old records or overwrite their historical statistics. New fixtures preserve the original 18 player UUIDs and existing team routes where applicable. Repeating the new seed is transactional and does not duplicate records. DB commands read injected shell variables; the app remains usable without PostgreSQL. `updatedAt` defaults on insert and is maintained on Drizzle ORM updates; direct SQL writers must maintain it themselves.

## Ingestion worker boundary

The source adapter/normalization/plan/transactional sink boundary now lives under `src/ingestion`, separately from all routes and UI repository code. An isolated fictional AFL source exercises organizations, teams, stable player mappings, roster observations, confirmed dated memberships, and two-way game statistics. Additive migration 0002 supplies provenance and reconciliation metadata; the core entity schema is unchanged. See [INGESTION.md](INGESTION.md) for supported behavior, safety properties, official-source investigation limits, and test commands. No real UI data source was selected automatically.

## Live-source-capable AFL worker

The ingestion contract now also has an MLBStatsApiSource for local execution, a centralized JSON client/config, source-specific normalization, and a stored-game statistics repository. UI routes and the demo repository do not import it. Live data uses the same stable UUID mapping and canonical entities as the preserved fixture pipeline. Live normalization may quarantine independent records (holding malformed boxscores coherently) without disabling unrelated data. Additive migration 0003 supports real schedule metadata, optional person/counting fields, and completeness-aware official-date aggregation. See INGESTION.md for the first local command, endpoint coverage, current organization versus historical affiliation semantics, dry-run guarantees, and supported rolling windows.

## MiLB data foundation

Triple-A, Double-A, High-A and Single-A reuse the AFL ingestion contract, provider namespace, planner and transactional sink (see [MILB-INGESTION.md](MILB-INGESTION.md)). Hierarchy: MLB organization (sportId 1) → affiliate team → level row per (sport, league) → MiLB season → games / roster observations / game lines → `src/statistics` aggregation → Analytics V1. `src/domain/levels.ts` is the framework-free level registry. `loadMilbLevelSnapshot` reads one level into the existing snapshot shape, so aggregation and analytics need no MiLB-specific code. No per-level tables and no migration were added.
