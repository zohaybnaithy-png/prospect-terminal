# Architecture

## Product and read-model boundaries

Prospect Terminal is MiLB-first and player-first: discovery → player → performance/development → context. The existing App Router, strict TypeScript, Drizzle/PostgreSQL core, stable UUIDs, lazy database client, and explicit demo repository remain. The UI uses a light editorial baseball front page and compact statistical research pages.

Server pages load serializable read models through `ProspectRepository`. `catalog()` supplies the small fictional universe; no database connection is made during rendering. The homepage is composed from small editorial components: ScoreStrip, HeadlineCard, TrendingProspects, TopProspects, HighlightCard, and RecentCallups. Only the trending timeframe/context controls require a homepage client boundary. Presentation-only scores, story image references, and highlight storyboards are isolated in `src/data/demo-home.ts`; they do not extend backend contracts or change memberships. Highlights link to `/highlights` previews with an explicit no-footage notice.

Search/filter state and sortable player tables live in client components. The trajectory chart is the other main interactive island. No production fallback silently converts real-data failures into demo data, and adding DATABASE_URL does not switch the UI source.

`DataTable<T>` is a presentation-only primitive usable from server and client compositions. `PlayerTable` adds optional column sorting for identity, age, statistics, Grade, and Momentum. Numeric alignment, sticky headers, explicit captions, focusable horizontal scrolling, restrained hover states, and shared entity-link components make the same entities navigable everywhere. Mobile tables retain their information and scroll; there is no decorative sparkline or hidden statistical column system.

## Discovery contract and demo semantics

`DiscoveryFilters` separates ranking mode, context, timeframe, player type, and optional directory/screener conditions. `discoverDemoPlayers()` performs a **lookup of an explicit fixture order**, followed by filters. It assigns no level weights, calculates no ranking score, and does not use Grade as a substitute for recent performance.

`demoDiscoveryOrder` contains a complete ordered set of stable player IDs for each of four windows and two modes. Prospect Priority fixtures favor meaningful higher-level examples; Pure Performance fixtures allow Single-A/Rookie standouts to precede higher-level players. They are independent editorial examples, not implementations of the eventual methodologies. Changing a window selects both a different fictional counting-stat sample and its corresponding authored order. A column sort temporarily reorders the filtered display and preserves the `#` reference to that selected order. Filter changes reset the column sort.

Grade (0–100) and signed Momentum remain separate as-of-snapshot fields; time controls do not relabel those fields as window-derived analytics. Baseball formatting (AVG, ERA, WHIP, innings) derives ordinary descriptive rates from the selected fictional counting stats. It is not a discovery algorithm.

A future real discovery adapter should aggregate validated game-level records for explicit date bounds, context, and minimum samples, then apply a separately specified/evaluated methodology. Recent windows must handle assignments, missing games, timezones, and eligibility explicitly. This phase does not decide those rules. The current fixture windows are not ingested into game-stat tables or treated as calculated production analytics.

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
