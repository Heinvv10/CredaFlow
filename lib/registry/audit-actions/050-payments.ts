import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Payments
  PAYMENT_RECORDED: "PAYMENT_RECORDED",
  PAYMENT_REVERSED: "PAYMENT_REVERSED",
  PAYMENT_ALLOCATED: "PAYMENT_ALLOCATED",
  PAYMENT_LEDGER_RECONCILED: "PAYMENT_LEDGER_RECONCILED",
  PAYMENT_REFUND_RECORDED: "PAYMENT_REFUND_RECORDED",
  // Part of a receipt nothing on the loan can absorb, split off as refund-due (lib/loan/refund-excess.ts)
  PAYMENT_REFUND_DUE_SPLIT: "PAYMENT_REFUND_DUE_SPLIT",
  // Waived cents no longer needed once charges are removed; a waiver is never refunded
  PAYMENT_WAIVER_RETIRED: "PAYMENT_WAIVER_RETIRED",
  // Default interest / post-default charges re-derived (lib/loan/charges-sync.ts)
  LOAN_CHARGES_SYNCED: "LOAN_CHARGES_SYNCED",
  // Schedule paidAt left as it was: the receipts do not describe the schedule (lib/loan/schedule-paid-at.ts)
  SCHEDULE_PAIDAT_RESTAMP_SKIPPED: "SCHEDULE_PAIDAT_RESTAMP_SKIPPED",
  LOAN_SERVICE_FEE_RECORDED: "LOAN_SERVICE_FEE_RECORDED",
  DEFAULT_CHARGES_STARTED: "DEFAULT_CHARGES_STARTED",
  DEFAULT_CHARGES_CHANGE_ACCEPTED: "DEFAULT_CHARGES_CHANGE_ACCEPTED",
  SECTION_129_CHARGE_STAMPED: "SECTION_129_CHARGE_STAMPED",
  DEFAULT_CHARGES_DISABLED: "DEFAULT_CHARGES_DISABLED",
  DEFAULT_CHARGES_EXEMPTION_CHANGED: "DEFAULT_CHARGES_EXEMPTION_CHANGED",
  // Sub-R1 residue closed by a non-cash WAIVER Payment (lib/loan/small-balance-waiver.ts)
  SMALL_BALANCE_WAIVED: "SMALL_BALANCE_WAIVED",
})
