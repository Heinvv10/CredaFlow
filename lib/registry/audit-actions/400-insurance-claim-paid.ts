import { defineAuditActions } from "../define"

export default defineAuditActions({
  // The insurer paid an APPROVED claim (PATCH /api/insurance/claims/[id],
  // action "mark_paid"); the only way a claim becomes PAID.
  INSURANCE_CLAIM_PAID:                   "INSURANCE_CLAIM_PAID",
})
