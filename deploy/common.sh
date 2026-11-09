# Shared settings and helpers for deploy.sh / rollback.sh (sourced, not run).
# Every value can be overridden from the environment (used by the local rehearsal test).
PT_ROOT="${PT_ROOT:-/srv/prospect-terminal}"
PT_REPO="${PT_REPO:-$PT_ROOT/repo}"
PT_RELEASES="$PT_ROOT/releases"
PT_CURRENT="$PT_ROOT/current"
PT_HEALTH_URL="${PT_HEALTH_URL:-http://127.0.0.1:3000/health}"
PT_HEALTH_TIMEOUT="${PT_HEALTH_TIMEOUT:-180}"
PT_KEEP="${PT_KEEP:-5}"
# Restart the app. On the server: a sudoers rule allows exactly this command (see the runbook).
PT_RESTART_CMD="${PT_RESTART_CMD:-sudo /usr/bin/systemctl restart prospect-terminal}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Only one deploy/rollback at a time (mkdir is atomic on every filesystem).
take_lock() {
  mkdir "$PT_ROOT/.deploy.lock" 2>/dev/null ||
    die "another deploy or rollback is running (remove $PT_ROOT/.deploy.lock only if you are sure it is not)"
  trap 'rmdir "$PT_ROOT/.deploy.lock" 2>/dev/null || true' EXIT
}

current_release() { [ -L "$PT_CURRENT" ] && readlink "$PT_CURRENT" || true; }

switch_to() { ln -sfn "$1" "$PT_CURRENT"; }

restart_app() { log "restarting the app"; $PT_RESTART_CMD; }

# Waits until the health check answers 200 (every level's data loaded). Never prints the response
# body beyond the status, which contains only level states.
wait_healthy() {
  local deadline=$(( $(date +%s) + PT_HEALTH_TIMEOUT )) code=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$PT_HEALTH_URL" || true)"
    [ "$code" = "200" ] && { log "healthy"; return 0; }
    sleep 2
  done
  log "not healthy after ${PT_HEALTH_TIMEOUT}s (last status: ${code:-no response})"
  return 1
}
