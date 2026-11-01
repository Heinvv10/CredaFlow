import { defineAuditActions } from "../define"

export default defineAuditActions({
  // An approved loan change applied (lib/loan-changes/apply.ts).
  LOAN_CHANGE_APPLIED: "LOAN_CHANGE_APPLIED",
})
