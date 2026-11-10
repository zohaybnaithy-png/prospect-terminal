# shellcheck shell=bash
# Shared settings and helpers for deploy.sh / rollback.sh (sourced, not run).
# Every value can be overridden from the environment (used by the local rehearsal test).
PT_ROOT="${PT_ROOT:-/srv/prospect-terminal}"
PT_REPO="${PT_REPO:-$PT_ROOT/repo}"
PT_RELEASES="$PT_ROOT/releases"
PT_CURRENT="$PT_ROOT/current"
PT_HEALTH_URL="${PT_HEALTH_URL:-http://127.0.0.1:3000/health}"
PT_HEALTH_TIMEOUT="${PT_HEALTH_TIMEOUT:-180}"
PT_HEALTH_INTERVAL="${PT_HEALTH_INTERVAL:-2}"
PT_KEEP="${PT_KEEP:-5}"
# Restart the app. On the server: a sudoers rule allows exactly this command (see the runbook).
PT_RESTART_CMD="${PT_RESTART_CMD:-sudo /usr/bin/systemctl restart prospect-terminal}"
# Clears systemd's start limit (hit when a broken release crash-loops) so a restart is accepted.
PT_RESET_CMD="${PT_RESET_CMD:-sudo -n /usr/bin/systemctl reset-failed prospect-terminal}"
# Succeeds while a scheduled data refresh is running (no sudo needed to ask). deploy.sh does not
# build then: on a 4 GB host the build (~1 GB) on top of the app (~1.2 GB) and a refresh job is the
# out-of-memory risk. PT_ALLOW_DEPLOY_DURING_REFRESH=1 overrides (e.g. an urgent fix).
PT_REFRESH_ACTIVE_CMD="${PT_REFRESH_ACTIVE_CMD:-systemctl is-active --quiet prospect-terminal-refresh.service}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Only one deploy/rollback at a time (mkdir is atomic on every filesystem).
take_lock() {
  mkdir "$PT_ROOT/.deploy.lock" 2>/dev/null ||
    die "another deploy or rollback is running (remove $PT_ROOT/.deploy.lock only if you are sure it is not)"
  trap 'rmdir "$PT_ROOT/.deploy.lock" 2>/dev/null || true' EXIT
}

current_release() {
  if [ -L "$PT_CURRENT" ]; then readlink "$PT_CURRENT"; fi
  return 0
}

# Release directories, newest first (names start with a UTC timestamp).
list_releases() { find "$PT_RELEASES" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -r; }

switch_to() { ln -sfn "$1" "$PT_CURRENT"; }

# A failed restart is logged, not fatal: the health check that follows decides the outcome, so
# the caller always gets to restore a working release.
restart_app() {
  log "restarting the app"
  $PT_RESET_CMD >/dev/null 2>&1 || true
  $PT_RESTART_CMD || log "restart command failed (exit $?)"
}

# A release that can be served: a completed build inside releases/ (never one set aside in failed/).
valid_release() { [ -n "$1" ] && [ "$(dirname "$1")" = "$PT_RELEASES" ] && [ -f "$1/.next/BUILD_ID" ]; }

# One line per outcome in deployments.log (deploy history).
record() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$PT_ROOT/deployments.log"; }

# Waits until the health check answers 200 (every level's data loaded). Never prints the response
# body beyond the status, which contains only level states.
wait_healthy() {
  local deadline=$(( $(date +%s) + PT_HEALTH_TIMEOUT )) code=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$PT_HEALTH_URL" || true)"
    [ "$code" = "200" ] && { log "healthy"; return 0; }
    sleep "$PT_HEALTH_INTERVAL"
  done
  log "not healthy after ${PT_HEALTH_TIMEOUT}s (last status: ${code:-no response})"
  return 1
}
