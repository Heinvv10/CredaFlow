import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Asset finance rates (lib/asset-finance/reprice-loan.ts,
  // app/api/asset-finance/reference-rates): a reference value recorded
  // (PENDING), approved or rejected by a second person, a recording or decision
  // refused (no authority, or the four-eyes rule), and a linked loan's pending
  // schedule re-solved on an approved value.
  REFERENCE_RATE_RECORDED: "REFERENCE_RATE_RECORDED",
  REFERENCE_RATE_DECIDED: "REFERENCE_RATE_DECIDED",
  REFERENCE_RATE_REFUSED: "REFERENCE_RATE_REFUSED",
  LOAN_REPRICED: "LOAN_REPRICED",
  LOAN_REPRICE_REFUSED: "LOAN_REPRICE_REFUSED",
})
