# MiLB → Neon ingestion runbook (for approval)

A safe, staged procedure for loading 2026 MiLB data (Triple-A, Double-A, High-A, Single-A) into the
shared Neon database that powers the site. **Nothing in this document has been run against Neon.**
Each `--apply` step is a write and needs explicit approval (see `CLAUDE.md`, Database safety).

The pipeline itself is documented in [MILB-INGESTION.md](./MILB-INGESTION.md). It has already passed
two live read-only validations: schedule-chain reconciliation, seven-day chunk consistency,
resumed-game box-score normalization, and a CLI dry run with zero issues. Do not repeat
full-season live dry runs. The steps below only add what has not been done yet: writes to a real
database, at increasing scale.

## Ground rules

- **Secrets.** Connection strings live only in your shell environment. Never echo them, paste them
  into tickets or chat, or commit them. Every command below references `"$INGESTION_DATABASE_URL"`
  without printing it. CLI errors are redacted; `psql` errors may name the host, so keep its
  output private.
- **Two URLs.** `INGESTION_DATABASE_URL` is the writer, used by `ingest:*` and migrations.
  `DATABASE_URL` is the web app's reader. For production, give the app a Neon role that can only
  `SELECT`. The app's queries already run in `READ ONLY` transactions; a read-only role makes
  that a database guarantee.
- **Restore point first.** Before the first apply, create a Neon branch from the target branch
  (Neon console → Branches → Create branch). Do steps 1–4 against **that branch's** connection
  string. Only after they pass, repeat steps 2–5 against the production branch.
- **One writer at a time.** Do not run two `--apply` commands concurrently.
- **Logs.** stdout is the final JSON summary and stderr is progress. Keep both outside the repo,
  for example in `~/pt-runs/`.

```bash
mkdir -p ~/pt-runs
```

## Step 0 — local rehearsal (no Neon, already passing in CI-equivalent runs)

Run this on a disposable local PostgreSQL. It uses the same commands, so the procedure is
rehearsed end to end.

```bash
npm ci && npm run typecheck && npm run lint && npm test && npm run build
```

```bash
DATABASE_URL="$MILB_TEST_DATABASE_URL" npm run db:migrate && npm run test:milb:db
```

`test:milb:db` ingests the fictional fixture through the real sink. It then reads every level
through the site's own read path: one directory row per player and correct profile levels.

## Step 1 — verify the target database and schema (read-only)

```bash
psql "$INGESTION_DATABASE_URL" -X -A -t -c "select current_database(), current_user, now()"
```

```bash
psql "$INGESTION_DATABASE_URL" -X -A -t -c "select count(*) from drizzle.__drizzle_migrations"
```

- **Database name:** confirm it is the intended Neon branch database, not production, while you
  are in the rehearsal phase.
- **Migrations:** expect `4` (`drizzle/0000` … `0003`). If the count is lower, apply them
  (schema change, so get approval first):

  ```bash
  DATABASE_URL="$INGESTION_DATABASE_URL" npm run db:migrate
  ```

  If the count is higher, stop: the database is ahead of this code.

- **Baseline:** record a baseline. The script is read-only (a `READ ONLY` transaction that ends
  in `ROLLBACK`).

  ```bash
  psql "$INGESTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/sql/milb-integrity-checks.sql > ~/pt-runs/00-baseline.txt
  ```

  The expected AFL baseline is unchanged: the live AFL snapshot has 2,680 records and 0 issues.

## Step 2 — small, bounded ingestion (one level, one week)

1. **Read-only preview against the target.** With `INGESTION_DATABASE_URL` set, the dry run
   compares against the database without writing:

   ```bash
   npm run ingest:milb -- --season=2026 --level=aaa --from=2026-09-15 --to=2026-09-21 --dry-run > ~/pt-runs/01-aaa-week-preview.json 2> ~/pt-runs/01-aaa-week-preview.log
   ```

   Check that `status` is `ok`, `totals.issues` is `0`, and the notices are only known
   informational kinds (reschedules, resumptions, `outside-scope`).

2. **Apply (needs approval).** This runs the AAA structure pass (teams, organizations, rosters,
   people) plus one 7-day games chunk, in one transaction per chunk.

   ```bash
   npm run ingest:milb -- --season=2026 --level=aaa --from=2026-09-15 --to=2026-09-21 --apply > ~/pt-runs/02-aaa-week-apply.json 2> ~/pt-runs/02-aaa-week-apply.log
   ```

   Expect `status: ok` and no `resumeFrom`. If it fails, nothing from the failed chunk is kept,
   because each chunk rolls back as a unit.

## Step 3 — check integrity, counts and player statistics

```bash
psql "$INGESTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/sql/milb-integrity-checks.sql > ~/pt-runs/03-after-week.txt
```

```bash
diff ~/pt-runs/00-baseline.txt ~/pt-runs/03-after-week.txt
```

- **Section 2:** Triple-A has about 30 teams' games for Sep 15–21 (≈ 90 games). The complete
  count matches the final games in the preview. AFL counts are identical to the baseline.
- **Sections 4–8:** 0 rows. Section 6 must be empty for live data. The fictional fixtures are
  intentionally minimal and can list games there; live data must not.
- **Section 3:** the issue codes, if any, match the preview.
- **Spot-check in the app.** Point a local app at the branch (reader URL) and open these pages:

  ```bash
  DATABASE_URL="$INGESTION_DATABASE_URL" npm run build && DATABASE_URL="$INGESTION_DATABASE_URL" npm start
  ```

  - `/data`: Triple-A is "Live — through Sep 21", and the other MiLB levels read "Not ingested".
  - `/players?level=aaa`: pick three players. Compare G/PA/H/HR and IP/SO with their MiLB.com
    game logs for Sep 15–21.
  - `/players/<id>?level=aaa`: the game log has exactly the games from that week.
  - `/`, `/trends?level=aaa`: windows read "unavailable" where there is no earlier baseline. One
    week has no earlier games, which is expected and honest.

## Step 4 — repeat to prove idempotency

Re-run the exact command from Step 2.2. Use `--games-only` so the roster capture is not repeated.

```bash
npm run ingest:milb -- --season=2026 --level=aaa --from=2026-09-15 --to=2026-09-21 --games-only --apply > ~/pt-runs/04-aaa-week-replay.json 2> ~/pt-runs/04-aaa-week-replay.log
```

```bash
psql "$INGESTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/sql/milb-integrity-checks.sql > ~/pt-runs/04-after-replay.txt
```

```bash
diff ~/pt-runs/03-after-week.txt ~/pt-runs/04-after-replay.txt
```

**Expect:**

- The summary reports `changed: 0`. The exception is games inside the refetch window
  (`--refetch-window-days`, 3), which may legitimately report late scorer corrections.
- Section 2 counts are identical, and sections 4–8 are still empty.
- The diff shows only the new run in section 3.
- A replay that includes the structure pass is also safe. Roster observations are keyed by
  capture time, so it adds one observation per rostered player. That is expected, not
  duplication.

## Step 5 — full 2026 backfill in resumable chunks

Go level by level, so each step is reviewable and a failure is contained. The default range is
Mar 1 – Oct 31, in 7-day chunks with one transaction each.

```bash
npm run ingest:milb -- --season=2026 --level=aaa --apply > ~/pt-runs/10-aaa.json 2> ~/pt-runs/10-aaa.log
```

```bash
npm run ingest:milb -- --season=2026 --level=aa --apply > ~/pt-runs/11-aa.json 2> ~/pt-runs/11-aa.log
```

```bash
npm run ingest:milb -- --season=2026 --level=high-a --apply > ~/pt-runs/12-high-a.json 2> ~/pt-runs/12-high-a.log
```

```bash
npm run ingest:milb -- --season=2026 --level=single-a --apply > ~/pt-runs/13-single-a.json 2> ~/pt-runs/13-single-a.log
```

- **After each level:**
  - Rerun the integrity script and diff it against the previous output.
  - Check that `status` is `ok` or `ok-with-quarantine`. Review every quarantine in
    `ingestion_issues`.
  - Re-check Step 3's spot checks for that level.
- **If a chunk fails:** the summary's `resumeFrom` gives the first date of the failed chunk.
  Resume with the same level and that date. Finished chunks are never redone:

  ```bash
  npm run ingest:milb -- --season=2026 --level=aa --from=<resumeFrom> --apply
  ```

- **Expected volume:**
  - About 9k requests and about 15 minutes for all four levels at the default concurrency
    of 4. A single level takes roughly a quarter of that.
  - Each chunk takes about 30 database round trips.
- **Ongoing updates** (no scheduler is installed; run it manually or wire a cron later):

  ```bash
  npm run ingest:milb -- --season=2026 --incremental --apply
  ```

## Rollback

- **A failed chunk** rolls back automatically.
- **A completed apply you want to undo:** reset the Neon branch from its parent, or restore the
  restore-point branch created at the start. Do not hand-delete rows: source identities, record
  state and provenance must stay consistent.

## Web app sizing note

The site reads each level's full season into memory, and the result is reused for 60 s per
server process. A full MiLB season is about 9k games and about 250k stat lines across the four
levels. Measured locally on a synthetic Triple-A-scale level (2,115 games, 46k lines), the
directory, trending and profile view models cost about 0.5 s of CPU on a cold start. They are
memoized per load after that. The first request after a reload also transfers every level's
rows from Neon. Before a public launch, load-test `/players` against the backfilled branch. If
cold loads are too slow, the next step is precomputed per-level aggregates, which is a separate
change to discuss.
