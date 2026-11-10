# Neon staging branch: setup guide for the project owner

This guide makes an **isolated staging database**: a Neon branch with its own compute, its own data
copy and its own two roles (read-only web, writer for ingestion). Nothing in it needs production
credentials or production data. There is no production branch yet, and staging is built from the
existing **test branch**.

Steps marked **APPROVAL** create or change cloud resources. Do them yourself in the Neon console.
Passwords and connection strings never go into chat, the repository, or a file on your Mac.

| Thing | Value used below |
|---|---|
| Neon project | the existing Prospect Terminal project |
| Parent branch | the test branch, compute endpoint `ep-spring-cake-ak5jqlqp` (2026 MiLB + AFL data) |
| New branch | `staging` |
| Database | `neondb` (owner `neondb_owner`) |
| Roles created | `pt_web` (read-only, web server), `pt_ingest` (writer, scheduled ingestion) |

## Why a branch of the test branch

- **Isolated:** Neon branches are copy-on-write. The staging branch starts with exactly the test
  branch's data and its migrations (4 applied). Later writes to either branch never affect the
  other. Creating the child does not modify the parent.
- **No production involvement:** the test branch holds development data loaded from the MLB Stats
  API. Production doesn't exist yet. No production URL or password is needed at any step.
- **Repeatable:** Neon's *Reset from parent* returns staging to the test branch's current state
  (step 7), so every rehearsal can start from the same data.

## 1. Create the branch — APPROVAL

Neon console → project → **Branches** → **Create branch**:

- Name: `staging`
- Parent: the test branch (compute `ep-spring-cake-ak5jqlqp`)
- Include data up to: **Current point in time**
- Compute: create one. Autoscaling 0.25–1 CU; scale to zero is fine (the site serves from memory).

Note the new compute's endpoint id (`ep-…`). It's called `<STAGING_EP>` below. Don't make this branch
the project's default branch.

## 2. Verify staging matches the test branch (read-only)

On your Mac, in the repository. Use the **owner** connection string of the *staging* branch
(Neon → **Connect** → branch `staging`, role `neondb_owner`, pooled), pasted into a hidden prompt:

```bash
mkdir -p ~/pt-runs
read -rs INGESTION_DATABASE_URL && export INGESTION_DATABASE_URL
export PT_EXPECTED_ENDPOINT=<STAGING_EP>
node scripts/ops/pg-readonly.mjs file scripts/sql/milb-integrity-checks.sql > ~/pt-runs/staging-00-integrity.txt
npm run -s check:milb:readiness > ~/pt-runs/staging-00-readiness.json
unset INGESTION_DATABASE_URL PT_EXPECTED_ENDPOINT
```

Both tools refuse any endpoint other than `<STAGING_EP>`, run every statement in a read-only
transaction, and never print the connection string. Expected: `applied_migrations` is 4, the
integrity checks show no duplicates or orphans, and the readiness report passes at every level. If
you saved the same files for the test branch earlier (`prod-00-test-*` in the runbook), `diff` them:
only the header lines should differ.

## 3. Create the two roles — APPROVAL

Neon console → branch **`staging`** → **SQL Editor** (database `neondb`, as `neondb_owner`). Create
each role with SQL as written. Don't use the Console's Roles page: Console-created roles are members
of `neon_superuser`.

Generate each password on your Mac without displaying it, one at a time:

```bash
openssl rand -base64 33 | tr -d '/+=' | pbcopy   # copied to the clipboard
```

1. Paste `deploy/neon-readonly-role.sql`, replace `REPLACE_WITH_A_LONG_RANDOM_PASSWORD` with the
   clipboard, and run it. The verification queries at the end must show `f, f, f, f` and
   `can_write = 0`.
2. Generate a **new** password. Paste `deploy/neon-writer-role.sql`, replace the placeholder, and
   run it. Its verification must show `f, f, f, f`, `can_write` = number of tables,
   `can_truncate = 0` and `can_create = f`.

Keep the two passwords only until step 5 (a password manager entry is fine; a plain file is not).

## 4. Verify both roles from your Mac (read-only)

Build each connection string in Neon (**Connect** → branch `staging` → role `pt_web` or
`pt_ingest` → pooled). Paste each into a hidden prompt:

```bash
read -rs PT_WEB_DATABASE_URL && export PT_WEB_DATABASE_URL         # pt_web on staging
read -rs PT_WRITER_DATABASE_URL && export PT_WRITER_DATABASE_URL   # pt_ingest on staging
npm run -s check:db-roles > ~/pt-runs/staging-01-roles.json; echo "exit $?"
unset PT_WEB_DATABASE_URL PT_WRITER_DATABASE_URL
```

Exit 0 means every check passed:

- **Web role:** no write privilege anywhere, and an actual `UPDATE` is refused.
- **Writer role:** SELECT/INSERT/UPDATE/DELETE on every table, no TRUNCATE, no CREATE, owns no table, advisory locks work.

Every probe runs in a transaction that is rolled back. The same checks run in CI-style tests against
the checked-in SQL (`npm run test:roles:db`). A failure names the check. Fix the grant and run it
again.

## 5. Where the connection strings go

They are only ever stored on the staging server (docs/STAGING-SERVER.md), each in a root-only file:

| File | Variable | Value |
|---|---|---|
| `/etc/prospect-terminal/env` (web) | `DATABASE_URL` | `pt_web` on `staging`, **pooled** |
| `/etc/prospect-terminal-ingest/env` (ingestion) | `INGESTION_DATABASE_URL` | `pt_ingest` on `staging` (pooled or direct; the job lock uses the direct endpoint automatically) |
| same | `PT_WRITE_TARGET_ENDPOINT` | `<STAGING_EP>`: the refresh job refuses any other database before connecting |

Minimum environment for staging, all in those two files:

| Host role | Required | Optional |
|---|---|---|
| Web (`prospect-terminal.service`) | `DATABASE_URL`, `PT_SITE_URL=https://staging.<domain>`, `PT_CLIENT_IP_HEADER=x-pt-client-ip`, `PT_INDEXING=off` | `PT_MONITOR_PING_URL`, `PT_PROFILE_BUDGET_RPS` |
| Ingestion (`prospect-terminal-refresh.service`) | `INGESTION_DATABASE_URL`, `PT_WRITE_TARGET_ENDPOINT` | `PT_WRITE_TARGET_DATABASE` (default `neondb`), `PT_REFRESH_PING_URL`, `PT_SEASON_WINDOWS` |

Never on the web host's environment: `INGESTION_DATABASE_URL`, `ANALYTICS_DEBUG`.

## 6. Staging data

- **Default: nothing to do.** The branch already holds the full 2026 data from the test branch.
- **To exercise ingestion on staging** (optional; **APPROVAL**: it writes to the staging branch and
  calls the live MLB Stats API, development use): after the server is set up, run one manual
  refresh as the ingestion user. It writes only to `<STAGING_EP>`:

  ```bash
  sudo systemctl start prospect-terminal-refresh.service
  journalctl -u prospect-terminal-refresh -n 100 --no-pager
  ```

  Outside the MiLB/AFL windows it finds nothing due and exits in about a second. To exercise a real
  capture off-season, temporarily widen a window in `/etc/prospect-terminal-ingest/env`, e.g.
  `PT_SEASON_WINDOWS=afl=10-01..12-31`. Start the unit as above, then remove the line. Don't run
  the script by hand with the env file's contents on the command line: that would expose the
  password in the process list. The 2026 AFL season ended 2026-11-07, but the default AFL window
  runs to Nov 20. Set `PT_SEASON_WINDOWS=afl=10-01..11-07` (on both hosts' env files, since the
  monitor's freshness check reads it too) to avoid a false "stale" until then.

## 7. Reset or remove staging

- **Back to a known state (repeatable rehearsals):** Neon → branch `staging` → **Reset from
  parent**. Data returns to the test branch's current state. The roles are recreated by step 3 if
  the reset removed them. Re-run step 4 to check.
- **Remove staging entirely — APPROVAL:** Neon → branch `staging` → **Delete**. The compute, data
  and both roles go with it; the test branch is untouched. Then delete the two staging passwords
  from your password manager.

## What this guide never does

- It never creates or uses a production branch or production credentials.
- It never writes to the test branch: every tool here that writes is pinned to `<STAGING_EP>`, and
  the backfill tool only ever targets the test branch, which this guide doesn't use.
- It never changes the project's default branch.
