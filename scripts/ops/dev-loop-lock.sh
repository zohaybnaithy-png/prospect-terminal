#!/bin/sh
# Single-runner lock and state for the scheduled development loop (docs/AUTONOMOUS-WORKFLOW.md §7).
#   scripts/ops/dev-loop-lock.sh acquire <run-id>   exit 0 = lock taken; 3 = another run holds it
#   scripts/ops/dev-loop-lock.sh release <run-id>   removes the lock only if <run-id> holds it
#   scripts/ops/dev-loop-lock.sh status             prints lock holder and age, state file
# mkdir is atomic, so two runs cannot both take the lock. A lock older than STALE_SECONDS (default 8 h)
# is from a crashed run and is replaced. State lives outside the repo so it survives worktree cleanup.
set -eu
DIR="${DEV_LOOP_DIR:-$HOME/.claude/prospect-terminal-dev-loop}"
LOCK="$DIR/lock"
STALE_SECONDS="${STALE_SECONDS:-28800}"
mkdir -p "$DIR/reports"

now() { date +%s; }
holder() { cat "$LOCK/holder" 2>/dev/null || echo "?"; }
age() { echo $(( $(now) - $(cat "$LOCK/since" 2>/dev/null || echo 0) )); }

case "${1:-}" in
  acquire)
    id="${2:?run id required}"
    if mkdir "$LOCK" 2>/dev/null; then
      echo "$id" > "$LOCK/holder"; now > "$LOCK/since"; echo "acquired $id"; exit 0
    fi
    a=$(age)
    if [ "$a" -gt "$STALE_SECONDS" ]; then
      echo "replacing stale lock held by $(holder) for ${a}s" >&2
      rm -rf "$LOCK"
      mkdir "$LOCK" && echo "$id" > "$LOCK/holder" && now > "$LOCK/since" && echo "acquired $id" && exit 0
    fi
    echo "held by $(holder) for ${a}s" >&2; exit 3 ;;
  release)
    id="${2:?run id required}"
    if [ "$(holder)" = "$id" ]; then rm -rf "$LOCK"; echo "released $id"; else echo "not held by $id (holder: $(holder))" >&2; exit 4; fi ;;
  status)
    if [ -d "$LOCK" ]; then echo "locked by $(holder) for $(age)s"; else echo "unlocked"; fi
    [ -f "$DIR/state.json" ] && cat "$DIR/state.json" || echo "no state.json" ;;
  *) echo "usage: $0 acquire|release <run-id> | status" >&2; exit 2 ;;
esac
