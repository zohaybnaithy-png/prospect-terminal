# AFL ingestion: fixture and MLB Stats API sources

## First local test

From the repository root on the developer machine where Stats API access works:

```sh
npm run ingest:afl -- --source=live --season=2026 --dry-run
```

This makes ordinary JSON HTTP GET requests, validates/normalizes responses, and reports proposed record operations and quarantined data. **It does not write to PostgreSQL.** No database is required when INGESTION_DATABASE_URL is unset. If that URL is exported, dry run performs a read-only comparison against an already migrated database and reports insert/update/no-op candidates without writing even an audit run.

The configured target is **Arizona Fall League 2026: leagueId 119, sportId 17**, as independently verified by the project owner. The adapter discovers team IDs/names from the source rather than hardcoding six names. Local API access is known to work; some cloud development environments restrict outbound requests. No live connectivity attempt was made in this task. Offline synthetic-response tests validate the implementation; the first local dry run is the real-source handoff, not an assertion that live responses were exercised here.

## Sources and database workflow

Node.js 22+ and the existing dependencies are sufficient. The app's demo rendering still needs no PostgreSQL or source access. Standalone CLI commands read shell environment variables, not `.env.local` automatically.

```sh
# Original fictional protocol; offline and database-free by default.
npm run ingest:afl -- --source=fixture --season=2026 --dry-run

# Initial live-source inspection, optionally recording responses outside the app.
npm run ingest:afl -- --source=live --season=2026 --dry-run --record-dir=/tmp/afl-responses

# Explicit write target. Use your local PostgreSQL connection securely.
export INGESTION_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/prospect_ingestion_dev'
DATABASE_URL="$INGESTION_DATABASE_URL" npm run db:migrate

# Read-only database-aware preview, then explicit application.
npm run ingest:afl -- --source=live --season=2026 --dry-run
npm run ingest:afl -- --source=live --season=2026 --apply
```

Omitting both --apply and --dry-run defaults to dry run. --apply requires INGESTION_DATABASE_URL. The fixture source refuses production-mode writes and supports only its bundled 2026 snapshot. It does not impersonate the live provider or share its external-ID namespace. Fixture records do not enter the UI repository.

### Useful incremental scopes

```sh
# Only games/boxscores in a known date interval; no roster requests.
npm run ingest:afl -- --source=live --season=2026 --games-only --from=2026-10-24 --to=2026-10-25 --apply

# Roster evidence and optional player/organization enrichment; no schedule/boxscores.
npm run ingest:afl -- --source=live --season=2026 --rosters-only --apply

# Restrict roster and game work to a discovered AFL team ID.
npm run ingest:afl -- --source=live --season=2026 --team=SOURCE_TEAM_ID --dry-run
```

Replace SOURCE_TEAM_ID with an actual numeric Stats API team ID discovered by the source. Team discovery still retains all opponents so game relationships remain valid. Dates are inclusive official baseball dates, validated against the selected season. The scheduler/cursor is intentionally not implemented: a local cron/worker can request yesterday plus a small lookback interval to catch late corrections. Full-season execution is available for initial backfills. A requested interval avoids fetching older/unrelated boxscores, and scheduled/live/postponed/cancelled games do not trigger completed-game boxscore requests.

## Architecture and endpoints

`SourceAdapter → normalized records → planner → PostgresIngestionSink` remains the boundary. The UI consumes neither MLB JSON nor this worker. `MLBStatsApiSource` implements the same adapter contract as the existing fictional source. `mlb-config.ts` centralizes the provider namespace, identifiers, and default base `https://statsapi.mlb.com/api/v1/`. Optional `MLB_STATS_API_BASE_URL` may supply another HTTPS base for an approved compatible source; credentials/query strings/fragments are refused. No endpoint URL is scattered into page components.

| Endpoint                                                             | Use                                                                        |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `league/119?season=2026`                                             | Confirm the selected AFL league                                            |
| `teams?leagueIds=119&sportId=17&season=2026`                         | Discover participating teams, names, abbreviations/codes, league and sport |
| `teams/{id}/roster?rosterType=fullSeason&season=2026&hydrate=person` | Seasonal roster participation/status and source player IDs                 |
| `people?personIds=…&hydrate=currentTeam`                             | Batched person details and optional current-team context                   |
| `teams?teamIds=…&season=2026`                                        | Verify current-team/parent-club context where available                    |
| `schedule?leagueId=119&sportId=17&season=2026&startDate=…&endDate=…` | Games, official dates, timestamps, scores, status, opponents, venue        |
| `game/{gamePk}/boxscore`                                             | Completed-game batting and pitching raw counts                             |

Person and organization-team lookup batches contain at most 50 IDs. The client permits one request in flight, spaces starts by 100ms, and caches each URL for the capture. A new capture clears the cache; repeated ingestion does not retain an indefinitely stale response. Transient HTTP 429/5xx and transport failures have at most three attempts with bounded backoff; 403 and other permanent failures are not retried. Each attempt has a 15-second timeout and a 10MB body cap. Redirects, non-JSON responses, embedded credentials, and TLS bypasses are not used. On a machine that requires the inherited session/corporate proxy, use Node 24+ with `NODE_USE_ENV_PROXY=1`; do not remove configured proxy or CA settings.

## Identity, affiliation, and source coverage

All source person/team/game IDs go into `source_identities` under `mlb-stats-api`; independently generated internal UUIDs remain core primary keys. Replays resolve those mappings. Names never merge players. The previous fixture namespace remains distinct. Cross-provider identity binding requires explicit review, and source-owned canonical rows cannot be silently replaced by another provider.

AFL teams always have **null parent organization**. Parent organization is resolved only through supplied person current-team context and source team metadata: a verified sportId=1 club is an MLB parent; a non-AFL affiliate's parentOrgId is followed and verified as a sportId=1 club. A fall team's currentTeam is not used as an MLB organization. Missing/ambiguous affiliation stays unresolved. The pipeline never invents an affiliation from a team name.

Seasonal fullSeason rosters are participation evidence, not proof of a current assignment or transaction date. Live ingestion writes `source_roster_observations` with season, status, observation time, and optional observed MLB organization. It does **not** fabricate startsOn dates for PlayerTeamMembership/PlayerOrganizationMembership. Historical dated memberships already in the database remain untouched. Current-team enrichment is an observation at capture time, not a claim about a player's organization at every earlier point in the selected season. A later transaction-specific adapter can create confirmed dated stints.

Available person birth date, bats, throws, height, weight, and primary position are normalized. Unknown optional attributes remain absent/null and do not erase previous known fields. Two-way game appearances can have both batting and pitching rows regardless of primary position. Source roster status is retained with the observation.

## Raw statistics and aggregation

Core `Game`, `PlayerBattingGame`, and `PlayerPitchingGame` are reused; there is no competing game-stat database. Games retain official date, source-linked league/season, timestamp, home/away scores where supplied, venue, and status. Completed validated boxscores mark `boxscoreComplete=true` only after the coherent line set has been applied.

Batting captures PA, AB, H, 2B, 3B, HR, BB, SO, HBP, SF, SB and supplied runs, RBI, caught stealing, sacrifice bunts, catcher interference. Pitching captures outs, BF, H, ER, BB, K, HR allowed and supplied runs, hit batters, and pitch count. Missing required counting fields are quarantined, not silently defaulted to zero. Optional counts stay null when unavailable. `5.2` IP converts to **17 outs**; invalid notation or disagreement with an explicit outs field is rejected.

`src/statistics/aggregate.ts` calculates from summed raw counts:

- Batting AVG=H/AB; OBP=(H+BB+HBP)/(AB+BB+HBP+SF); SLG=(H+2B+2×3B+3×HR)/AB; OPS=OBP+SLG; BB% and K% use PA.
- Pitching ERA=27×ER/outs; WHIP=3×(H+BB)/outs; K% and BB% use batters faced.
- Rates have null values for zero denominators; no NaN/Infinity. Percentage outputs are 0–100 units, other rates are unrounded ratios. Unknown optional counts remain null.

`GameStatisticsRepository` queries stored final, complete game lines and joins the season and league. It never reads API responses or adds season totals to game totals. It requires internal league UUID, season, explicit asOf date, and optional team UUID, avoiding blends of AFL/other competitions or team splits. Its 7D/14D/30D windows include asOf and the preceding 6/13/29 official dates. Season starts January 1 of the selected year; custom inclusive date ranges are supported.

```ts
const repository = new GameStatisticsRepository(drizzle(pool));
const stats = await repository.getPlayerBattingStats(playerUuid, {
  season: 2026,
  leagueId: aflLeagueUuid, // resolve from source_identities, never use provider 119 here
  asOf: "2026-10-24",
  window: "14d",
});
```

An official game date governs baseball windows even when the UTC start timestamp falls on the next day. Returned coverage is explicitly `ingested-complete-games-only`; it does not promise that every scheduled game has been ingested. Backfill the full intended window and review quarantine/freshness before interpreting aggregates as complete. The legacy fixture does not claim completeness/league coverage; live-shaped synthetic fixtures exercise the new analytics path. No Momentum, rankings, forecasting, or derived rolling values are persisted.

## Quarantine, correction, and replay behavior

The original fictional source retains its whole-batch quarantine policy. The live source opts into record-level quarantine: valid independent teams/people/games can apply while malformed records and dependent rows are held and logged. A failed/invalid completed boxscore holds **all** its statistical lines for review, preventing a new partial boxscore from being marked complete. Prior validated lines remain available; the run reports issues rather than claiming all source data is fresh. Network failures for an individual roster, enrichment batch, or boxscore do not silently become empty data. Failed league/team discovery cannot proceed without reliable scope.

All accepted canonical writes remain transactional with provider-wide advisory locking. Invalid cross-table relationships, stale/ambiguous revisions, ownership conflicts, or database errors roll back that transaction and preserve the audit outcome. Explicit run statuses distinguish applied, applied-with-quarantine, quarantined, failed, and dry-run results. The first local dry run can report normalized upsert candidates without a DB; with a migrated database configured it compares record state read-only. Preview counts are candidates, not a guarantee against all apply-time conflicts or a count of physical SQL statements/deletions.

Exact replay does not duplicate identities, entities, games, or stat lines. Later capture observations can replace counts rather than add them. A validated complete boxscore line set reconciles only source-owned lines that disappeared after an official correction; it cannot delete another provider's rows. Roster observations may legitimately accumulate at different capture timestamps. An older capture cannot overwrite newer canonical state. API responses lack a universal trustworthy modified timestamp, so live observation time means capture completion time; interrupted old captures and multi-worker scheduling still require operational care.

## Migrations and raw debugging

- Migration 0002 is the preserved fixture infrastructure: source snapshots/runs, external mappings, issues, ownership/revision state, and roster observations.
- Migration 0003 is additive: player height/weight; official game date, league, scores, venue, completeness; extra raw batting/pitching counts (also nullable on the existing season tables); season/status on roster observations. Old records are retained and optional fields are not backfilled with fabricated zeroes. Existing tables/UUIDs remain.

For live imports, database snapshots store a **response manifest** (endpoint, fetch time, content hash), not permanent copies of every MLB JSON blob. Normalized core tables feed analytics. `--record-dir` optionally preserves content-addressed full responses for local debugging, outside public/src/.git. Do not commit real response recordings or credentials. The legacy fictional source continues to archive its synthetic payload as before.

## Tests and known limits

CI tests use explicitly synthetic native-shaped response fixtures; no Internet is needed. They cover all endpoint categories, discovered names/IDs, source selection, request caching/concurrency/retries, optional/unresolved organization context, two-way lines, innings conversion, normalization/quarantine, rolling formulas, and invalid CLI bounds. PostgreSQL integration additionally tests read-only dry runs, idempotency, field persistence, official-date windows, corrections, obsolete-line removal, and preservation of last valid data after quarantine.

```sh
npm run typecheck
npm run lint
npm test
npm run build

# Fresh disposable databases, each migrated before its separate integration suite:
DATABASE_URL="$INGESTION_TEST_DATABASE_URL" npm run db:migrate
npm run test:ingestion:db  # requires database name prospect_ingestion_test
DATABASE_URL="$MLB_TEST_DATABASE_URL" npm run db:migrate
npm run test:mlb:db        # requires database name prospect_mlb_test
```

The first live run must be performed locally. Synthetic fixtures exercise expected response shapes, not every possible live payload variant; unexpected fields/statuses/missing required stats will be diagnosed or quarantined and may need a recorded-response contract update. There is no automatic scheduling/cursor, transaction-history ingestion, season-total provider comparison, automatic cross-provider identity matching, production retention policy, or UI database repository switch. Current-team enrichment cannot prove historical organization membership. Raw game coverage must be checked before production analytics. The first full-season run may take minutes because access is intentionally serialized. Network restrictions in a cloud task do not mean Stats API is unavailable on the developer machine.

### Implementation validation

Validated offline in the cloud workspace: typecheck and lint passed; all 30 unit tests passed; the fixture dry run produced 24 valid records with no issues. Both migrated disposable PostgreSQL suites passed (9 fixture-workflow tests and 6 live-shaped workflow tests, including their parent tests). `npm run build -- --webpack` passed and generated all 52 pages. The default Turbopack build was blocked by the environment's local-port restriction while processing CSS; no application configuration was changed to work around it. No Stats API requests were made. UI components, routes, demo data, and public branding assets are unchanged.
