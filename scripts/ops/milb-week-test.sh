#!/usr/bin/env bash
# One-week Triple-A test import (Sep 15–21, 2026) against the Neon TEST branch only.
# Follows docs/MILB-NEON-RUNBOOK.md steps 1–4. Every stage has a hard stop.
#
#   bash scripts/ops/milb-week-test.sh
#
# Writes exactly two ingestion applies (the week, then a games-only replay of the same week) and
# only after: the endpoint matches EXPECTED_ENDPOINT, migrations are present, the saved dry run is
# clean, the live notices are of known informational kinds, and you type APPLY.
# The connection string is read from INGESTION_DATABASE_URL or a hidden prompt; it is never
# printed, logged or written to disk. Outputs go to ~/pt-runs (mode 700).
set -euo pipefail
set +x

EXPECTED_ENDPOINT="ep-lucky-sea-akc835g5"
SEASON=2026
LEVEL=aaa
FROM=2026-09-15
TO=2026-09-21
EXPECTED_MIGRATIONS=4
# Informational notice kinds that are harmless for an affiliated level (docs/MILB-INGESTION.md).
HARMLESS_NOTICES="reconciled-reschedule outside-scope discovery-fallback reused-boxscores"

cd "$(dirname "$0")/../.."
OUT="$HOME/pt-runs"
mkdir -p "$OUT"
chmod 700 "$OUT"
step() { printf '\n== %s\n' "$*" >&2; }
stop() { printf '\nSTOP: %s\nNothing further was run.\n' "$*" >&2; exit 1; }
# JSON helper: jv <file> <js expression over j>  (tolerates an npm banner before the JSON)
jv() {
  node -e '
    const fs = require("fs");
    const s = fs.readFileSync(process.argv[1], "utf8");
    const j = JSON.parse(s.slice(s.search(/^[\[{]/m)));
    const v = eval(process.argv[2]);
    console.log(typeof v === "string" ? v : JSON.stringify(v));
  ' "$1" "$2"
}
q() { psql "$INGESTION_DATABASE_URL" -X -A -t -q -v ON_ERROR_STOP=1 -c "$1"; }

command -v psql >/dev/null || stop "psql not found (brew install libpq && brew link --force libpq)"
command -v node >/dev/null || stop "node not found"
[ -f package.json ] && grep -q '"ingest:milb"' package.json || stop "run from the prospect-terminal checkout"

step "1. Credential"
if [ -z "${INGESTION_DATABASE_URL:-}" ]; then
  printf 'Paste the milb-test-2026 connection string (input hidden): ' >&2
  IFS= read -rs INGESTION_DATABASE_URL
  printf '\n' >&2
  export INGESTION_DATABASE_URL
fi
[ -n "$INGESTION_DATABASE_URL" ] || stop "no connection string"
unset DATABASE_URL
echo "INGESTION_DATABASE_URL: set (not shown)" >&2

step "2. Endpoint check"
ENDPOINT=$(node -e '
  const u = new URL(process.env.INGESTION_DATABASE_URL);
  console.log(u.hostname.split(".")[0].replace(/-pooler$/, ""));')
SSLMODE=$(node -e 'console.log(new URL(process.env.INGESTION_DATABASE_URL).searchParams.get("sslmode") ?? "")')
echo "endpoint: $ENDPOINT  sslmode: ${SSLMODE:-<none>}" >&2
[ "$ENDPOINT" = "$EXPECTED_ENDPOINT" ] || stop "endpoint $ENDPOINT is not the test branch $EXPECTED_ENDPOINT"
case "$SSLMODE" in require | verify-full | verify-ca) ;; *) stop "connection string must set sslmode=require" ;; esac

step "3. Read-only database and migration checks"
q "select current_database(), current_user" >&2
MIGRATIONS=$(q "select count(*) from drizzle.__drizzle_migrations")
echo "applied migrations: $MIGRATIONS" >&2
[ "$MIGRATIONS" = "$EXPECTED_MIGRATIONS" ] || stop "expected $EXPECTED_MIGRATIONS migrations, found $MIGRATIONS"
psql "$INGESTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/sql/milb-integrity-checks.sql > "$OUT/10-before-apply.txt"
echo "baseline: $OUT/10-before-apply.txt" >&2

step "4. Saved dry run"
PREVIEW="$OUT/01-aaa-week-preview.json"
[ -f "$PREVIEW" ] || stop "missing $PREVIEW"
echo "$(jv "$PREVIEW" '({status: j.status, apply: j.apply, range: j.range, totals: j.totals})')" >&2
[ "$(jv "$PREVIEW" 'j.apply')" = "false" ] || stop "saved preview is not a dry run"
[ "$(jv "$PREVIEW" 'j.status')" = "ok" ] || stop "saved preview status is not ok"
[ "$(jv "$PREVIEW" 'j.totals.issues')" = "0" ] || stop "saved preview has issues"
[ "$(jv "$PREVIEW" 'String(j.levels)')" = "$LEVEL" ] || stop "saved preview is not $LEVEL only"
PREVIEW_NOTICES=$(jv "$PREVIEW" 'j.totals.notices')

step "5. Notice reasons (live Stats API, no database)"
env -u INGESTION_DATABASE_URL node --import tsx scripts/ops/milb-notices.ts "$LEVEL" "$FROM" "$TO" \
  > "$OUT/05-notices.json" 2> "$OUT/05-notices.log" || stop "notice inspection failed (see $OUT/05-notices.log)"
jv "$OUT/05-notices.json" 'j.flatMap(p => p.notices.map(n => `${p.phase}: ${n.reason} ${n.recordKey} — ${n.message}`)).join("\n") || "(no notices)"' >&2
LIVE_ISSUES=$(jv "$OUT/05-notices.json" 'j.reduce((a, p) => a + p.issues, 0)')
[ "$LIVE_ISSUES" = "0" ] || stop "live capture now has $LIVE_ISSUES issues"
for reason in $(jv "$OUT/05-notices.json" '[...new Set(j.flatMap(p => p.notices.map(n => n.reason)))].join(" ")'); do
  case " $HARMLESS_NOTICES " in *" $reason "*) ;; *) stop "notice '$reason' needs review before any write" ;; esac
done
LIVE_NOTICES=$(jv "$OUT/05-notices.json" 'j.reduce((a, p) => a + p.notices.length, 0)')
echo "notices: $LIVE_NOTICES live, $PREVIEW_NOTICES in the saved preview — all of known informational kinds" >&2

step "6. Apply Triple-A $FROM..$TO to $ENDPOINT"
printf 'Type APPLY to write this one week to %s: ' "$ENDPOINT" >&2
read -r CONFIRM
[ "$CONFIRM" = "APPLY" ] || stop "not confirmed"
COUNTS_SQL="select json_build_object(
  'games', (select count(*) from games), 'players', (select count(*) from players),
  'teams', (select count(*) from teams), 'organizations', (select count(*) from organizations),
  'batting', (select count(*) from player_batting_games), 'pitching', (select count(*) from player_pitching_games),
  'identities', (select count(*) from source_identities), 'rosterObs', (select count(*) from source_roster_observations),
  'issues', (select count(*) from ingestion_issues))"
q "$COUNTS_SQL" > "$OUT/06-counts-before.json"
npm run -s ingest:milb -- --season=$SEASON --level=$LEVEL --from=$FROM --to=$TO --apply \
  > "$OUT/02-aaa-week-apply.json" 2> "$OUT/02-aaa-week-apply.log" || stop "apply failed (see $OUT/02-aaa-week-apply.log)"
echo "$(jv "$OUT/02-aaa-week-apply.json" '({status: j.status, apply: j.apply, totals: j.totals, resumeFrom: j.resumeFrom ?? null})')" >&2
[ "$(jv "$OUT/02-aaa-week-apply.json" 'j.status')" = "ok" ] || stop "apply status is not ok (no replay run)"
[ "$(jv "$OUT/02-aaa-week-apply.json" 'j.resumeFrom ?? ""')" = "" ] || stop "apply left a resumeFrom"
q "$COUNTS_SQL" > "$OUT/06-counts-after-apply.json"

step "7. Integrity and statistics checks"
psql "$INGESTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/sql/milb-integrity-checks.sql > "$OUT/03-after-apply.txt"
AAA_LEAGUES="select lv.league_id from source_identities si join levels lv on lv.id = si.internal_id
  where si.provider = 'mlb-stats-api' and si.entity_kind = 'level' and si.external_id like 'milb:11:%'"
WEEK="g.league_id in ($AAA_LEAGUES) and coalesce(g.official_date, g.starts_at::date) between '$FROM' and '$TO'"
CHECKS_SQL="select json_build_object(
  'games', (select count(*) from games g where $WEEK),
  'completeGames', (select count(*) from games g where $WEEK and g.status = 'final' and g.boxscore_complete),
  'battingLines', (select count(*) from player_batting_games b join games g on g.id = b.game_id where $WEEK),
  'pitchingLines', (select count(*) from player_pitching_games p join games g on g.id = p.game_id where $WEEK),
  'aaaTeamsInWeek', (select count(distinct u.team) from games g, unnest(array[g.home_team_id, g.away_team_id]) as u(team) where $WEEK),
  'dupIdentities', (select count(*) from (select 1 from source_identities group by provider, entity_kind, external_id having count(*) > 1) x),
  'dupBatting', (select count(*) from (select 1 from player_batting_games group by player_id, game_id having count(*) > 1) x),
  'dupPitching', (select count(*) from (select 1 from player_pitching_games group by player_id, game_id having count(*) > 1) x),
  'completeMissingSide', (select count(*) from games g where $WEEK and g.status = 'final' and g.boxscore_complete and (
      not exists (select 1 from player_batting_games b where b.game_id = g.id and b.team_id = g.home_team_id)
   or not exists (select 1 from player_batting_games b where b.game_id = g.id and b.team_id = g.away_team_id))),
  'lineTeamNotInGame', (select count(*) from player_batting_games b join games g on g.id = b.game_id
      where $WEEK and b.team_id not in (g.home_team_id, g.away_team_id)),
  'implausibleLines', (select count(*) from player_batting_games b join games g on g.id = b.game_id
      where $WEEK and (b.at_bats > b.plate_appearances or b.hits > b.at_bats or b.home_runs > b.hits)),
  'runsVsScoreMismatch', (select count(*) from games g where $WEEK and g.status = 'final' and g.boxscore_complete and (
      (select sum(b.runs) from player_batting_games b where b.game_id = g.id and b.team_id = g.home_team_id) <> g.home_score
   or (select sum(b.runs) from player_batting_games b where b.game_id = g.id and b.team_id = g.away_team_id) <> g.away_score)),
  'runsAllowedVsScoreMismatch', (select count(*) from games g where $WEEK and g.status = 'final' and g.boxscore_complete and (
      (select sum(p.runs) from player_pitching_games p where p.game_id = g.id and p.team_id = g.home_team_id) <> g.away_score
   or (select sum(p.runs) from player_pitching_games p where p.game_id = g.id and p.team_id = g.away_team_id) <> g.home_score)))"
q "$CHECKS_SQL" > "$OUT/07-checks.json"
jv "$OUT/07-checks.json" 'j' >&2
for key in dupIdentities dupBatting dupPitching completeMissingSide lineTeamNotInGame implausibleLines; do
  [ "$(jv "$OUT/07-checks.json" "j.$key")" = "0" ] || stop "integrity check $key failed"
done
[ "$(jv "$OUT/07-checks.json" 'j.completeGames')" -gt 0 ] || stop "no complete Triple-A games imported for the week"
# The week's three busiest Triple-A hitters, for a manual MiLB.com spot check (names only, no IDs).
q "select p.name || ': ' || count(*) || ' G, ' || sum(b.plate_appearances) || ' PA, ' || sum(b.hits) || ' H, ' || sum(b.home_runs) || ' HR'
   from player_batting_games b join games g on g.id = b.game_id join players p on p.id = b.player_id
   where $WEEK group by p.name order by sum(b.plate_appearances) desc, p.name limit 3" > "$OUT/07-spot-check.txt"
cat "$OUT/07-spot-check.txt" >&2

step "8. Idempotency: games-only replay of the same week"
npm run -s ingest:milb -- --season=$SEASON --level=$LEVEL --from=$FROM --to=$TO --games-only --apply \
  > "$OUT/04-aaa-week-replay.json" 2> "$OUT/04-aaa-week-replay.log" || stop "replay failed (see $OUT/04-aaa-week-replay.log)"
q "$COUNTS_SQL" > "$OUT/06-counts-after-replay.json"
echo "$(jv "$OUT/04-aaa-week-replay.json" '({status: j.status, totals: j.totals})')" >&2
[ "$(jv "$OUT/04-aaa-week-replay.json" 'j.status')" = "ok" ] || stop "replay status is not ok"
[ "$(jv "$OUT/04-aaa-week-replay.json" 'j.totals.changed')" = "0" ] || stop "replay changed rows (not idempotent)"
cmp -s "$OUT/06-counts-after-apply.json" "$OUT/06-counts-after-replay.json" || stop "row counts changed on replay"

step "9. Summary (safe to share)"
node -e '
  const fs = require("fs"), d = process.argv[1];
  const read = (f) => { const s = fs.readFileSync(`${d}/${f}`, "utf8"); return JSON.parse(s.slice(s.search(/^[\[{]/m))); };
  const a = read("02-aaa-week-apply.json"), r = read("04-aaa-week-replay.json");
  const summary = {
    endpoint: process.argv[2],
    apply: { status: a.status, totals: a.totals },
    replay: { status: r.status, totals: r.totals },
    countsBefore: read("06-counts-before.json"),
    countsAfterApply: read("06-counts-after-apply.json"),
    countsAfterReplay: read("06-counts-after-replay.json"),
    checks: read("07-checks.json"),
    notices: read("05-notices.json").flatMap((p) => p.notices.map((n) => `${p.phase}: ${n.reason} ${n.recordKey} — ${n.message}`)),
  };
  fs.writeFileSync(`${d}/09-summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
' "$OUT" "$ENDPOINT"
echo "PASS — summary saved to $OUT/09-summary.json" >&2
