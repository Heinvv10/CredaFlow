-- AuditLog became append-only in 20261029100000_audit_tamper_evident: its only
-- UPDATE is the restricted audit_redactor nulling documented personal data.
-- These legacy message-evidence guards validate new audit claims. Running them
-- again during redaction both re-reads Message without that role's privilege and
-- may reconstruct newValue after it was deliberately erased.
DROP TRIGGER "AuditLog_legacy_placeholder_guard" ON "AuditLog";
CREATE TRIGGER "AuditLog_legacy_placeholder_guard" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION guard_legacy_placeholder_audit();

DROP TRIGGER "AuditLog_truthful_dry_run" ON "AuditLog";
CREATE TRIGGER "AuditLog_truthful_dry_run" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION truthful_dry_run_audit();
