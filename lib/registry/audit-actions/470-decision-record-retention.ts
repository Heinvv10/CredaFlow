import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Credit decision log retention (lib/learning-loop/retention/, DESIGN.md §2.7).
  // The lender's period changed (SUPER_ADMIN, TOTP-verified session); numbers only.
  DECISION_RECORD_RETENTION_UPDATED: "DECISION_RECORD_RETENTION_UPDATED",
  // The nightly job pseudonymised a tenant's aged records: a count, never a subject.
  DECISION_RECORDS_PSEUDONYMISED: "DECISION_RECORDS_PSEUDONYMISED",
} as const)
