# Full-season MiLB backfill (guarded runner)

`npm run backfill:milb` loads a full MiLB season (Triple-A → Double-A → High-A → Single-A) into the
**Neon test branch only** (`ep-spring-cake-ak5jqlqp`, database `neondb`). It adds orchestration and
verification on top of the existing pipeline. Every write still goes through `runMilbIngestion` →
`MilbStatsApiSource` → `buildPlan` → `PostgresIngestionSink`, one transaction per capture, with all
ingestion guarantees unchanged (see [MILB-INGESTION.md](./MILB-INGESTION.md)).

- Orchestrator: `src/ingestion/milb-backfill.ts` (framework-free, dependency-injected).
- Write-target guard: `src/ingestion/db-target.ts`.
- CLI: `scripts/ops/milb-backfill.ts`.
- Database reads: `scripts/ops/pg-readonly.mjs` (the existing read-only helper; no `psql`).
- Analytics readiness: `npm run check:milb:readiness` (`scripts/ops/milb-readiness.ts`).
- Tests: `scripts/milb-backfill.test.ts`, `scripts/milb-readiness.test.ts`.

## Safety gates (all must pass before the first write)

1. **Connection string (offline, `checkWriteTarget`).** Only `INGESTION_DATABASE_URL` is read.
   `DATABASE_URL` and every `PG*` variable are deleted at startup, so nothing can fall back to them.
   The string must meet all of these:
   - the host is `ep-spring-cake-ak5jqlqp[-pooler].….neon.tech`, matched exactly (prefix matches,
     lookalike hosts and the retired `ep-lucky-sea-akc835g5` are refused);
   - the port is 5432 or absent, and the database is exactly `neondb`;
   - `sslmode` is `require` or `verify-full`, and only `channel_binding` may also appear;
   - nothing else is set (`host`, `options`, `sslrootcert`, `sslcert`, `uselibpqcompat`, `ssl` and
     repeated parameters are refused).

   Errors never contain the connection string or its credentials.
2. **TLS.** Every read goes through `pg-readonly.mjs`. It requires a TLS socket with a verified
   certificate and runs each statement in a `READ ONLY` transaction that is rolled back. The writer
   uses the same URL; `pg` treats `sslmode=require` as `verify-full`.
3. **Server facts (read-only):**
   - `current_database()` is `neondb` and `current_schema()` is `public`;
   - the 4 migrations match the checked-in `drizzle/*.sql` files by sha256 and journal timestamp;
   - exactly the 26 tables those migrations create exist.
4. **Branch evidence.** The AFL league identity (119) and the applied run of the guarded one-week
   Triple-A import (`milb:2026:aaa:games:2026-09-15:2026-09-21:…`) must exist, which only the test
   branch has. Neon's `neon.timeline_id` is recorded when the server exposes it. The state file is
   pinned to it, and a different timeline is refused.
5. **Invariants already hold.** If duplicate identities or lines, orphan identities, orphan lines or
   games without an identity already exist, the run refuses before writing.
6. **No concurrent writer.** A local lock file is taken (`<run-dir>/backfill.lock`). The run stops
   if an `ingestion_runs` row has been `running` in the last 30 minutes.
7. **Explicit confirmation.** Writes need both `--apply` and `--confirm=ep-spring-cake-ak5jqlqp`.
   Without `--apply`, nothing is written anywhere, not even the local state file.

## Commands

All output stays outside the repository (default `~/pt-runs/milb-backfill-2026/`, mode 700). stdout
is the final JSON report and stderr is progress. Use `npm run -s` when redirecting.

```bash
# Offline plan (no database): real API coverage and the 7-day chunk plan.
npm run -s backfill:milb -- --season=2026 > ~/pt-runs/backfill-plan-offline.json

# Plan against the test branch (read-only): every gate above, every check query, the current data
# per level, the baseline an apply would record, and which chunks are already verified.
npm run -s backfill:milb -- --season=2026 > ~/pt-runs/backfill-plan.json 2> ~/pt-runs/backfill-plan.log

# Apply (WRITES; needs approval): one level at a time is recommended.
npm run -s backfill:milb -- --season=2026 --level=aaa --apply --confirm=ep-spring-cake-ak5jqlqp \
  > ~/pt-runs/backfill-aaa.json 2> ~/pt-runs/backfill-aaa.log
# … then --level=aa, --level=high-a, --level=single-a (or omit --level to run all four in order).

# Afterwards (read-only): Momentum/read-model readiness for every level.
npm run -s check:milb:readiness > ~/pt-runs/readiness.json
```

| Option | Default | Meaning |
|---|---|---|
| `--season` | 2026 | season |
| `--level` | all | comma list, always processed in the order AAA → AA → High-A → Single-A |
| `--apply` + `--confirm=<endpoint>` | off | write; without them the run is a read-only plan |
| `--run-dir` | `~/pt-runs/milb-backfill-<season>` | state, reports, lock (must be outside the repo) |
| `--continue-on-quarantine` | off | accept chunks with quarantined records (still listed for review) |
| `--recheck` | off | re-run chunks even when the database verifies them |
| `--retries` / `--retry-base-ms` | 3 / 30000 | per-capture retries; waits of 30 s, 90 s, 270 s |
| `--chunk-pause-ms` | 1000 | pause between chunks |
| `--concurrency` | 4 (max 6) | Stats API requests in flight; starts at least 100 ms apart (`MlbClient`) |
| `--idempotency-samples` | 3 | chunks per level re-previewed read-only after the level |
| `--game-types` | R | regular season; postseason (`F,D,L,W`) is opt-in |
| `--verbose` | off | also log every HTTP request |

Exit codes: 0 means planned, complete or complete-with-review; 1 means stopped; 2 means refused or
invalid arguments.

## What one level does

1. **Coverage.** The runner reads `seasons/{year}?sportId=` and the full `schedule?season=&gameType=`
   from the Stats API. Chunks run from the first to the last real schedule date. Nothing is
   hardcoded. A warning is recorded if the schedule extends beyond the regular-season dates.
2. **Structure pass.** One capture of teams, organizations, rosters and people. It is skipped on
   restart only if its recorded run verifies (see below).
3. **Games chunks.** These are consecutive 7-day captures, one transaction each. After each chunk:
   - Status: `applied` continues. `applied-with-quarantine` stops unless
     `--continue-on-quarantine` is set. A whole-capture `quarantined` result always stops.
   - The chunk's issue codes are read from `ingestion_issues`.
   - Read-only checks run over the level's games in the chunk's range (below).
   - The state file is written atomically.
4. **Level checks:**
   - the same checks over the whole season, plus whole-database invariants;
   - completeness against the API: stored games and complete games vs. the schedule's gamePks and
     final gamePks;
   - read-only idempotency previews of sample chunks (first, middle, last), with box scores
     re-fetched;
   - the preserved-data fingerprints.
5. **Reports.** The runner writes `level-<level>.json` and `integrity-<level>.txt` (the existing
   `scripts/sql/milb-integrity-checks.sql`).

### Checks

| Check | Kind |
|---|---|
| Final complete game without batting **and** pitching lines for both teams | stop |
| Final game without a score | stop |
| A team outside the level, or home = away | stop |
| A line whose team did not play in the game | stop |
| Impossible batting (negatives; AB > PA, H > AB, 2B+3B+HR > H, SO/BB > PA). Runs are not bounded by PA: pinch and automatic runners score without one | stop |
| Impossible pitching (negatives; ER > R, HR > H, H/SO/BB > BF) | stop |
| Duplicate identities (external or internal), duplicate batting/pitching lines | stop |
| Orphan identities (no row in the typed table), orphan lines, games without identity | stop |
| Final game without a complete box score | stop, unless `--continue-on-quarantine` (then review) |
| AFL games, AFL batting/pitching lines, and lines of every game complete before the backfill (the Triple-A week) changed | stop |
| AFL players' rows changed (MiLB may legitimately enrich shared players) | informational |
| Batting runs ≠ team score; pitching runs allowed ≠ opponent score | review (gamePks listed) |
| Games still scheduled/in progress; lines on an incomplete game | review |
| Notice kinds other than reconciled-reschedule, outside-scope, discovery-fallback, reused-boxscores | review |
| Stored vs. API game counts differ | review |

"Stop" leaves the database as it is, because the chunk itself committed or rolled back as a unit.
It records the reason in `summary.json` and exits 1. The next run re-checks that chunk, so a failed
check is never skipped. "Review" items are listed in the level report, whose status is then
`complete-with-review`.

### Restart and skip rules

The state file (`state.json`) records, per chunk, its ingestion run id, status, counts and check
results. It is bound to season, game types, chunk size, endpoint, database and Neon timeline.

A chunk is skipped only when the database confirms it:

- the recorded `ingestion_runs` row exists with the same status and the expected snapshot key;
- its checks passed;
- no final game in its range lacks a complete box score;
- the number of games in its range has not dropped.

Anything else is re-run. That is safe because every capture is idempotent, and a failed one rolls
back entirely. To resume after a stop or interrupt (Ctrl-C finishes or rolls back the current
capture), re-run the same command.

### Idempotency

After each level, sample chunks are re-captured as a **read-only preview**. Box scores are
re-fetched, the preview is compared with the stored record state, and nothing is written. The
preview must show:

- no inserts;
- no updates to lines, players, teams or other records;
- the same issue count as the original chunk;
- unchanged table counts.

A `game` row may differ only for games reconciled across a chunk boundary (a suspended game resumed
in the next window is represented differently by each window). Such updates are bounded by the
preview's reconciled-reschedule notices and listed for review.

The preview reports per-kind counts through `databaseComparison.byKind`, which
`PostgresIngestionSink.preview` provides. A rerun of the whole workflow skips every verified chunk
and writes nothing. `--recheck` re-applies and must report `changed: 0`, except that it also re-runs
the structure pass, which adds one roster-observation set (capture-time keyed, by design).

## Outputs (`--run-dir`)

| File | Content |
|---|---|
| `state.json` | resumable progress (no credentials) |
| `plan.json` | plan mode: coverage, chunks, verified flags, current per-level checks, baseline preview |
| `level-<level>.json` | per-level report: chunks, totals, notices, checks, completeness, idempotency, review |
| `summary.json` | overall report (also printed to stdout) |
| `integrity-00-baseline.txt`, `integrity-<level>.txt`, `integrity-99-final.txt` | `milb-integrity-checks.sql` output |

## Verified 2026 coverage (Stats API, read 2026-11-07, `gameType=R`)

| Level | Schedule | `seasons` regular season | gamePks | final | 7-day chunks |
|---|---|---|---|---|---|
| Triple-A (11) | 2026-03-27 – 2026-09-20 | same | 2,250 | 2,223 | 26 |
| Double-A (12) | 2026-04-02 – 2026-09-13 | same | 2,070 | 2,048 | 24 |
| High-A (13) | 2026-04-02 – 2026-09-06 | same | 1,981 | 1,952 | 23 |
| Single-A (14) | 2026-04-02 – 2026-09-06 | same | 1,980 | 1,954 | 23 |

High-A has one schedule row still "Scheduled": gamePk 864127, the known `outside-scope` season/date
case in MILB-INGESTION.md. Postseasons (AAA Sep 22–26, AA Sep 15–27, A+/A Sep 8–19) are excluded by
default.

## Expected workload

- **Requests.** About 8.2k box scores, 96 chunks × ~6 discovery/schedule requests, about 120 rosters
  and people batches, plus up to 12 preview chunks (about 1k box scores). That is roughly 10k Stats
  API requests at no more than about 10 starts/s.
- **Database.** About 30 round trips per chunk apply, plus 3–4 read-only helper queries per chunk.
- **Time.** The September week test took about 10 s to capture and 4 s to apply per chunk. Estimated
  totals: Triple-A 10–15 min, Double-A, High-A and Single-A about 8–12 min each. All four levels take
  about 40–60 min without retries.

## Validation done offline

- Unit tests cover:
  - the URL guard (21 refusal cases, credentials never echoed);
  - schema expectations;
  - SQL builders, each accepted by the read-only helper's parser/classifier, with injection-shaped
    values refused;
  - coverage discovery and the idempotency rules;
  - orchestration: plan, refusals, apply order, verified resume, `--recheck`, retries and backoff,
    retry exhaustion, interrupt, quarantine stop and acceptance, whole-capture quarantine,
    integrity-failure stop and recheck, review items, preserved-data change, state/branch mismatch,
    pre-existing invariant failures, a concurrent run.
- Every query was executed on PGlite (Postgres compiled to WASM) with the checked-in migrations, and
  checked against seeded good and bad data.
- An end-to-end run through the real `PostgresIngestionSink` on PGlite, with the synthetic fixture:
  - the plan wrote nothing;
  - the run stopped at the quarantined chunk;
  - the accepted rerun skipped the verified chunk;
  - a third run made 0 applies and left counts identical;
  - `--recheck` re-applied 9 captures with `changed: 0`.
- Not yet run: anything against Neon. Run the read-only plan first.
