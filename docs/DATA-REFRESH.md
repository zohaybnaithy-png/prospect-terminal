# Scheduled data refresh and freshness (Phase 5C)

Keeps MiLB and AFL data current without an operator, never runs two writers at once, survives API
outages and crashes, and makes stale data visible. **Nothing is scheduled yet**: the systemd timer
ships disabled, and enabling it is a deliberate, approved step (it writes to the production
database).

No new tables or migrations. Every write still goes through the existing pipeline
(`runMilbIngestion` / `ingest` → `PostgresIngestionSink`): one transaction per capture, strict
validation, quarantine, provenance, idempotency and freshness guards unchanged
([INGESTION.md](./INGESTION.md), [MILB-INGESTION.md](./MILB-INGESTION.md)).

## What a job does (`npm run -s refresh:data -- --apply`)

1. **Takes the job lock** (`src/ingestion/refresh/lock.ts`): a PostgreSQL session advisory lock on a
   dedicated connection. If another job or a manual `ingest:* --apply` / `backfill:milb --apply`
   holds it, the job records `locked` and exits 0 without fetching anything. The server releases
   the lock the moment the holder's connection ends, so a crashed or `kill -9`ed job never leaves
   it behind (tested). If the lock's connection drops mid-job, the job stops (another could start).
   Neon's `-pooler` endpoint (PgBouncer, transaction mode) cannot hold session locks, so the lock
   always connects to the direct endpoint (same credentials).
2. **Recovers dead captures**: `ingestion_runs` rows still `running` after 2 h belong to a process
   that died (a capture inserts that row right before its single, timeout-bounded transaction, which
   the server already rolled back). They are marked `failed` with `error_code = 'abandoned'`.
3. **Runs the steps due today** (`src/ingestion/refresh/schedule.ts`):

   | Step | What | When |
   |---|---|---|
   | `milb-structure` | leagues, teams, active rosters, people (= `ingest:milb --rosters-only --roster-type=active`) | MiLB window, unless one was applied < 20 h ago |
   | `milb-games` | incremental schedule + boxscores, all four levels (= `ingest:milb --incremental --games-only`) | MiLB window |
   | `afl` | full AFL season capture (~2.7k records) | AFL window |

   Windows: MiLB April 1 – September 30, AFL October 1 – November 20, each plus 10 days of grace for
   late corrections. Outside them the job finds nothing due and exits in about a second. `--force`
   runs regardless.
4. **Retries failures with bounded backoff**: up to 3 attempts per step, waiting 60 s then 300 s
   (+0–20% jitter), within a 45-minute job deadline. Retrying is always safe: captures are
   idempotent, incremental MiLB resumes from the latest stored complete game, and complete
   boxscores are not refetched. Not retried: quarantine (a data problem for a person to review) and
   permanent source errors (HTTP 4xx other than 408/429, e.g. a moved endpoint). Individual HTTP
   requests also keep their own transport retries (3 attempts, `Retry-After` honoured).
5. **Records the outcome**: the job record (status per step, attempts, durations, errors, counts) on
   stdout, appended to `<log-dir>/jobs.jsonl` and written to `<log-dir>/last-job.json`; each capture
   in `ingestion_runs` as before. Optional dead-man's switch: `PT_REFRESH_PING_URL` (https) is
   pinged on success and `<url>/fail` on failure (e.g. a free healthchecks.io check that alerts when
   pings stop or fail). Dry runs and `locked` jobs do not ping.

Exit codes: 0 = ok, ok with quarantined records, nothing due, or another job running;
1 = failed or timed out.

| Option | Default | |
|---|---|---|
| `--apply` | off (dry run: previews, writes nothing, takes no lock) | |
| `--season` | current year | |
| `--sources` | `milb,afl` | |
| `--force` | off | ignore season windows |
| `--max-attempts` | 3 | per step |
| `--retry-delays` | `60,300` | seconds before attempt 2, 3, … |
| `--timeout-minutes` | 45 | whole job |
| `--log-dir` | `~/pt-runs/refresh` | JSONL job log |

## Freshness (`npm run -s check:freshness`)

Read-only (every query in a `READ ONLY` transaction; the web server's read-only role is enough).
Reports, from what is stored:

- the latest final game with a complete boxscore per level, and a verdict per level: `fresh`,
  `stale` (older than 4 days in season), `no-data` (in season, nothing stored) or `off-season`;
- the last successful capture (`stale` if older than 36 h while any level is in season);
- failed or quarantined captures since the last success, and captures stuck in `running`
  (`attention`).

Exit 0 = ok, 1 = stale or attention (reasons on stderr), 2 = could not check. Thresholds:
`--max-success-age-hours`, `--max-game-age-days`. Good as a second timer or a cron job that emails
on a non-zero exit.

## Failure modes (all tested)

| Situation | Behaviour | Test |
|---|---|---|
| Timer fires while a job runs | systemd does not start a second oneshot instance; a manual run finds the lock held → `locked`, exit 0, no API calls | unit + DB + two concurrent CLI processes |
| Manual `ingest:* --apply` during a job | refuses with "Another ingestion job holds the database job lock" | CLI against a held lock |
| API down for one attempt | step retried after the backoff, succeeds; data identical | DB (mock outage) + CLI (mock HTTPS API returning 503) |
| API down for the whole retry window | step `failed` after 3 attempts, job exit 1, `/fail` ping; nothing partial written | DB + CLI |
| Permanent error (HTTP 404) | not retried; recorded with `permanent: true` | unit + CLI (found via the CLI test: a 404 was retried for 7 minutes) |
| Job killed (`kill -9`, OOM, reboot) | the lock is released by the server at once; any in-flight apply is rolled back; a leftover `running` row is reported by `check:freshness` and marked `abandoned` by the next job after 2 h | DB (terminated backend) + CLI (`kill -9`) |
| Job exceeds 45 min / lock connection lost | stops between attempts; an apply in progress rolls back | unit |
| Quarantined records | applied captures keep valid records; job `ok-with-quarantine` (or `failed` for a fully quarantined AFL capture); never retried; visible in `check:freshness` | unit + DB |
| Off-season | nothing due; freshness `off-season`, never `stale` | unit + CLI |

## Manual recovery

```bash
# What is the state?
npm run -s check:freshness
tail -n 3 /var/lib/prospect-terminal-ingest/refresh/jobs.jsonl   # on the ingestion host

# Retry now (safe at any time: idempotent, takes the lock, resumes incrementally)
sudo systemctl start prospect-terminal-refresh.service
journalctl -u prospect-terminal-refresh -n 100 --no-pager

# Refetch a specific range (e.g. after a source correction), as before
npm run -s ingest:milb -- --season=2026 --games-only --from=2026-06-01 --to=2026-06-07 --refetch-complete --apply
```

A job that keeps failing: read the step `error` in `last-job.json`. Network/5xx errors are usually
the API (wait; the next run retries). `permanent: true` means the request is wrong (check the
adapter). Quarantine: `SELECT code, message FROM ingestion_issues WHERE run_id = '<runId>'`.

## Enabling the schedule (after approval)

The writer credential must never be on the web server's environment
([DEPLOYMENT.md](./DEPLOYMENT.md), *Security*). The units therefore run as their own user with their
own root-only secrets file. On the same instance (simplest) or a separate small host:

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin prospect-ingest
sudo mkdir -p /etc/prospect-terminal-ingest
sudo install -m 600 -o root -g root /dev/null /etc/prospect-terminal-ingest/env
sudo nano /etc/prospect-terminal-ingest/env   # INGESTION_DATABASE_URL=… (writer role); optional PT_REFRESH_PING_URL=https://…
# The release directory must be readable by prospect-ingest (it is world-readable by default).
sudo cp deploy/prospect-terminal-refresh.service deploy/prospect-terminal-refresh.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start prospect-terminal-refresh.service      # one manual run first; check the journal
sudo systemctl enable --now prospect-terminal-refresh.timer # schedule: 10:20 and 16:20 UTC
systemctl list-timers prospect-terminal-refresh.timer
```

Tradeoff of the same instance: the writer credential is on the web server's disk (root-only, a
different user), not in its process environment. A separate host (or a CI scheduler with a secret)
removes even that, at the cost of another machine to run.

The running web server picks up new data by itself: a one-row `ingestion_runs` probe at most once a
minute reloads changed levels in the background (docs/DEPLOYMENT.md).

## Not covered

- Never run against the live MLB Stats API or Neon in this phase (no credentials in the build
  environment); the tests use a disposable local PostgreSQL and the synthetic fixtures, served
  through a mock fetch and a local HTTPS mock of the API.
- Season windows are fixed dates, not read from the schedule; adjust `ACTIVE_WINDOWS` if a season
  starts or ends unusually.
- No email/Slack integration in the app itself: alerting is the ping URL, systemd's exit status and
  `check:freshness`.
