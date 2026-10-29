-- The application's database login (docs/ARCHITECTURE.md, "Tamper-evident audit").
--
-- Migrations run as the OWNER login (it owns the tables and the audit functions);
-- the application connects as this role, which owns nothing. Run this as the owner
-- after every `prisma migrate deploy`: a migration can add tables or audit
-- functions the role has no privileges on yet.
--
--   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -v app_role=credaflow_app \
--        [-v app_password=...] -f app-role.sql
--
-- With app_password the role is created (or its password reset); without it the
-- role must already exist. The role gets the usual table privileges, then
-- audit_grant_runtime() takes the audit evidence tables back: the role ends with
-- INSERT and SELECT on "AuditLog" and EXECUTE on the audit functions, and
-- nothing on the links, checkpoints, redactions or SIEM outbox. It refuses a
-- superuser, a BYPASSRLS role and a role that owns tables.
\set ON_ERROR_STOP on

\if :{?app_password}
  SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'app_role', :'app_password')
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec
  SELECT format('ALTER ROLE %I PASSWORD %L', :'app_role', :'app_password') \gexec
\endif

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_role') \gexec

SELECT audit_grant_runtime(:'app_role');
