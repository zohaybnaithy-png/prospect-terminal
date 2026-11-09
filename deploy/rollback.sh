#!/usr/bin/env bash
# Switches back to an earlier release and waits for the health check.
#
#   deploy/rollback.sh                  # the release before the current one
#   deploy/rollback.sh --list           # show releases (newest first)
#   deploy/rollback.sh 20261108T...-abc1234
#
# Run on the server as the `prospect` user. Releases are already built, so this takes only the
# restart and data warm-up (about 15 s). See docs/DEPLOYMENT-RUNBOOK.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/common.sh
. "$here/common.sh"

current="$(current_release)"
releases="$(ls -1d "$PT_RELEASES"/*/ 2>/dev/null | sed 's:/$::' | sort -r || true)"
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
  printf '%s rollback %s\n' "$(date -u +%FT%TZ)" "$(basename "$target")" >> "$PT_ROOT/deployments.log"
  log "now serving $(basename "$target")"
  exit 0
fi
die "$(basename "$target") is not healthy: check 'journalctl -u prospect-terminal -n 200'"
