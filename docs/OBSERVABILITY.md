# Observability: minimum monitoring

The smallest set of signals that tells a person, before users do, that one of these happened: the
app is down, it serves errors, the database is failing, ingestion is failing or data is stale,
memory is running out, or traffic protection is off. Everything here runs on the server itself.
The only external piece is optional and free: a dead-man's-switch check that alerts when pings
stop. None is activated by the repository.

## Signals

| Failure | Where it shows | Alert path |
|---|---|---|
| App down (crash, OOM, stopped) | systemd restarts it (`Restart=always`); `/health` stops answering; Caddy returns 502 after 30 s | monitor `app` check; external uptime check on `/health`; monitor's dead-man ping stops if the whole machine is down |
| 5xx errors | Caddy access log (`/var/log/caddy/access.log`, JSON, `status` field) | monitor `http-5xx`: ≥ 5 errors and ≥ 2% of requests in 10 min |
| Database unreachable or failing **after start** | `/health` → `refreshFailing: [levels]` (status stays 200: the last data keeps being served); journal `[competition-data] … refresh failed` | monitor `health` check |
| Database unreachable **at start** | `/health` 503 `starting`/`degraded`; deploy rolls back | deploy output; external uptime check |
| Ingestion failure | `last-job.json` / `jobs.jsonl` status `failed`/`error`/`aborted`/`locked-stale`; `ingestion_runs` | refresh job's own `/fail` ping (`PT_REFRESH_PING_URL`); monitor `refresh` check |
| Ingestion stopped (timer off, host down) | no new job record | monitor `refresh`: no job for 26 h in season; the refresh ping stops |
| Stale data | `check:freshness` (per level: own captures and latest game) | monitor `freshness` (with `DATABASE_URL`) |
| High memory | `/health` → `process.rssMB`, `heapUsedMB`, `heapLimitMB` | monitor `memory`: rss above 2,560 MB (of the 3 GB `MemoryMax`) |
| Traffic protection misconfigured | `/health` 503 (`misconfigured` locally, `unavailable` publicly) | deploy refuses; external uptime check; monitor `traffic` |
| Traffic protection **disabled** (`PT_RATE_LIMIT=off`) | `/health` stays 200 (an emergency switch must not block a deploy); local body `"traffic":{"status":"disabled"}`; journal `rate limiting is OFF` every 10 min | monitor `traffic`: alerts on **every** run until it is removed |

## `/health` fields

**Public** (through Caddy, including on staging, where `/health` skips basic auth): only
`{"status":"ready"}` with 200, or `{"status":"unavailable"}` with 503. No memory or uptime, no
level or database state, no configuration reasons or header names, and nothing that says
traffic protection is off. Uptime checks need only the status code.

**Local** (a direct request to `http://127.0.0.1:3000/health` on the server: deploy gate,
monitor, operator). A request counts as local only when X-Forwarded-For is absent or loopback
**and** the Caddy-overwritten identity header is absent or loopback **and** there is no
`Forwarded` / `X-Real-IP` header (`src/lib/health-response.ts`). A forged X-Forwarded-For alone
unlocks nothing:

```json
{
  "status": "ready",
  "levels": { "aaa": "ready", "aa": "ready", "high-a": "ready", "single-a": "ready", "afl": "ready" },
  "refreshFailing": ["aaa"],
  "traffic": { "status": "protected" },
  "indexing": "on",
  "process": { "uptimeSeconds": 86400, "rssMB": 1010, "heapUsedMB": 610, "heapLimitMB": 1536 }
}
```

`refreshFailing` is present only while a background check or reload is failing. `traffic` is
`protected`, `disabled` (`PT_RATE_LIMIT=off`), `misconfigured` or `development`. The monitor
accepts only `protected`; a body without `traffic` (the public answer) also alerts, so a monitor
pointed at the public URL cannot pass silently. HTTP status is 200
only when `status` is `ready` and traffic protection is not misconfigured. The body never contains
error text, hosts or credentials.

## Local monitor (`npm run -s monitor`, `deploy/prospect-terminal-monitor.{service,timer}`)

- **What it does:** one run checks `app`, `health`, `traffic`, `memory`, `http-5xx`, `refresh` and `freshness`,
  and prints a JSON report. Exit codes: 0 ok, 1 alert, 2 could not run.
- **Missing inputs** (no access log on a dev machine, no refresh state, no `DATABASE_URL`) are
  reported as `skipped`, not as alerts.
- **It never echoes** the access log (client addresses) or connection strings.
- **Scheduling:** the timer runs it every 5 minutes as the `prospect` user. It's shipped disabled;
  enabling it is the owner's decision (docs/STAGING-SERVER.md).
- **Alerts:** without a ping URL, alerts show as failed runs (`systemctl --failed`,
  `journalctl -u prospect-terminal-monitor`). With `PT_MONITOR_PING_URL` (a free healthchecks.io-style
  check), every run pings and an alert pings `/fail`. The check then emails when the monitor
  reports a problem **or stops pinging**, which also covers the machine being down.

| Setting | Default |
|---|---|
| `PT_MONITOR_HEALTH_URL` | `http://127.0.0.1:3000/health` (must be the app directly: the public URL has no details, and the `traffic` check then alerts) |
| `PT_MONITOR_ACCESS_LOG` | `/var/log/caddy/access.log` (needs the read ACL from STAGING-SERVER.md step 3) |
| `PT_MONITOR_REFRESH_STATE` | `/var/lib/prospect-terminal-ingest/refresh/last-job.json` (group-readable `0750`) |
| `PT_MONITOR_RSS_MB_MAX` | 2560 |
| `PT_MONITOR_WINDOW_MINUTES` | 10 |
| `DATABASE_URL` | from `/etc/prospect-terminal/env` (read-only role) |

## Verified locally (production build, Caddy, local PostgreSQL; Phase 6A)

| Scenario | Result |
|---|---|
| Healthy stack | every check ok. With today's date (AFL window, no AFL data in the local set), `freshness` correctly alerted |
| PostgreSQL stopped, one request after the 60 s check window | pages still 200; `/health` 200 with `refreshFailing` = all five levels; monitor alert. After restart: cleared, monitor ok |
| App killed, 10 requests through Caddy | 10 × 502 after Caddy's 30 s retry; monitor: `app` alert and `http-5xx` alert (`502×10`, 10 of 39) |
| Unit tests (`scripts/observability.test.ts`) | refresh failure visible and cleared; each check's thresholds; a full run's ping goes to `/fail`; a healthy run pings success; missing inputs skipped |

## Not covered (by design, or not yet)

- **Alert delivery:** no email or SMS from the app itself. Delivery is the ping service's job, or
  `systemd` (`OnFailure=` to a mail unit) if you prefer.
- **Metrics history and dashboards:** none. The journal and the JSON reports are the record.
- **Error tracking with stack traces:** none (no external service). Server errors are in the journal.
- **Neon-side alerts** (compute suspended, storage): use Neon's own console and notifications.
