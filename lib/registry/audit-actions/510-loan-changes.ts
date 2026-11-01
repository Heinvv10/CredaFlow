import { defineAuditActions } from "../define"

export default defineAuditActions({
  // An approved loan change applied (lib/loan-changes/apply.ts).
  LOAN_CHANGE_APPLIED: "LOAN_CHANGE_APPLIED",
  // A top-up, refinance or consolidation opened the application its approval chain runs on.
  LOAN_CHANGE_APPLICATION_OPENED: "LOAN_CHANGE_APPLICATION_OPENED",
  // A rejected or withdrawn change cancelled the application its approval chain ran on.
  LOAN_CHANGE_APPLICATION_CLOSED: "LOAN_CHANGE_APPLICATION_CLOSED",
})
