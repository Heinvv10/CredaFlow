import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Credit checks (lib/credit-checks): flags raised/superseded by a recompute,
  // and an officer clearing one with a reason.
  CREDIT_CHECKS_RECOMPUTED: "CREDIT_CHECKS_RECOMPUTED",
  CREDIT_CHECK_FLAG_CLEARED: "CREDIT_CHECK_FLAG_CLEARED",
  // A credit officer downloaded an application's read statements as a workbook
  // (app/api/applications/[id]/statement-export); each statement is also in DocumentAccessLog.
  STATEMENT_EXPORTED: "STATEMENT_EXPORTED",
  STATEMENT_READ_RETRIED: "STATEMENT_READ_RETRIED",
  PRODUCT_PRICING_UPDATED: "PRODUCT_PRICING_UPDATED",
})
