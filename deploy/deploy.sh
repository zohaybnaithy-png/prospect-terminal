#!/usr/bin/env bash
# Builds a release from a Git branch, tag or commit, switches to it, and keeps it only if the
# health check passes; otherwise switches back to the previous release automatically.
# Exit 0: deployed; 1: nothing changed (bad ref, failed build) or rolled back to the previous
# release; 2: nothing healthy is being served (first deploy failed, or the rollback is unhealthy).
#
#   deploy/deploy.sh            # deploy origin/main
#   deploy/deploy.sh v1.0.0     # a tag, branch or commit
#
# Run on the server as the `prospect` user, from any directory. Builds next to the running
# release (the site keeps serving), so a failed install or build changes nothing. Needs no
# database access: the build does not read the database. See docs/DEPLOYMENT-RUNBOOK.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/common.sh
. "$here/common.sh"

ref="${1:-main}"
case "$ref" in -*|*..*|*' '*) die "invalid ref: $ref";; esac
take_lock

log "fetching $ref"
git -C "$PT_REPO" fetch --quiet --prune --tags origin
sha="$(git -C "$PT_REPO" rev-parse --verify --quiet "origin/$ref^{commit}" ||
       git -C "$PT_REPO" rev-parse --verify --quiet "$ref^{commit}")" || die "unknown ref: $ref"
release="$PT_RELEASES/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:7}"
mkdir -p "$PT_RELEASES"
[ -e "$release" ] && die "release already exists: $release"

mkdir -p "$PT_ROOT/logs"
build_log="$PT_ROOT/logs/$(basename "$release").log"
log "building ${sha:0:7} in $release (log: $build_log)"
mkdir "$release"
git -C "$PT_REPO" archive "$sha" | tar -x -C "$release"
printf '%s\n' "$sha" > "$release/REVISION"
if ! (
  cd "$release"
  npm ci --no-audit --no-fund
  if [ "${PT_SKIP_TESTS:-0}" != "1" ]; then npm test; fi
  npm run build
) > "$build_log" 2>&1; then
  tail -n 25 "$build_log" >&2
  rm -rf "$release"
  die "install, tests or build failed (full log: $build_log); nothing was changed"
fi

previous="$(current_release)"
valid_release "$previous" || previous=""
switch_to "$release"
restart_app
if wait_healthy; then
  record "${sha:0:7} $ref"
  # Keep the newest $PT_KEEP releases (always including the current and previous ones).
  ls -1d "$PT_RELEASES"/*/ 2>/dev/null | sed 's:/$::' | sort -r | tail -n +"$((PT_KEEP + 1))" |
    while read -r old; do
      [ "$old" = "$release" ] || [ "$old" = "$previous" ] || rm -rf "$old"
    done
  find "$PT_ROOT/logs" -name '*.log' -mtime +60 -delete 2>/dev/null || true
  log "deployed ${sha:0:7} ($ref)"
  exit 0
fi

# Move the failed release out of releases/ so rollback.sh can never pick it.
mkdir -p "$PT_ROOT/failed"
failed="$PT_ROOT/failed/$(basename "$release")"
mv "$release" "$failed"
if [ -n "$previous" ]; then
  log "rolling back to $(basename "$previous")"
  switch_to "$previous"
  restart_app
  if wait_healthy; then
    record "${sha:0:7} $ref FAILED health check; rolled back to $(basename "$previous")"
    die "deploy of ${sha:0:7} failed its health check and was rolled back to $(basename "$previous") (kept in $failed for inspection)"
  fi
  record "${sha:0:7} $ref FAILED health check; rollback to $(basename "$previous") is not healthy either"
  log "ERROR: deploy of ${sha:0:7} failed its health check, and $(basename "$previous") is not healthy after rolling back: the site is down. Check 'journalctl -u prospect-terminal -n 200'"
  exit 2
fi
# First deploy (no earlier healthy release): leave no `current` at all rather than one pointing at
# the failed build. The restart stops the failed code; systemd cannot start the app again until a
# later deploy creates `current` (that deploy clears systemd's restart limit and proceeds normally).
rm -f "$PT_CURRENT"
restart_app
record "${sha:0:7} $ref FAILED health check; no previous release, nothing is being served"
log "ERROR: deploy of ${sha:0:7} failed its health check and there is no previous release to return to: nothing is being served (kept in $failed). Check 'journalctl -u prospect-terminal -n 200', fix, and deploy again"
exit 2
