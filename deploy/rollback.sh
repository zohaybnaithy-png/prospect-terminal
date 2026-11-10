#!/usr/bin/env bash
# Switches back to an earlier release and waits for the health check.
#
#   deploy/rollback.sh                  # the release before the current one
#   deploy/rollback.sh --list           # show releases (newest first)
#   deploy/rollback.sh 20261108T...-abc1234
#
# If the target fails its health check, the release that was running is restored and checked.
# Exit 0: target serving; 1: target unhealthy, original restored; 2: nothing healthy is serving.
#
# Run on the server as the `prospect` user. Releases are already built, so this takes only the
# restart and data warm-up (about 15 s). See docs/DEPLOYMENT-RUNBOOK.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/common.sh
. "$here/common.sh"

current="$(current_release)"
releases="$(list_releases || true)"
if [ "${1:-}" = "--list" ]; then
  while read -r r; do
    [ -n "$r" ] || continue
    printf '%s %s\n' "$([ "$r" = "$current" ] && echo '*' || echo ' ')" "$(basename "$r")"
  done <<< "$releases"
  exit 0
fi

if [ -n "${1:-}" ]; then
  case "$1" in */*|.*) die "give a release name from --list";; esac
  target="$PT_RELEASES/$1"
  [ -d "$target" ] || die "no such release: $1"
else
  # The newest release older than the current one.
  target="$(while read -r r; do [ -n "$r" ] && [[ "$r" < "$current" ]] && echo "$r"; done <<< "$releases" | head -1)"
  [ -n "$target" ] || die "no earlier release to roll back to"
fi
[ "$target" = "$current" ] && die "$(basename "$target") is already current"
[ -f "$target/.next/BUILD_ID" ] || die "$(basename "$target") has no completed build"

take_lock
log "switching from $(basename "${current:-none}") to $(basename "$target")"
switch_to "$target"
restart_app
if wait_healthy; then
  record "rollback $(basename "$target")"
  log "now serving $(basename "$target")"
  exit 0
fi

# The target is not healthy: put back the release that was running before and verify it.
if ! valid_release "$current"; then
  record "rollback $(basename "$target") FAILED health check; no earlier release to restore"
  log "ERROR: $(basename "$target") is not healthy and there was no valid release running before: nothing healthy is being served. Check 'journalctl -u prospect-terminal -n 200'"
  exit 2
fi
log "$(basename "$target") is not healthy: restoring $(basename "$current")"
switch_to "$current"
restart_app
if wait_healthy; then
  record "rollback $(basename "$target") FAILED health check; restored $(basename "$current")"
  die "rollback to $(basename "$target") failed its health check; restored $(basename "$current"), which is healthy. Check 'journalctl -u prospect-terminal -n 200'"
fi
record "rollback $(basename "$target") FAILED health check; restoring $(basename "$current") also FAILED"
log "ERROR: rollback to $(basename "$target") failed its health check, and restoring $(basename "$current") is not healthy either: the site is down. Check 'journalctl -u prospect-terminal -n 200'"
exit 2
