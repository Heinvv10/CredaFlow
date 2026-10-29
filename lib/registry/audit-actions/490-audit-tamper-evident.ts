import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Tamper-evident audit and SIEM forwarding (lib/audit/.claude.md).
  // The lender's audit retention or SIEM target changed; secrets never enter the row.
  AUDIT_POLICY_UPDATED: "AUDIT_POLICY_UPDATED",
  // The daily hash-chain walk: a pass, and a break (with where it first failed).
  AUDIT_CHAIN_VERIFIED: "AUDIT_CHAIN_VERIFIED",
  AUDIT_CHAIN_BROKEN: "AUDIT_CHAIN_BROKEN",
  // A documented removal of personal data from an audit row (audit_log_redact, written by the function itself).
  AUDIT_ROW_REDACTED: "AUDIT_ROW_REDACTED",
  // The unsent SIEM queue of a lender that stopped forwarding was dropped (written by audit_outbox_prune_unsent, with the count).
  AUDIT_SIEM_QUEUE_PRUNED: "AUDIT_SIEM_QUEUE_PRUNED",
  // A lender's test event to its SIEM (the result class only), by whom and whether it got through.
  AUDIT_SIEM_TEST_SENT: "AUDIT_SIEM_TEST_SENT",
  // Security events (lib/audit/security-events.ts): sign-ins, TOTP failures, refused permissions.
  SECURITY_LOGIN_SUCCEEDED: "SECURITY_LOGIN_SUCCEEDED",
  SECURITY_LOGIN_FAILED: "SECURITY_LOGIN_FAILED",
  SECURITY_TOTP_FAILED: "SECURITY_TOTP_FAILED",
  SECURITY_PERMISSION_DENIED: "SECURITY_PERMISSION_DENIED",
} as const)
