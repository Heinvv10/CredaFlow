-- AuditLog became append-only in 20261029100000_audit_tamper_evident: its only
-- UPDATE is the restricted audit_redactor nulling documented personal data.
-- These legacy message-evidence guards validate new audit claims. Running them
-- again during redaction both re-reads Message without that role's privilege and
-- may reconstruct newValue after it was deliberately erased.
--
-- Both functions act only on rows whose entity is 'Message', so they now fire
-- only for those rows (WHEN clause). Without it, audit_log_redact()'s own
-- AUDIT_ROW_REDACTED insert (entity 'AuditLog', running as audit_redactor) still
-- entered guard_legacy_placeholder_audit(). Its IF is one SQL expression with an
-- EXISTS on "Message": a custom plan folds that away, but once the session's
-- plan cache switches to a generic plan the subquery stays in the plan and
-- Postgres checks SELECT on "Message" at executor start, which audit_redactor
-- does not have ("permission denied for table Message"). Whether that happens
-- depended on plan-cache history and table statistics, so it failed in a long
-- shared-database CI shard and passed on a fresh database.
DROP TRIGGER "AuditLog_legacy_placeholder_guard" ON "AuditLog";
CREATE TRIGGER "AuditLog_legacy_placeholder_guard" BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW."entity" = 'Message') EXECUTE FUNCTION guard_legacy_placeholder_audit();

DROP TRIGGER "AuditLog_truthful_dry_run" ON "AuditLog";
CREATE TRIGGER "AuditLog_truthful_dry_run" BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW."entity" = 'Message') EXECUTE FUNCTION truthful_dry_run_audit();
