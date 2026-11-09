# Production deployment runbook

A step-by-step procedure for the first public deployment of Prospect Terminal: one AWS Lightsail
Linux server in Oregon (`us-west-2`, next to the Neon database), Caddy for HTTPS, systemd to keep
the app running. Why this setup: [DEPLOYMENT.md](./DEPLOYMENT.md). Files used here: `deploy/`.

**Nothing in this document has been run.** Steps marked **APPROVAL** create paid resources or
change a database; do them only after an explicit go-ahead.

## Ground rules

- **Credentials** never go into the repository, chat, tickets, screenshots or shell history
  output. Paste them only into the Neon console, the server's `/etc/prospect-terminal/env`, or a
  hidden prompt. If one leaks, rotate it (Neon → Roles → Reset password) and update the env file.
- **The test branch** (`ep-spring-cake-ak5jqlqp`) stays as it is. Nothing below writes to it.
- **The web server never writes to the database.** Its role can only read.
- Keep a private log of what you did (times, release names) outside the repository, for example
  in `~/pt-runs/`.

## What you need

- Access to the Neon project (console) and to the GitHub repository (settings → deploy keys).
- An AWS account (Lightsail) and a domain name you can edit DNS for.
- On your Mac: a terminal with `ssh`.

Approximate monthly cost: Lightsail 4 GB instance $24, automatic snapshots ~$4, domain ~$1–2,
plus Neon usage on your plan.

---

## Phase 1 — Production data (Neon)

Goal: a production copy of the verified test data, without touching the test branch.

### 1.1 Choose where production lives

- **Recommended: a new branch made from the test branch.** Neon branches are copy-on-write: the
  new branch starts with exactly the test branch's data at that moment, and later changes to either
  branch don't affect the other. Creating the child does not modify the parent.
- **Only if production must be an existing, separate database** (another project, or a branch
  that already exists): use the dump-and-restore alternative in 1.6 instead.

### 1.2 Record the test branch's fingerprint (read-only)

From the repository on your Mac, with the test branch's owner URL in your environment (as for
earlier runs):

```bash
mkdir -p ~/pt-runs
export INGESTION_DATABASE_URL="$(cat ~/.pt-neon-test-url)"
export PT_EXPECTED_ENDPOINT=ep-spring-cake-ak5jqlqp
node scripts/ops/pg-readonly.mjs file scripts/sql/milb-integrity-checks.sql > ~/pt-runs/prod-00-test-integrity.txt
npm run -s check:milb:readiness > ~/pt-runs/prod-00-test-readiness.json
unset INGESTION_DATABASE_URL
```

Both tools refuse any other host, connect read-only, and never print the connection string.

### 1.3 Create the production branch — **APPROVAL**

Neon console → your project → **Branches** → **Create branch**:

- Name: `production`
- Parent: the test branch (the one whose compute is `ep-spring-cake-ak5jqlqp`)
- Include data up to: **Current point in time**
- Create a compute for it. Suggested: autoscaling 0.25–1 CU; scale to zero is fine (the site
  serves from memory and wakes the database in the background).

Then on the `production` branch: set it as the project's **default** branch, and turn on
**branch protection** if your plan offers it. Note the new compute's endpoint id (`ep-…`).

Keep the test branch: a branch with children can't be deleted, and it remains the staging copy.

### 1.4 Verify the production branch matches (read-only)

In the Neon console, copy the production branch's **owner** connection string (pooled). In your
terminal, paste it into a hidden prompt so it isn't echoed or saved:

```bash
read -rs INGESTION_DATABASE_URL && export INGESTION_DATABASE_URL
export PT_EXPECTED_ENDPOINT=ep-xxxxxxxx   # the production endpoint id, not the test one
node scripts/ops/pg-readonly.mjs file scripts/sql/milb-integrity-checks.sql > ~/pt-runs/prod-01-prod-integrity.txt
npm run -s check:milb:readiness > ~/pt-runs/prod-01-prod-readiness.json
diff ~/pt-runs/prod-00-test-integrity.txt ~/pt-runs/prod-01-prod-integrity.txt && echo IDENTICAL
```

Expected: `IDENTICAL` apart from the target line (database role/time) at the top, the readiness
report passes at every level, and `applied_migrations` is 4. Stop if anything else differs.

### 1.5 Create the read-only web role — **APPROVAL**

Neon console → production branch → **SQL Editor** (database `neondb`, as `neondb_owner`).
Generate a long random password on your Mac without displaying it anywhere else:

```bash
openssl rand -base64 33 | tr -d '/+=' | pbcopy   # copied to the clipboard
```

Open `deploy/neon-readonly-role.sql`, paste its contents into the SQL Editor, replace
`REPLACE_WITH_A_LONG_RANDOM_PASSWORD` with the clipboard, and run it. The two verification
queries at the end must show `f, f, f, f` and `can_write = 0`. Create the role with SQL as written,
not in the Console's Roles page, because Console-created roles can write.

Build the web server's connection string: Neon → **Connect** → branch `production`, role
`pt_web`, **Pooled connection**. Keep it for step 2.5 only (don't save it in a file on your Mac).

Optionally prove the role can load the site but not write (read-only check as `pt_web`):

```bash
read -rs INGESTION_DATABASE_URL && export INGESTION_DATABASE_URL   # the pt_web URL
npm run -s check:milb:readiness > ~/pt-runs/prod-02-pt-web-readiness.json && echo OK
unset INGESTION_DATABASE_URL PT_EXPECTED_ENDPOINT
```

### 1.6 Alternative: dump and restore into an existing empty database — **APPROVAL**

Use only if 1.3 isn't possible. Run on the Lightsail server (same region, fast), after Phase 2,
with PostgreSQL client tools matching the Neon server's major version
(`sudo apt install postgresql-client-17` or as needed):

```bash
read -rs SRC && read -rs DST   # test-branch owner URL, production owner URL (hidden)
PGOPTIONS='-c default_transaction_read_only=on' pg_dump "$SRC" --format=custom --no-owner --no-privileges -f /tmp/pt.dump
pg_restore --dbname "$DST" --no-owner --no-privileges --single-transaction --exit-on-error /tmp/pt.dump
rm /tmp/pt.dump; unset SRC DST
```

`pg_dump` only reads, and the session is forced read-only. Then run 1.4 and 1.5 against the
production database.

---

## Phase 2 — Server

### 2.1 Create the instance — **APPROVAL (purchase)**

Lightsail console → **Create instance**:

- Region: **Oregon (us-west-2)**. Confirm it is offered; if not, use the nearest US West region
  and expect slower cold loads.
- Platform: Linux/Unix → OS only → **Ubuntu 24.04 LTS**
- Plan: **4 GB RAM, 2 vCPUs, 80 GB SSD** ($24/month)
- Name: `prospect-terminal`
- SSH key: create a new key pair and download it, or upload your own public key.

Then:

- **Networking → Create static IP**, attach it to the instance.
- **Networking → IPv4 firewall**: keep HTTP (80) and add HTTPS (443) from anywhere. Edit SSH (22)
  to **Restrict to IP address** → your current IP. If more than one rule exists for a port, the
  most permissive applies, so delete any broader SSH rule.
- **Snapshots → Automatic snapshots**: enable (7 daily snapshots kept).

### 2.2 First login and base packages

```bash
chmod 600 ~/Downloads/LightsailKey.pem      # if you downloaded Lightsail's key
ssh -i ~/Downloads/LightsailKey.pem ubuntu@STATIC_IP
```

On the server:

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install git curl ca-certificates shellcheck unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades     # answer Yes: automatic security updates
sudo timedatectl set-timezone UTC

# Node.js 26 (the version the site was tested with), from NodeSource.
curl -fsSL https://deb.nodesource.com/setup_26.x -o /tmp/nodesource_setup.sh
less /tmp/nodesource_setup.sh                       # look it over, then
sudo bash /tmp/nodesource_setup.sh && sudo apt -y install nodejs
node -v                                             # v26.x

# Caddy, from its official repository.
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy

# Keep the journal across reboots, capped at 500 MB.
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=500M\n' | sudo tee /etc/systemd/journald.conf.d/prospect.conf
sudo systemctl restart systemd-journald
```

### 2.3 App user, directories and code

```bash
sudo adduser --system --group --home /srv/prospect-terminal --shell /bin/bash prospect
sudo -u prospect mkdir -p /srv/prospect-terminal/releases /srv/prospect-terminal/.ssh
sudo -u prospect ssh-keygen -t ed25519 -N '' -C prospect-terminal-deploy -f /srv/prospect-terminal/.ssh/id_ed25519
sudo cat /srv/prospect-terminal/.ssh/id_ed25519.pub
```

On GitHub: repository → **Settings → Deploy keys → Add deploy key**, paste that public key, leave
**Allow write access unchecked** (read-only). Then:

```bash
sudo -u prospect git clone git@github.com:zohaybnaithy-png/prospect-terminal.git /srv/prospect-terminal/repo
# (answer "yes" to GitHub's host key once)
```

### 2.4 Install the service, proxy and sudo rule, and validate them

```bash
cd /srv/prospect-terminal/repo
sudo cp deploy/prospect-terminal.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/prospect-terminal.service   # no output = OK
sudo install -m 440 deploy/sudoers-prospect-terminal /etc/sudoers.d/prospect-terminal
sudo visudo -cf /etc/sudoers.d/prospect-terminal                             # "parsed OK"
sudo -l -U prospect | grep systemctl     # exactly: restart and reset-failed prospect-terminal
shellcheck -x deploy/*.sh                                                    # no output = OK
sudo systemctl daemon-reload && sudo systemctl enable prospect-terminal
```

(`systemd-analyze verify` may warn that `/srv/prospect-terminal/current` doesn't exist yet; that
is expected before the first deploy.)

### 2.5 The secrets file

```bash
sudo mkdir -p /etc/prospect-terminal
sudo install -m 600 -o root -g root /dev/null /etc/prospect-terminal/env
sudo nano /etc/prospect-terminal/env
```

Type `DATABASE_URL=` and paste the `pt_web` pooled connection string from 1.5 (see
`deploy/env.example` for the shape). Save. Check without printing the value:

```bash
sudo grep -c '^DATABASE_URL=postgresql://pt_web:' /etc/prospect-terminal/env   # 1
sudo stat -c '%a %U' /etc/prospect-terminal/env                                 # 600 root
```

### 2.6 First deploy

```bash
sudo -u prospect -H /srv/prospect-terminal/repo/deploy/deploy.sh main
```

It fetches `main`, installs, runs the test suite, builds, starts the service and waits for
`/health`. Expect a few minutes, ending with `deployed <commit> (main)`. Then:

```bash
curl -s http://127.0.0.1:3000/health        # {"status":"ready",...}
sudo journalctl -u prospect-terminal -n 50 --no-pager
```

If it fails: the output names the step. The build log is in `/srv/prospect-terminal/logs/`, the
app's log in `journalctl -u prospect-terminal`. If the first deploy builds but never becomes
healthy, there is nothing to fall back to: the script removes `current` (so nothing points at the
broken build), sets the build aside in `/srv/prospect-terminal/failed/`, records it in
`deployments.log`, and exits with status 2. Fix the cause and run the same command again; it
starts the service normally.

---

## Phase 3 — Domain and HTTPS

1. At your DNS provider: an **A record** for the domain (e.g. `example.com`) and for `www`, both
   pointing at the static IP. Wait until `dig +short example.com` on your Mac returns that IP.
2. On the server, put the real domain into the Caddy config and validate it:

   ```bash
   cd /srv/prospect-terminal/repo
   sed 's/prospectterminal\.example/example.com/g' deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile >/dev/null
   sudo caddy validate --config /etc/caddy/Caddyfile        # "Valid configuration"
   sudo systemctl reload caddy
   ```

3. Caddy obtains the certificate within a minute. Check from your Mac:
   `curl -sI https://example.com | head -5` shows `HTTP/2 200` and `strict-transport-security`.

---

## Phase 4 — Monitoring

- **Uptime**: create a free monitor (UptimeRobot, Better Stack or similar) for
  `https://example.com/health`, every 1–5 minutes, expecting status 200, alerting your email.
- **Lightsail alarm**: instance → **Metrics** → CPU utilization → add an alarm (e.g. ≥ 80% for
  10 minutes) with email notification (add your email as a notification contact first).
- **Snapshots**: confirm the first automatic snapshot appears the next day.

---

## Phase 5 — Launch checks

From your Mac, against `https://example.com`:

- [ ] `/health` returns 200 with every level `ready`.
- [ ] Home, `/players`, `/trends`, `/data` and a player profile load; the level tabs work.
- [ ] `/nope` and `/players/00000000-0000-0000-0000-000000000000` return 404.
- [ ] `/analytics/models` returns 404.
- [ ] `curl -sI https://example.com` shows the security headers and HSTS, and no `x-powered-by`.
- [ ] `http://example.com` redirects to HTTPS; `www` redirects to the bare domain.
- [ ] On the server, `sudo journalctl -u prospect-terminal --since today | grep -ci postgres`
      prints `0` (no connection details in logs).
- [ ] The uptime monitor reports up.

---

## Day-to-day operations

| Task | Command (on the server) |
|---|---|
| Deploy the latest `main` | `sudo -u prospect -H /srv/prospect-terminal/repo/deploy/deploy.sh main` |
| Deploy a tag or commit | `sudo -u prospect -H /srv/prospect-terminal/repo/deploy/deploy.sh v1.0.1` |
| List releases (`*` = current) | `sudo -u prospect -H /srv/prospect-terminal/repo/deploy/rollback.sh --list` |
| Roll back one release | `sudo -u prospect -H /srv/prospect-terminal/repo/deploy/rollback.sh` |
| Roll back to a named release | `… rollback.sh 20261108T210342Z-5fbe7bb` |
| App status / logs | `systemctl status prospect-terminal` · `journalctl -u prospect-terminal -f` |
| Restart the app | `sudo systemctl restart prospect-terminal` |
| Deploy history | `cat /srv/prospect-terminal/deployments.log` |
| Change the DB password | Neon → Roles → `pt_web` → reset; edit `/etc/prospect-terminal/env`; restart the app |
| OS reboot (after kernel updates) | `sudo reboot` (the app and Caddy start by themselves) |

The deploy script uses the scripts from the checked-out repository; pull them first if they
changed: `sudo -u prospect git -C /srv/prospect-terminal/repo pull --ff-only`.

A deploy builds next to the running release, so the site stays up during the build. The switch
itself pauses requests for ~15 s while the new process loads the data, and Caddy holds those
requests rather than failing them. A release whose health check doesn't pass is rolled back
automatically and moved to `/srv/prospect-terminal/failed/`. If a manual rollback target doesn't
pass its health check, `rollback.sh` switches back to the release that was running and checks it.

Exit status of both scripts, and what `deployments.log` records:

| Exit | Meaning | Action |
|---|---|---|
| 0 | New release (or rollback target) is serving and healthy | None |
| 1 | Nothing changed, or the change was undone and the earlier release is healthy again (`FAILED … rolled back to …` / `FAILED … restored …`) | Read the message and the journal; the site is up |
| 2 | Nothing healthy is serving: a failed first deploy, or the fallback release is unhealthy too (`… also FAILED` / `… not healthy either`) | The site is down: check `journalctl -u prospect-terminal -n 200` and `/health`, then deploy a fixed release or roll back by name |

## Troubleshooting

| Symptom | Check |
|---|---|
| `/health` stays `starting` | `journalctl -u prospect-terminal`: look for `load failed`. Usually the database URL or Neon compute; the health check retries automatically |
| `/health` says `degraded` | A level's first load failed; it retries with backoff (5 s → 60 s). Look for `[competition-data] … load failed` |
| 502 from Caddy for > 30 s | The app isn't running: `systemctl status prospect-terminal`; if it stopped after 10 quick failures, fix the cause and `sudo systemctl restart prospect-terminal` |
| Certificate not issued | DNS must point at the static IP and ports 80/443 must be open; `journalctl -u caddy` |
| Out of memory in the journal | Shouldn't happen after the profile cache fix; capture `journalctl` output and roll back |
| Deploy says another deploy is running | Only if a deploy was interrupted: confirm none runs (`pgrep -f deploy.sh`), then `rmdir /srv/prospect-terminal/.deploy.lock` |
