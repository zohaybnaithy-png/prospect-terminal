# Historical data for the Prospect Grade — sizing estimate (T-501, D-029)

**Status: owner chose Option B, season totals (2026-11-28, D-030). Nothing has been ingested and no database was
touched.** The Prospect Grade
(docs/GRADE-METHOD.md, D-029) needs MiLB seasons 2012–2019 and 2021 and the MLB careers that followed. D-029 says this
estimate comes first and that historical ingestion starts only after the owner approves it.

## 1. What the provider has (checked 2026-11-28, about 40 read-only requests to the public MLB Stats API)

| Check | Result |
|---|---|
| Schedules, 2012 / 2016 / 2019, sportId 11–14 | Present for all four levels (≈ 100–156 games per level in 1–7 May) |
| Level names before 2021 | "Class A Advanced" / "Class A": already accepted by `src/domain/levels.ts` |
| Short-season A (15) and Rookie (16) | No games in early May (they start in June); not proposed (§5 decision 3) |
| A 2012 Double-A box score | Complete batting and pitching lines with PA, SB, SF, HBP, BF, HR |
| MiLB season totals (`stats?stats=season&sportId=…&playerPool=ALL`) | Present: e.g. Triple-A 2014 hitters 1,510 player-team rows, Class A 2014 701 rows across all 30 teams and both leagues; one split per player and team |
| MLB season totals, 2018 | 1,270 hitters, 799 pitchers in one request each, with the counts the outcome needs |
| Birth date, MLB debut date (`people/{id}`) | Present |
| Draft round and pick (`draft/{year}`) | Present (only if the owner adds draft round, D-029) |

## 2. Two ways to load it

**Option A: per-game box scores, the existing pipeline.** Run the current MiLB backfill (`ingest:milb`, structure pass +
date chunks) for each past season. Almost no new code: seasons are already a parameter and level names already match.
MLB outcomes still need Option B's season-totals record, because MLB box scores for 14 seasons (about 34k games) would
be far larger again.

| | Per season (2026 actuals) | 9 seasons |
|---|---|---|
| Games | 8,370 | ≈ 75k |
| Batting / pitching lines | 154,626 / 67,204 | ≈ 1.4M / 0.6M |
| API requests | ≈ 10k | ≈ 90k |
| Run time | 40–60 min | ≈ 6–9 h (resumable chunks) |
| Storage | **not measured** (PRODUCTION-READINESS.md) | ≈ 9 × today's MiLB storage |

The risk is storage: Neon Free allows 0.5–1 GB per project, and nine more seasons of per-game rows, identities,
provenance and response manifests is very likely over that. Neon storage beyond Free is a paid service, which needs
the owner's approval.

**Option B: season totals (recommended).** Add one normalized record type, "player season totals at a level", from
the provider's season-stats endpoint, for MiLB 2012–2019 and 2021 (four levels) and MLB 2013–2026.

| | Estimate |
|---|---|
| Requests | ≈ 80 for totals (2 per level-season, 2 per MLB season) + ≈ 150 for people (birth dates, batched ids) |
| Rows | ≈ 9 × 8k MiLB player-team-level rows + 14 × 2.1k MLB rows ≈ 100k |
| Storage | tens of MB (≈ 2% of Option A) |
| Run time | minutes |
| Code | new record type, normalizer, planner support and one table (a migration, genuinely required), with the same guarantees as today: stable source ids, provenance, strict validation, one transaction per apply, idempotent replay, quarantine |

What Option B gives up: no historical game logs, Momentum or per-game split-half reliability. The Grade only needs
season-level inputs; its shrinkage constants would come from the 2026 per-game data (D-024's estimator), applied to
past seasons. That assumption is stated in the Grade validation report.

Completeness check before trusting season totals: for two level-seasons (≈ 4k games), compare the totals with sums of
box scores fetched for that check only (read-only, not stored), and require exact agreement on PA/BF, K, BB, HR per
player-team; any disagreement stops the plan.

## 3. Unchanged either way

- The site's build-time snapshot exports the current season only (`scripts/export-snapshot.ts`), so past seasons do not
  reach Vercel or change page sizes.
- Every write still needs explicit approval in the conversation (CLAUDE.md): a read-only preview first, then the
  apply, on the Neon test branch, never Production.
- Development use only; public display of anything built from it waits for T-601 (licensing).

## 4. One measurement the owner can run (read-only)

Current database size, to confirm the Free-tier headroom. It prints sizes only, never the connection string:

```bash
read -rs "DATABASE_URL?Neon test branch URL (read-only role is fine): " && export DATABASE_URL && echo && psql "$DATABASE_URL" -Atc "select pg_size_pretty(pg_database_size(current_database()))"; unset DATABASE_URL
```

## 5. Decisions requested from the owner

1. Choose Option B (season totals, recommended, stays on Neon Free) or Option A (per-game, likely needs paid Neon
   storage).
2. Approve building the Option B record type and its migration (code PRs only; no ingestion), then the completeness
   check, then a read-only preview, each reported before any apply.
3. Scope: the four full-season levels only (proposed), or also short-season A and Rookie for 2012–2019 (more young
   players, smaller samples).
4. Draft round as a Grade input (open in D-029): yes or no, before the validation run.

## 6. Implementation (T-503)

- Record kinds `battingSeason` / `pitchingSeason` (`src/ingestion/contracts.ts`): player, season, level code
  (`mlb`, `aaa`, `aa`, `high-a`, `single-a`), games, teams, and the same validated counts as game lines. Canonical key
  player + season + level code; the usual record-state ownership, freshness, correction and quarantine rules apply.
- Tables `player_batting_level_seasons` / `player_pitching_level_seasons` (migration `drizzle/0004_*`, additive only).
  No team or league columns: historical rows never rewrite current team or league attributes.
- Adapter `src/ingestion/sources/season-totals-stats-api.ts`: one capture per season and scope; sport names verified;
  a page shorter than its `totalSplits` fails the capture; players are emitted only when not already stored. Seasons
  are `milb-{year}` (shared with the game-level MiLB data) and `mlb-{year}`.
- CLI `scripts/ingest-season-totals.ts` (run with `node --import tsx`): no database → offline normalize only; database
  → read-only preview; `--apply` → preview first, refuses a season with issues unless `--accept-quarantine`, job lock,
  one transaction per season.
- Offline check against the live API (no database): MiLB 2014 → 4,058 batting and 3,720 pitching rows, 5,149 players,
  0 issues; MLB 2018 → 1,270 and 799 rows, 0 issues; repeat captures hash identically.

Next, each reported before the next: the completeness check (T-504), the migration on the Neon test branch, a
read-only preview of every season, and the apply only with explicit owner approval.
