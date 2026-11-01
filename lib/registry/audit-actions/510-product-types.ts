import { defineAuditActions } from "../define"

export default defineAuditActions({
  // A variable-rate loan moved to a new reference value: terms appended, schedule regenerated (lib/product-engine/reprice-loan.ts).
  LOAN_RATE_REPRICED: "LOAN_RATE_REPRICED",
  // The salary-backed, SME or group facts of an application set (lib/product-types).
  APPLICATION_PRODUCT_FACTS_SET: "APPLICATION_PRODUCT_FACTS_SET",
  // A lending group created, or its members changed.
  BORROWER_GROUP_CREATED: "BORROWER_GROUP_CREATED",
  BORROWER_GROUP_MEMBERS_CHANGED: "BORROWER_GROUP_MEMBERS_CHANGED",
  // The month's employer deduction list exported.
  CHECK_OFF_DEDUCTIONS_EXPORTED: "CHECK_OFF_DEDUCTIONS_EXPORTED",
})
