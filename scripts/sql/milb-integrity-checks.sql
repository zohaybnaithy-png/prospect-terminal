-- Read-only integrity checks for MiLB + AFL data. Safe against any database: every statement is a
-- SELECT inside a READ ONLY transaction. Run with:
--   psql "$INGESTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/sql/milb-integrity-checks.sql
-- Sections marked "expect 0 rows" must return no rows.
\set QUIET on
\pset footer off
begin transaction read only;

\echo '== 1. Target and schema'
select current_database() as database, current_user as role, version() as server;
select count(*) as applied_migrations from drizzle.__drizzle_migrations;  -- expect 4

\echo '== 2. Record counts by level (season games, complete box scores, lines, players)'
with lvl as (
  select si.internal_id as level_id,
         case split_part(si.external_id, ':', 2)
           when '11' then '1 Triple-A' when '12' then '2 Double-A'
           when '13' then '3 High-A' when '14' then '4 Single-A' end as level
  from source_identities si
  where si.provider = 'mlb-stats-api' and si.entity_kind = 'level' and si.external_id like 'milb:%'
), lg as (
  select distinct l.level, lv.league_id from lvl l join levels lv on lv.id = l.level_id
  union all
  select '5 AFL', si.internal_id from source_identities si
  where si.provider = 'mlb-stats-api' and si.entity_kind = 'league' and si.external_id = '119'
)
select lg.level,
       count(distinct g.id) as games,
       count(distinct g.id) filter (where g.status = 'final' and g.boxscore_complete) as complete,
       min(coalesce(g.official_date, g.starts_at::date)) filter (where g.boxscore_complete) as first_game,
       max(coalesce(g.official_date, g.starts_at::date)) filter (where g.boxscore_complete) as last_game,
       (select count(*) from player_batting_games b join games x on x.id = b.game_id
          where x.league_id in (select league_id from lg l2 where l2.level = lg.level)) as batting_lines,
       (select count(*) from player_pitching_games p join games x on x.id = p.game_id
          where x.league_id in (select league_id from lg l2 where l2.level = lg.level)) as pitching_lines
from lg left join games g on g.league_id = lg.league_id
group by lg.level order by lg.level;

\echo '== 3. Latest ingestion runs'
select status, count(*) as runs, max(completed_at) as last_completed
from ingestion_runs where provider = 'mlb-stats-api' group by status order by status;
select code, count(*) as issues from ingestion_issues group by code order by issues desc limit 20;

\echo '== 4. Duplicate source identities (expect 0 rows)'
select entity_kind, external_id, count(*) from source_identities
where provider = 'mlb-stats-api' group by entity_kind, external_id having count(*) > 1;

\echo '== 5. Duplicate stat lines per player and game (expect 0 rows)'
select 'batting' as kind, player_id, game_id, count(*) from player_batting_games
group by player_id, game_id having count(*) > 1
union all
select 'pitching', player_id, game_id, count(*) from player_pitching_games
group by player_id, game_id having count(*) > 1;

\echo '== 6. Complete final games missing lines for a team (expect 0 rows)'
select g.id, g.official_date from games g
where g.status = 'final' and g.boxscore_complete
  and (not exists (select 1 from player_batting_games b where b.game_id = g.id and b.team_id = g.home_team_id)
    or not exists (select 1 from player_batting_games b where b.game_id = g.id and b.team_id = g.away_team_id))
limit 20;

\echo '== 7. Stat lines whose team did not play in the game (expect 0 rows)'
select 'batting' as kind, b.game_id, b.team_id from player_batting_games b join games g on g.id = b.game_id
where b.team_id not in (g.home_team_id, g.away_team_id)
union all
select 'pitching', p.game_id, p.team_id from player_pitching_games p join games g on g.id = p.game_id
where p.team_id not in (g.home_team_id, g.away_team_id)
limit 20;

\echo '== 8. Implausible line values (expect 0 rows)'
select 'batting' as kind, b.game_id, b.player_id from player_batting_games b
where b.at_bats > b.plate_appearances or b.hits > b.at_bats or b.home_runs > b.hits
   or b.plate_appearances < 0
union all
select 'pitching', p.game_id, p.player_id from player_pitching_games p
where p.outs_recorded < 0 or p.batters_faced < 0 or p.earned_runs < 0
limit 20;

\echo '== 9. Players appearing at more than one level this season (shared identity, informational)'
select count(*) as multi_level_players from (
  select b.player_id from player_batting_games b
  join teams t on t.id = b.team_id
  left join source_identities si
    on si.internal_id = t.level_id and si.provider = 'mlb-stats-api' and si.entity_kind = 'level'
  group by b.player_id
  having count(distinct coalesce(split_part(si.external_id, ':', 2), si.external_id, 'other')) > 1
) x;

rollback;
