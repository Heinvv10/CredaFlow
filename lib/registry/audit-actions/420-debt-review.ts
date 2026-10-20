import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Debt review (NCA s.86). A debt counsellor's notice stops automated dunning on
  // the loan (lib/collections/dunning-holds.ts); recording and clearing it are
  // staff decisions, each with the values it set or removed (clearing: a reason).
  DEBT_REVIEW_NOTICE_RECORDED: "DEBT_REVIEW_NOTICE_RECORDED",
  DEBT_REVIEW_NOTICE_CLEARED: "DEBT_REVIEW_NOTICE_CLEARED",
})
