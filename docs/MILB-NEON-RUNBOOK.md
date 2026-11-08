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
  without printing it. CLI errors are redacted; database errors may name the host, so keep
  their output private.
- **Read-only queries without psql.** `scripts/ops/pg-readonly.mjs` runs the read-only checks
  with the project's `pg` package (no `psql`/Homebrew needed). It refuses to connect unless the
  host matches `PT_EXPECTED_ENDPOINT` (set it first, e.g. `export PT_EXPECTED_ENDPOINT=ep-spring-cake-ak5jqlqp`
  for the test branch), `sslmode` is `require`/`verify-full`/`verify-ca` and the TLS certificate
  verifies; it accepts only `SELECT`/`WITH` and runs inside a `READ ONLY` transaction that is
  rolled back. `node scripts/ops/pg-readonly.mjs selftest` checks its guards offline.
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

## Steps 1–4 in one guarded script

`scripts/ops/milb-week-test.sh` runs Steps 1–4 for the Triple-A week (Sep 15–21) against the test
branch. It stops on the first failed check.

- **Endpoint gate:** the endpoint must be `ep-spring-cake-ak5jqlqp` (the replacement test branch; the
  old `ep-lucky-sea-akc835g5` is retired) and the connection must use SSL. The script also requires
  the 4 migrations and the 26 tables they create, and names any missing table.
- **Before any write:** it checks migrations, takes a baseline, and checks the saved dry run.
  `scripts/ops/milb-notices.ts` then re-reads the week from the Stats API without any database and
  lists every notice reason; unknown kinds stop the script.
- **Writes:** it asks you to type `APPLY`, then applies the week. It runs integrity and box-score
  checks, then a games-only replay that must change 0 rows and leave counts identical.
- **Credential:** read from the environment or a hidden prompt; it is never printed or saved.
  Outputs go to `~/pt-runs`, ending with `09-summary.json`, which is safe to share.

Use `npm run -s` when redirecting CLI output: without `-s`, npm writes a banner line to stdout and
the saved JSON is not valid.

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
node scripts/ops/pg-readonly.mjs query "select current_database(), current_user, now()"
```

```bash
node scripts/ops/pg-readonly.mjs query "select count(*) from drizzle.__drizzle_migrations"
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
  node scripts/ops/pg-readonly.mjs file scripts/sql/milb-integrity-checks.sql > ~/pt-runs/00-baseline.txt
  ```

  The expected AFL baseline is unchanged: the live AFL snapshot has 2,680 records and 0 issues.

## Step 2 — small, bounded ingestion (one level, one week)

1. **Read-only preview against the target.** With `INGESTION_DATABASE_URL` set, the dry run
   compares against the database without writing:

   ```bash
   npm run -s ingest:milb -- --season=2026 --level=aaa --from=2026-09-15 --to=2026-09-21 --dry-run > ~/pt-runs/01-aaa-week-preview.json 2> ~/pt-runs/01-aaa-week-preview.log
   ```

   Check that `status` is `ok`, `totals.issues` is `0`, and the notices are only known
   informational kinds (reschedules, resumptions, `outside-scope`).

2. **Apply (needs approval).** This runs the AAA structure pass (teams, organizations, rosters,
   people) plus one 7-day games chunk, in one transaction per chunk.

   ```bash
   npm run -s ingest:milb -- --season=2026 --level=aaa --from=2026-09-15 --to=2026-09-21 --apply > ~/pt-runs/02-aaa-week-apply.json 2> ~/pt-runs/02-aaa-week-apply.log
   ```

   Expect `status: ok` and no `resumeFrom`. If it fails, nothing from the failed chunk is kept,
   because each chunk rolls back as a unit.

## Step 3 — check integrity, counts and player statistics

```bash
node scripts/ops/pg-readonly.mjs file scripts/sql/milb-integrity-checks.sql > ~/pt-runs/03-after-week.txt
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
npm run -s ingest:milb -- --season=2026 --level=aaa --from=2026-09-15 --to=2026-09-21 --games-only --apply > ~/pt-runs/04-aaa-week-replay.json 2> ~/pt-runs/04-aaa-week-replay.log
```

```bash
node scripts/ops/pg-readonly.mjs file scripts/sql/milb-integrity-checks.sql > ~/pt-runs/04-after-replay.txt
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

## Step 5 — full 2026 backfill (guarded runner)

Use `npm run backfill:milb`. Details, gates, checks and outputs are in
[MILB-BACKFILL.md](./MILB-BACKFILL.md). It processes one level at a time in 7-day chunks over the
real schedule coverage, which it reads from the Stats API. After every chunk and level it runs
read-only integrity checks, re-previews sample chunks read-only to prove idempotency, and checks
that the AFL data and the Triple-A week are unchanged. Restarting skips only chunks that the
database verifies as complete.

```bash
# 1. Read-only plan against the test branch (no writes anywhere):
npm run -s backfill:milb -- --season=2026 > ~/pt-runs/backfill-plan.json 2> ~/pt-runs/backfill-plan.log
# 2. Apply one level at a time (WRITES; explicit approval required):
npm run -s backfill:milb -- --season=2026 --level=aaa --apply --confirm=ep-spring-cake-ak5jqlqp > ~/pt-runs/backfill-aaa.json 2> ~/pt-runs/backfill-aaa.log
npm run -s backfill:milb -- --season=2026 --level=aa --apply --confirm=ep-spring-cake-ak5jqlqp > ~/pt-runs/backfill-aa.json 2> ~/pt-runs/backfill-aa.log
npm run -s backfill:milb -- --season=2026 --level=high-a --apply --confirm=ep-spring-cake-ak5jqlqp > ~/pt-runs/backfill-high-a.json 2> ~/pt-runs/backfill-high-a.log
npm run -s backfill:milb -- --season=2026 --level=single-a --apply --confirm=ep-spring-cake-ak5jqlqp > ~/pt-runs/backfill-single-a.json 2> ~/pt-runs/backfill-single-a.log
# 3. Read-only analytics readiness for every level:
npm run -s check:milb:readiness > ~/pt-runs/readiness.json
```

- **After each level:** check `status` in the JSON (`complete`, or `complete-with-review` with the
  items under `levelReports[].review`), and diff `integrity-<level>.txt` against the previous
  report in `~/pt-runs/milb-backfill-2026/`.
- **If it stops:** `stop.reason`, `stop.level` and `stop.from` say why and where. Fix the cause and
  re-run the same command.
- **Expected volume** (from the real 2026 schedule): 96 chunks, about 8.3k games and roughly 10k
  Stats API requests. That is about 40–60 minutes for all four levels.
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

The site reads each level's full season into memory (about 8.4k games and 222k stat lines across
the five levels for 2026). Each server process loads every level once, starting at server start
(`src/instrumentation.ts`), and keeps it: at most every 60 s a one-row probe of `ingestion_runs`
checks whether a run was applied, and only then is that level reloaded in the background while
the previous snapshot keeps being served (`src/services/competition/cache.ts`). Stat lines are
transferred in a compact columnar form (`src/services/afl/columnar.ts`), about a third of the
row form's bytes. View models are memoized per loaded snapshot and the Momentum caches are
warmed before a snapshot is served.

Measure with `npm run -s profile:site` (read-only; per-level load time and per-page view-model
compute). On a home connection to Neon (~1 MB/s), a level loads in about 3-5 s and all levels in
parallel in about 6-13 s; requests after the warm-up are served from memory. If cold loads must
get faster still, the next step is precomputed per-level aggregates, a separate change to
discuss.
