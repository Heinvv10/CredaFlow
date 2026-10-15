import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Breach log (the POPIA security-compromise register). The row keeps no
  // history of its own, so an edit's old values exist only in the audit row.
  BREACH_LOG_CREATED: "BREACH_LOG_CREATED",
  BREACH_LOG_UPDATED: "BREACH_LOG_UPDATED",
})
