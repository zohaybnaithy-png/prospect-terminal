# Staging server: rehearsal setup and teardown

A full rehearsal of the production deployment on one disposable server, against the Neon **staging**
branch (docs/NEON-STAGING.md). It follows docs/DEPLOYMENT-RUNBOOK.md, and lists only the
differences and the extra checks. Nothing here touches production data.

Steps marked **APPROVAL** create cloud resources, cost money, or write to a database. Do them
yourself. The rest are commands to run on the server or your Mac.

## Sizing (why 4 GB)

| Process | Cap (systemd) | Measured |
|---|---|---|
| App (`prospect-terminal.service`) | `MemoryMax=3G`, heap 1.5 GB, `LimitNOFILE=16384` | ~1.0 GB resident on a generated full-scale season (no growth over 6 full crawls); 1.1–1.25 GB on the real data (Phase 4, Neon) |
| Refresh job (when enabled) | `MemoryMax=1500M`, heap 1 GB | not measured on real data (first measurement: this rehearsal) |
| Monitor (every 5 min) | `MemoryMax=300M` | short-lived |
| Caddy | — | 60–180 MB (flood tests) |
| `next build` during a deploy | — | ~1.06 GB peak |

A deploy never builds while a refresh runs (`deploy.sh` checks), and a refresh never starts during a
deploy (`ExecCondition`). The worst remaining case is the app, the refresh, the monitor, Caddy and
the OS at once: app ~1.25 + refresh up to 1.5 (its cap) + monitor up to 0.3 + Caddy ~0.2 + OS
~0.3 ≈ 3.5 GB, still below 4 GB. **2 GB is not enough** with the refresh on the same host.
Add a 2 GB swap file anyway (step 2) as a safety margin for the first rehearsal.

## 1. Server — APPROVAL (purchase)

The runbook's Phase 2.1 with: AWS Lightsail, **4 GB / 2 vCPU**, Ubuntu 24.04, region `us-west-2`
(same as Neon), name `prospect-terminal-staging`, static IP attached. Firewall: 22 from your IP
only, 80 and 443 open. Lightsail bills hourly while the instance exists. Delete it when done
(Teardown).

## 2. Base system

Runbook 2.2 (packages, Node.js, Caddy from the **official** repository, so 2.8+, not Ubuntu's 2.6;
journald cap), then a swap file:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
caddy version          # 2.8 or newer expected (the Caddyfile also works on 2.6)
```

## 3. Users, code, units

Runbook 2.3–2.4 unchanged: `prospect` user, repository clone, web service, Caddy, sudo rule,
`shellcheck -x deploy/*.sh` (no output = OK). Then, for the rehearsal, also the ingestion user and
the two optional units. They're installed **but not enabled**:

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin prospect-ingest
sudo usermod -aG prospect-ingest prospect          # the monitor (User=prospect) reads the job state
cd /srv/prospect-terminal/repo
sudo cp deploy/prospect-terminal-refresh.service deploy/prospect-terminal-refresh.timer \
        deploy/prospect-terminal-monitor.service deploy/prospect-terminal-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
# The monitor reads Caddy's access log: allow the prospect user to read new log files in that directory.
sudo apt -y install acl && sudo setfacl -m u:prospect:rx /var/log/caddy && sudo setfacl -d -m u:prospect:r /var/log/caddy
```

## 4. Secrets (two root-only files)

```bash
sudo mkdir -p /etc/prospect-terminal /etc/prospect-terminal-ingest
sudo install -m 600 -o root -g root /dev/null /etc/prospect-terminal/env
sudo install -m 600 -o root -g root /dev/null /etc/prospect-terminal-ingest/env
sudo nano /etc/prospect-terminal/env          # from deploy/env.example
sudo nano /etc/prospect-terminal-ingest/env   # from deploy/ingest-env.example
```

`/etc/prospect-terminal/env` (web):

```
DATABASE_URL=<pt_web on staging, pooled>
PT_SITE_URL=https://staging.<your-domain>
PT_CLIENT_IP_HEADER=x-pt-client-ip
PT_INDEXING=off
```

`/etc/prospect-terminal-ingest/env` (ingestion; only if you rehearse the refresh job):

```
INGESTION_DATABASE_URL=<pt_ingest on staging>
PT_WRITE_TARGET_ENDPOINT=<STAGING_EP>
```

Check without printing values:

```bash
sudo grep -c '^PT_INDEXING=off$' /etc/prospect-terminal/env                 # 1
sudo grep -c '^DATABASE_URL=postgresql://pt_web:' /etc/prospect-terminal/env  # 1
sudo grep -c 'INGESTION_DATABASE_URL' /etc/prospect-terminal/env           # 0
sudo grep -c '^PT_WRITE_TARGET_ENDPOINT=ep-' /etc/prospect-terminal-ingest/env  # 1
```

Optional, from the server (read-only probes, rolled back):

```bash
cd /srv/prospect-terminal/repo && sudo -u prospect bash -c \
  'set -a; . /etc/prospect-terminal/env; set +a; PT_WEB_DATABASE_URL="$DATABASE_URL" npm run -s check:db-roles'
```

## 5. First deploy

Runbook 2.6: `sudo -u prospect -H /srv/prospect-terminal/repo/deploy/deploy.sh main`.

- It installs (with dev dependencies), runs the full test suite, builds, restarts, and keeps the
  release only if `/health` answers 200 within 180 s.
- With `PT_SITE_URL` or `PT_CLIENT_IP_HEADER` missing, `/health` is 503 `misconfigured` and the
  deploy is refused.

## 6. DNS, Caddy, firewall — APPROVAL (DNS record)

1. DNS: an **A record** `staging.<your-domain>` → the static IP.
2. Caddy, with a password for the private staging site:

   ```bash
   cd /srv/prospect-terminal/repo
   HASH="$(caddy hash-password)"        # type a password (store it in your password manager)
   sed -e "s/staging\.prospectterminal\.example/staging.<your-domain>/" \
       -e "s|REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT|$HASH|" deploy/Caddyfile.staging | sudo tee /etc/caddy/Caddyfile >/dev/null
   unset HASH
   sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
   ```

   The unedited file fails validation on purpose: no staging site without a password.
3. Per-source connection limit (runbook Phase 3 step 4, `deploy/nftables-conn-limit.nft`).

## 7. Rehearsal checks

From your Mac unless marked. `S=https://staging.<your-domain>`, `A='-u staging:<password>'`.

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Health, public | `curl -s $S/health` | 200, `"status":"ready"`, `"traffic":{"status":"protected"}`, `"indexing":"off"`, `process.rssMB` |
| 2 | Private | `curl -s -o /dev/null -w '%{http_code}' $S/` | 401 |
| 3 | Not indexable | `curl -s $A $S/robots.txt`; `curl -sI $A $S/ \| grep -i x-robots` | `Disallow: /`; `noindex, nofollow` |
| 4 | Pages | browse home, players, trends, data, a profile (with the password) | render; no console errors |
| 5 | Spoof resistance | runbook Phase 5 loop with forged `X-PT-Client-IP` (add `$A`) | both 200 and 429 |
| 6 | Prefetch classification | browse 10 pages quickly, then on the server `journalctl -u prospect-terminal --since -5min \| grep traffic` | refusals, if any, only in `prefetch`, never `profile` for normal browsing |
| 7 | Database failure visibility | Neon console: **suspend** the staging compute for ~2 min (APPROVAL); then `curl -s $S/health` | still 200, `refreshFailing` lists levels; clears after resume |
| 8 | Deploy + rollback | server: `deploy.sh main`; `rollback.sh`; `deploy.sh main` again | each ends healthy; `deployments.log` shows all three |
| 9 | Refresh (optional, APPROVAL: writes staging) | server: `sudo systemctl start prospect-terminal-refresh.service`; `cat /var/lib/prospect-terminal-ingest/refresh/last-job.json` | `ok`/`nothing-due`; never `error` with a TargetGuardError |
| 10 | Wrong-target guard | temporarily set `PT_WRITE_TARGET_ENDPOINT=ep-wrong` in the ingest env, start the unit, restore | status `error`, "endpoint … is not the approved endpoint", nothing written |
| 11 | Monitor | server: `sudo systemctl start prospect-terminal-monitor.service; journalctl -u prospect-terminal-monitor -n 30` | exit 0 when healthy; during check 7 it reports the database alert |
| 12 | Memory | after checks 4–8: `curl -s $S/health \| jq .process` and `systemctl status prospect-terminal` | rss well below 2.5 GB; no OOM in `journalctl -k` |
| 13 | Capacity (optional) | on the server, against a temporary local site (see below) | readers stay fast while an attacker is limited |

**Capacity on real hardware (13):** `npm run -s traffic:load` only targets loopback addresses, so
run it on the server against a temporary second Caddy site (`:8088 { reverse_proxy 127.0.0.1:3000
{ header_up X-PT-Client-IP {remote_host} } }` added to `/etc/caddy/Caddyfile`, reload, test, remove,
reload). The load generator shares the 2 vCPUs with the app, so treat the numbers as a lower bound.
Never point load tests at anything other than this staging server.

Enabling the timers is part of the rehearsal only if you want to watch them run (both are local
and use no external service): `sudo systemctl enable --now prospect-terminal-monitor.timer` and,
with the ingest env in place, `prospect-terminal-refresh.timer`. Disable them again in Teardown.

## Teardown (in this order)

```bash
# On the server
sudo systemctl disable --now prospect-terminal-refresh.timer prospect-terminal-monitor.timer 2>/dev/null
sudo systemctl stop prospect-terminal caddy
sudo shred -u /etc/prospect-terminal/env /etc/prospect-terminal-ingest/env
```

Then, **APPROVAL** in each console:

1. DNS: delete the `staging.<your-domain>` A record.
2. Lightsail: delete the instance, its snapshots, and **release the static IP** (an unattached
   static IP is billed).
3. Neon: delete the `staging` branch (docs/NEON-STAGING.md step 7), or keep it and *Reset from
   parent* for the next rehearsal.
4. Password manager: delete the staging role passwords and the Caddy staging password.

Nothing in production depends on any of these.
