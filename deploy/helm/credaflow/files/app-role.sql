-- The application's database logins (docs/ARCHITECTURE.md, "Tamper-evident audit").
--
-- Migrations run as the OWNER login (it owns the tables and the audit functions); the application
-- connects as logins that own nothing. Run this as the owner after every `prisma migrate deploy`:
-- a migration can add tables or audit functions a login has no privileges on yet.
--
-- The values come in as psql variables, set by \set lines the caller pipes in front of this file
-- on STDIN (never on a command line, where a password would show in the process list):
--   \set app_role 'credaflow_app'          the WEB login (or the one login, see worker_role)
--   \set app_password '...'                optional: create the role / reset its password
--   \set worker_role 'credaflow_worker'    optional: a separate WORKER login (chainer, verifier, SIEM delivery)
--   \set worker_password '...'             optional, as app_password
-- Passwords are alphanumeric (quoted into SQL below); the role must exist if no password is given.
--
-- Each role gets the usual table privileges, then audit_grant_web / audit_grant_worker /
-- audit_grant_runtime take the audit tables, their sequences and the audit functions back or
-- hand them out by kind. A web login ends with INSERT and SELECT on "AuditLog", SELECT on
-- "AuditPolicy", audit_policy_save and audit_chain_status; a worker login with the chainer,
-- verifier and outbox functions; with no worker_role, one login holds both (weaker: the web process
-- then holds the worker's functions). The grants refuse a superuser, BYPASSRLS, CREATEROLE,
-- CREATEDB, a role holding CREATE on public, a table owner and a MEMBER of one.
\set ON_ERROR_STOP on

\if :{?app_password}
  SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'app_role', :'app_password')
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec
  SELECT format('ALTER ROLE %I PASSWORD %L', :'app_role', :'app_password') \gexec
\endif
\if :{?worker_role}
  \if :{?worker_password}
    SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'worker_role', :'worker_password')
      WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'worker_role') \gexec
    SELECT format('ALTER ROLE %I PASSWORD %L', :'worker_role', :'worker_password') \gexec
  \endif
\endif

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_role') \gexec

\if :{?worker_role}
  SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'worker_role') \gexec
  SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'worker_role') \gexec
  SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'worker_role') \gexec
  SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'worker_role') \gexec
  SELECT audit_grant_web(:'app_role');
  SELECT audit_grant_worker(:'worker_role');
\else
  SELECT audit_grant_runtime(:'app_role');
\endif
