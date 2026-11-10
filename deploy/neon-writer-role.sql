-- Writer role for scheduled ingestion (refresh:data, ingest:* --apply). Run ONCE per branch that
-- the ingestion host writes to (e.g. the STAGING branch first), in the Neon SQL Editor as the
-- database owner (neondb_owner), after migrations are applied. Requires explicit approval (it
-- creates a role). Nothing here changes data.
--
-- Create the role with SQL, not the Neon Console: Console-created roles are members of
-- neon_superuser, which can do far more than ingestion needs (create tables, roles, …). Replace the
-- password in the editor; do not save it anywhere else (put it only in the ingestion host's
-- /etc/prospect-terminal-ingest/env).
--
-- What ingestion needs, and nothing more:
--   SELECT, INSERT, UPDATE, DELETE on the app's tables (the writer deletes rows when a source
--   corrects them); no TRUNCATE, no DDL (migrations are run by the owner), no sequences (UUID
--   keys), no other schema. Advisory locks and pg_stat_activity for its own sessions need no grant.

CREATE ROLE pt_ingest WITH LOGIN PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';

GRANT CONNECT ON DATABASE neondb TO pt_ingest;
GRANT USAGE ON SCHEMA public TO pt_ingest;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pt_ingest;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pt_ingest;

-- Defence in depth: bounded sessions; an apply transaction is short (the sink also sets its own
-- per-transaction limits), a whole capture never needs minutes on one statement.
ALTER ROLE pt_ingest SET statement_timeout = '5min';
ALTER ROLE pt_ingest SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE pt_ingest CONNECTION LIMIT 10;

-- Verify (all must be as commented); `npm run -s check:db-roles` checks the same and more from the
-- ingestion host, without changing anything.
SELECT rolsuper, rolcreaterole, rolcreatedb,                               -- f, f, f
       pg_has_role('pt_ingest', 'neon_superuser', 'member') AS neon_super  -- f
FROM pg_roles WHERE rolname = 'pt_ingest';
SELECT count(*) FILTER (WHERE has_table_privilege('pt_ingest', c.oid, 'INSERT')
                          AND has_table_privilege('pt_ingest', c.oid, 'DELETE')) AS can_write, -- = number of tables
       count(*) FILTER (WHERE has_table_privilege('pt_ingest', c.oid, 'TRUNCATE')) AS can_truncate, -- 0
       has_schema_privilege('pt_ingest', 'public', 'CREATE') AS can_create,                   -- f
       count(*) AS tables
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r';
