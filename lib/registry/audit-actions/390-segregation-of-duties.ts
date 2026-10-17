import { defineAuditActions } from "../define"

export default defineAuditActions({
  // The lender's segregation-of-duties setting (lib/security/segregation-of-duties.ts).
  SEGREGATION_OF_DUTIES_POLICY_UPDATED: "SEGREGATION_OF_DUTIES_POLICY_UPDATED",
  // A countersignature refused because the caller witnessed the branch signature.
  AGREEMENT_COUNTERSIGN_REFUSED: "AGREEMENT_COUNTERSIGN_REFUSED",
})
