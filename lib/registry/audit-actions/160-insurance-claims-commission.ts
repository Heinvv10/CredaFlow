import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Insurance claim outcomes (money-committing state changes).
  INSURANCE_CLAIM_APPROVED:               "INSURANCE_CLAIM_APPROVED",
  INSURANCE_CLAIM_REJECTED:               "INSURANCE_CLAIM_REJECTED",
  INSURANCE_CLAIM_UPDATED:                "INSURANCE_CLAIM_UPDATED",
  // The submission that OPENS the claim. Its outcomes were audited above while
  // the event starting them was not, which left an approval in the log with no
  // recorded beginning.
  INSURANCE_CLAIM_SUBMITTED:              "INSURANCE_CLAIM_SUBMITTED",

  // Advisor commission lifecycle. Every one of these moves money or reverses
  // it: APPROVED clears a commission for payment, PAID asserts it left the
  // business, and CLAWED_BACK reverses it on a reason a human typed. The
  // clawback reason is kept in the audit row because it is the only record of
  // WHY the reversal was justified.
  INSURANCE_COMMISSIONS_CALCULATED:       "INSURANCE_COMMISSIONS_CALCULATED",
  INSURANCE_COMMISSION_APPROVED:          "INSURANCE_COMMISSION_APPROVED",
  INSURANCE_COMMISSION_PAID:              "INSURANCE_COMMISSION_PAID",
  INSURANCE_COMMISSION_CLAWED_BACK:       "INSURANCE_COMMISSION_CLAWED_BACK",

  // Who gets paid out on a death claim. The audited value deliberately omits
  // the beneficiary's idNumber and dateOfBirth: the audit trail exists to prove
  // who changed what, not to copy POPIA identifiers into a second store with a
  // different retention.
  INSURANCE_BENEFICIARY_ADDED:            "INSURANCE_BENEFICIARY_ADDED",
  INSURANCE_BENEFICIARY_REMOVED:          "INSURANCE_BENEFICIARY_REMOVED",
})
