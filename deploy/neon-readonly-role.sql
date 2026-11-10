-- Read-only database role for the web server. Run ONCE per branch a web server reads (the STAGING
-- branch for the rehearsal, docs/NEON-STAGING.md; later the PRODUCTION branch), in the Neon SQL
-- Editor as the database owner (neondb_owner), after the data is in place. Use a different password
-- on each branch. Requires explicit approval (it creates a role). Nothing here changes data.
-- `npm run -s check:db-roles` verifies the result from the server (docs/NEON-STAGING.md).
--
-- Create the role with SQL, not the Neon Console: Console-created roles are members of
-- neon_superuser, which can write. Replace the password in the editor; do not save it anywhere
-- else (generate one, e.g. 32+ random characters, and put it only in /etc/prospect-terminal/env).

CREATE ROLE pt_web WITH LOGIN PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';

-- Read access to the app's tables, now and for tables added by future migrations.
GRANT CONNECT ON DATABASE neondb TO pt_web;
GRANT USAGE ON SCHEMA public TO pt_web;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pt_web;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT SELECT ON TABLES TO pt_web;

-- Defence in depth: every session is read-only and bounded, even if a grant is ever widened.
ALTER ROLE pt_web SET default_transaction_read_only = on;
ALTER ROLE pt_web SET statement_timeout = '30s';
ALTER ROLE pt_web SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE pt_web CONNECTION LIMIT 20;

-- Verify (all must be as commented):
SELECT rolsuper, rolcreaterole, rolcreatedb,                            -- f, f, f
       pg_has_role('pt_web', 'neon_superuser', 'member') AS neon_super  -- f
FROM pg_roles WHERE rolname = 'pt_web';
SELECT count(*) FILTER (WHERE has_table_privilege('pt_web', c.oid, 'SELECT')) AS can_select,   -- = number of tables
       count(*) FILTER (WHERE has_table_privilege('pt_web', c.oid, 'INSERT')
                           OR has_table_privilege('pt_web', c.oid, 'UPDATE')
                           OR has_table_privilege('pt_web', c.oid, 'DELETE')
                           OR has_table_privilege('pt_web', c.oid, 'TRUNCATE')) AS can_write, -- 0
       count(*) AS tables
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r';
