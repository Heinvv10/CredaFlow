import { defineAuditActions } from "../define"

export default defineAuditActions({
  // An approved loan change applied (lib/loan-changes/apply.ts).
  LOAN_CHANGE_APPLIED: "LOAN_CHANGE_APPLIED",
  // A rejected or withdrawn change cancelled the application its approval chain ran on.
  LOAN_CHANGE_APPLICATION_CLOSED: "LOAN_CHANGE_APPLICATION_CLOSED",
})
