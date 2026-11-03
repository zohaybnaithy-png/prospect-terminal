# MiLB ingestion (Data Foundation V1)

Triple-A, Double-A, High-A and Single-A from the MLB Stats API, through the **same** pipeline as the AFL:
`SourceAdapter → normalized records → buildPlan → PostgresIngestionSink`. There are no per-level tables; MiLB rows live in the existing generalized schema. One provider namespace (`mlb-stats-api`) is shared with the AFL adapter. A player, organization or game therefore keeps **one internal UUID** across the AFL and every MiLB level.

## Source hierarchy (discovered and verified at runtime)

| Concept | Stats API | Stored as |
|---|---|---|
| Level | `sportId` 11 Triple-A, 12 Double-A, 13 High-A, 14 Single-A. `sports/{id}` must return the expected name, or the capture aborts. Historical names "Class A Advanced", "Low-A" and "Class A" are accepted. | `levels` row per (sport, league), name = level label, source identity `milb:{sportId}:{leagueId}` |
| League | `league?sportId=…&season=…`, falling back to each team's `league {id,name}` (`discovery-fallback` notice) | `leagues` row, identity = league id |
| Affiliate | `teams?sportId=…&season=…` (active teams of that sport) | `teams` row → level |
| Parent org | team `parentOrgId`, verified against `teams?sportId=1&season=…` | `organizations` row (same identity as AFL org enrichment). Missing or non-MLB parent → `organization_id` null + `unresolved-affiliation` notice. Never inferred from names. |
| Season | — | `seasons` row `milb-{year}` ("Minor League Baseball {year}"), separate from `afl-{year}` |
| Roster | `teams/{id}/roster?rosterType=fullSeason|active&hydrate=person` | `source_roster_observations` (team, observed parent org, status, capture time) |
| Games | `schedule?sportId=…&startDate&endDate[&leagueId][&teamId]` | `games` (official date, status, scores, venue, league, season) |
| Lines | `game/{gamePk}/boxscore` (final games only) | `player_batting_games` / `player_pitching_games` |
| People | `people?personIds=…` (batches of 50) only for box-score players who are neither on a fetched roster nor already stored | `players` |

League IDs are **not** hardcoded. The expected 2026 structure is IL/PCL (AAA), Eastern/Southern/Texas (AA), Midwest/South Atlantic/Northwest (High-A) and California/Carolina/Florida State (Single-A). Confirm it with the first live dry run (see Validation). Sport IDs 11–14 and the sport-1 parent rule come from the API's documented hierarchy and are re-verified on every capture.

## Commands

```sh
# Offline, synthetic fixture (fictional teams/players; never applied anywhere):
npm run ingest:milb -- --source=fixture --season=2026

# Live, read-only preview (compares against the DB read-only when INGESTION_DATABASE_URL is set):
npm run ingest:milb -- --season=2026 --level=aaa --dry-run

# Initial backfill: structure pass, then 7-day game chunks (one transaction per chunk):
npm run ingest:milb -- --season=2026 --apply
npm run ingest:milb -- --season=2026 --level=aa,high-a --from=2026-04-01 --to=2026-06-30 --apply

# Daily / regular update (ready for a scheduler; none is installed):
npm run ingest:milb -- --season=2026 --incremental --apply

# Debug scopes:
npm run ingest:milb -- --season=2026 --level=aaa --league=SOURCE_LEAGUE_ID --dry-run
npm run ingest:milb -- --season=2026 --level=aaa --team=SOURCE_TEAM_ID --games-only --from=2026-05-01 --to=2026-05-07 --dry-run
npm run ingest:milb -- --season=2026 --rosters-only --apply
```

| Option | Default | Meaning |
|---|---|---|
| `--source` | `live` | `fixture` = offline synthetic dry run only |
| `--level` | all | `aaa,aa,high-a,single-a` (comma list) |
| `--league`, `--team` | — | restrict rosters/schedule; teams are still discovered level-wide so opponents resolve |
| `--games-only` / `--rosters-only` | both | skip the structure pass / skip games |
| `--from`, `--to` | Mar 1 – min(today, Oct 31) | inclusive official dates |
| `--chunk-days` | 7 | days per games capture/transaction |
| `--concurrency` | 4 | requests in flight (1–8), starts ≥100 ms apart |
| `--incremental` | off | `--from` = latest stored complete game of the selected levels − `--lookback-days` (3) |
| `--refetch-complete` | off | also re-fetch boxscores of games already stored complete |
| `--refetch-window-days` | 3 | stored complete games this recent are re-fetched anyway (late scorer corrections) |
| `--roster-type` | `fullSeason` (`active` with `--incremental`) | roster endpoint type |
| `--game-types` | `R` | add `F,D,L,W` to include postseason rounds |
| `--record-dir` | — | keep raw responses for debugging (outside public/src/.git) |

`--apply` and `--incremental` need `INGESTION_DATABASE_URL`. The default is a dry run. stdout carries only the final JSON summary: per-chunk status, records, issues, changed/unchanged, notices, reused boxscores, totals and, on failure, `resumeFrom`. Progress goes to stderr.

## Backfill vs. incremental

- **Backfill:** one *structure* capture (discovery, organizations, rosters, people), then consecutive *games* captures per date chunk. Each chunk is its own snapshot, ingestion run and transaction. A failed chunk rolls back completely; the summary's `resumeFrom` tells you where to restart (`--from=…`). Re-running finished chunks is harmless (idempotent).
- **Incremental:** the range starts `--lookback-days` before the latest stored complete game *of the selected levels*. Games already stored `final` with a complete boxscore are not re-fetched, unless their date falls inside the refetch window. Their schedule row (status/score) is still refreshed. Players already stored need no `people` lookup. A rerun with no upstream change fetches no boxscores and changes no rows.
- **Scheduled/live/postponed/cancelled** games never trigger boxscore requests.

## Edge cases

- **Postponed → rescheduled (same gamePk):** reconciled via reciprocal `rescheduleDate`/`rescheduledFrom` linkage (the shared AFL logic). A chunk that only sees the postponed row, whose reschedule falls in another window, defers it (notice). The game is never stored as postponed and later overwritten.
- **Suspended → resumed (same gamePk):** reconciled via reciprocal `resumeGameDate`/`resumedFromDate`. This is MiLB-only; the AFL path is unchanged.
- **Doubleheaders:** distinct gamePks, so both games are stored, each with its own start time.
- **Cancelled:** stored as `cancelled`, no boxscore.
- **Exhibition and other non-selected game types:** excluded with an `outside-scope` notice.
- **Irreconcilable duplicate representations, unknown participants, malformed rows:** quarantined (`ingestion_issues`), never last-row-wins.
- **Malformed boxscore:** all of its lines are held. A new game stays `boxscore_complete=false`; an already complete game keeps its previous valid lines.
- **Box-score-only players:** primary position, handedness and birth date come from `people`. A game position (PH/PR) is never written as a primary position. An unknown player without one quarantines that boxscore's line set.
- **Interleague games** are attributed to the home team's league.
- **Promotions/demotions:** every roster capture adds observations `(player, team, observed parent, status, capture time)`. Older observations are never deleted. Stat lines keep the team they were recorded for, and the level follows from that team. `teams.organization_id` is the latest observed affiliation; per-capture history lives on the observations.

## Scale changes (shared with the AFL path)

- **HTTP:** `MlbClient` has bounded concurrency (MiLB default 4, AFL still 1) with ≥100 ms between request starts, the same retries, caching, timeouts and size caps.
- **Memory:** boxscores are reduced to a projection on arrival (team ids plus per-player person, position and game batting/pitching). Season stats, officials and notes are dropped. Raw bodies are not retained (`retainBodies: false`). The capture identity `rawContentHash` is a hash of the response manifest (url + body hash) supplied by the adapter, so the runner no longer serializes the whole raw payload. The AFL keeps its old behavior.
- **Database:** apply and preview read only the source identities and record-state rows **referenced by the batch**, instead of every row the provider owns. Bulk-row grouping was O(n²) (array spread per row) and is now linear. Writes are unchanged: bulk, per table, one transaction, about 30 round trips per chunk.
- **Rough full-season backfill:** ~8k boxscores, ~120 rosters, ~150 people batches, plus ~13 discovery requests per chunk (~35 chunks), so roughly 9k requests. That is ≈15 minutes at 4 in flight, bounded by API latency. No queue, cursor or distributed worker was added.

## Read model and analytics

`loadMilbLevelSnapshot(db, level, season)` (`src/services/afl/queries.ts`) loads one level, i.e. all leagues of that sport, into the same snapshot shape the AFL views, `src/statistics` aggregation and Analytics V1 consume. It uses the same read-only, repeatable-read transaction. `snapshot.scope` records the level and league UUIDs. Roster stints are limited to that level's teams. The Momentum formula and its AFL calibration are unchanged; nothing is recalibrated on synthetic MiLB data. `GameStatisticsRepository` works per MiLB league as it does for the AFL.

## Validation

Automated checks (no Internet):

```sh
npm test                                   # includes scripts/milb.test.ts
DATABASE_URL="$MILB_TEST_DATABASE_URL" npm run db:migrate
npm run test:milb:db                       # requires database name prospect_milb_test
```

Before the first real apply, on a machine with Stats API access:

1. `npm run ingest:milb -- --season=2026 --level=aaa --rosters-only --dry-run` without a database. Confirm the discovered leagues and team counts (≈20 IL + 10 PCL) and that every affiliate has a parent (no `unresolved-affiliation` notices expected).
2. Repeat for `aa`, `high-a`, `single-a`.
3. `--games-only --from=<a recent week> --dry-run` per level. Review issues and notices (reschedules, suspensions, doubleheaders).
4. Apply to a **local or staging** database first, then check the invariants in `scripts/milb-db.integration.ts` against it: no duplicate source games or lines, every complete game has lines for both teams, stat teams participate in their games.
5. Only then apply to the shared database (explicit approval required, see CLAUDE.md).

## Known limitations

- Not verified against the live API from this environment: league IDs/names, the `league` endpoint's response shape, MiLB status strings (e.g. "Completed Early"), and suspended-game fields. Unknown statuses quarantine the game.
- `teams.organization_id` is a single latest value. Re-ingesting an older season after a newer one rewrites it from that season's capture; per-season affiliation history lives on roster observations.
- Roster observations accumulate per capture (≈ players × teams). Prefer `--roster-type=active` for frequent runs.
- No transaction feed: promotion dates are not known; observations are capture-time evidence.
- No scheduler, cursor table or retention policy. The UI has no MiLB pages yet (data foundation only).
- Postseason games are excluded by default; spring/fall/exhibition games are always excluded.
