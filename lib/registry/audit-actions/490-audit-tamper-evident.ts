import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Tamper-evident audit and SIEM forwarding (lib/audit/.claude.md).
  // The lender's audit retention or SIEM target changed; secrets never enter the row.
  AUDIT_POLICY_UPDATED: "AUDIT_POLICY_UPDATED",
  // The daily hash-chain walk: a pass, and a break (with where it first failed).
  AUDIT_CHAIN_VERIFIED: "AUDIT_CHAIN_VERIFIED",
  AUDIT_CHAIN_BROKEN: "AUDIT_CHAIN_BROKEN",
  // Security events (lib/audit/security-events.ts): sign-ins, TOTP failures, refused permissions.
  SECURITY_LOGIN_SUCCEEDED: "SECURITY_LOGIN_SUCCEEDED",
  SECURITY_LOGIN_FAILED: "SECURITY_LOGIN_FAILED",
  SECURITY_TOTP_FAILED: "SECURITY_TOTP_FAILED",
  SECURITY_PERMISSION_DENIED: "SECURITY_PERMISSION_DENIED",
} as const)
