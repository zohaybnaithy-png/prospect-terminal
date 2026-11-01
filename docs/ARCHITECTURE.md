# Architecture

## Application boundaries

App Router server components fetch typed read models through `ProspectRepository` in `src/services/prospects.ts`. A deterministic demo implementation supplies all current pages; it never connects to PostgreSQL. Adding a database URL does not silently change the source. A future database repository can implement the same interface and be selected explicitly once ingestion and validation are ready. This avoids mixing demo and real records or hiding production failures behind fictional content.

Client components are limited to navigation state, basic search/filter controls, and Recharts. The server renders route content and passes serializable data to them. Shared layout, accessible navigation, visible fictional-data labels, table captions, focus styles, a skip link, and small-screen table handling are provided. A textual accessible chart description contains every plotted observation. Dates are formatted with an explicit timezone to avoid hydration differences.

The initial route surface is `/`, `/market`, `/players`, `/players/[id]`, `/teams`, `/teams/[id]`, `/screener`, and `/news`. Missing IDs use Next.js not-found handling. Global search submits to the player directory. Screener filters are local demo controls, not a saved query system.

## Relational model

All entities have internal UUID primary keys. League and Level are data rather than a fixed NCAA-only enum: NCAA D1/D2/D3, JUCO, MiLB AAA/AA/High-A/Single-A/Rookie, and high school can be represented without replacing Player or statistics tables. Conferences belong to leagues; teams reference their level and optional conference. Current team classification is stored on Team; if historical conference or level realignment becomes necessary, add dated team-affiliation records rather than rewriting old season statistics.

Player has no authoritative current team column. `PlayerTeamMembership` records the team, season, and start/end dates of a stint. Multiple stints and transfers retain the same player ID. The display model’s `teamId` is a current-team projection for the demo. Real queries must resolve it as of the requested date, rather than treating it as the source of historical truth.

Batting and pitching are separate tables, so a two-way player can have both. Game statistics are unique per player/game; season totals are unique per player/season/team and retain team splits after transfers. Season totals are independent source snapshots, not automatically summed or added to game records. Future ingestion must choose a documented authoritative aggregation strategy to avoid double counting. Each game references a season and distinct home/away teams. Ingestion must validate that a stat line’s team participated in the game and that the player’s membership, season, and level agree; those cross-table business rules are not fully encoded as SQL checks.

Counting stats are stored rather than rounded batting rates. Pitching uses `outsRecorded`; 19 outs is 6.1 baseball innings, and ERA is earned runs × 27 / outs. Fields can expand when a real provider’s contract is understood. Timestamps default on insert, and Drizzle’s `$onUpdate` refreshes `updatedAt` on ORM updates. Direct SQL writers must explicitly maintain that timestamp. Score history is append-oriented and only has a creation timestamp.

Rankings retain source, positive rank, scope, category, and observation date, allowing multiple publishers and categories to coexist. Scope is a namespaced string (future examples: `ncaa:d1:national`, `milb:aa`); it must be normalized during ingestion. No external rankings are currently fetched.

News uses a many-to-many join to players. Highlights reference a player and optionally a game. URLs are references only; there is no embed, scraping, or media ingestion system yet. Foreign keys protect references, unique indexes prevent common duplicates, and the score history has a player/date index for chart reads. Destructive cascading is limited to news join rows when a story is deleted.

## Internal and provider identity

Provider IDs must never be primary keys. A provider may change IDs, merge records, disagree with another source, or omit an ID. Internal UUIDs remain stable across transfers, levels, seasons, and provider changes. Player’s optional `externalIds` JSON object is a small initial namespace-to-ID map, not a canonical identifier. Before multi-provider ingestion, introduce a normalized provider-identity mapping table with unique `(provider, externalId)` constraints, provenance, reconciliation status, and an auditable mapping to internal IDs. Do not match players by name alone.

## Future ingestion strategy

No provider client is implemented in this phase. Future adapters should fetch from licensed or explicitly supported sources, validate raw payloads with Zod at the boundary, and normalize into provider-independent records. Store provenance, fetch times, and provider versions before writing. Resolve external identities to internal UUIDs, then transactionally upsert seasons, affiliations, games, and stat lines using source-specific idempotency keys. Quarantine ambiguous identities and invalid records. Schedule ingestion separately from web requests and respect rate limits, licensing, retry limits, and incremental cursors.

NCAA should establish that pipeline first. MiLB adapters should reuse the same internal Player, Team, Level, Season, and stat models; their provider-specific naming and classification rules belong in adapters, not page components. Player transfers must close or add memberships without deleting historical stats. Build provider contract tests before live imports.

## Prospect Grade and Momentum

Prospect Grade is a 0–100 quality estimate. Momentum is an independent signed movement metric. They are separate database columns and chart series; no formula relates them here. `prospectScores` is the latest read snapshot per player; `prospectScoreHistory` retains observations with grade, momentum, observation time, model version, and optional explanation. A future scoring job should append a versioned history row and update the current snapshot in one transaction, with a policy for backfills and competing model versions. Never overwrite history merely to refresh current values.

All current values and historical observations are fictional fixtures. The six-point demo trajectories and trend narratives are interface examples, not scouting research or an analytics algorithm. The interface labels them accordingly. Evidence-backed explanations, model evaluation, and score calibration belong in Phase 4.

## Database operations

`getDatabase()` validates DATABASE_URL with Zod and creates a connection pool only on demand. Runtime components do not import a live client. Migration generation is offline; migration application and the explicitly opted-in seed need PostgreSQL. Initial migrations are committed. The seed is a development helper using fixed IDs and conflict keys within a transaction, so repeated execution does not duplicate demo records. The application build must remain independent of database availability.

The seed does not populate games or highlights because the UI does not yet display them. They are modeled for future use. Authentication, authorization, real data access, background jobs, score algorithms, and operational production hardening are intentionally outside the foundation.
