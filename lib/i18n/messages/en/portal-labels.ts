/**
 * Status, payment-method and document-type labels shown to borrowers. The
 * English values are exactly what the portal printed before extraction
 * (formatStatusLabel, portalLoanStatusLabel, displayPaymentMethod).
 * Charge names (default interest, …) are NOT here: they stay English so they
 * read the same as on the NCA documents and statements.
 */
export const portalLabels = {
  status_ACTIVE: "ACTIVE",
  status_COMPLETED: "COMPLETED",
  status_DEFAULTED: "DEFAULTED",
  status_PENDING_WRITE_OFF: "PENDING WRITE OFF",
  status_WRITTEN_OFF: "WRITTEN OFF",
  status_RESTRUCTURED: "RESTRUCTURED",
  status_CANCELLED: "CANCELLED",
  status_DRAFT: "DRAFT",
  status_SUBMITTED: "SUBMITTED",
  status_UNDER_REVIEW: "UNDER REVIEW",
  status_APPROVED: "APPROVED",
  status_DECLINED: "DECLINED",
  status_DISBURSED: "DISBURSED",
  status_PENDING: "PENDING",
  status_PARTIAL: "PARTIAL",
  status_PAID: "PAID",
  status_OVERDUE: "OVERDUE",
  status_LAPSED: "LAPSED",
  status_CLAIMED: "CLAIMED",
  status_EXPIRED: "EXPIRED",
  status_REJECTED: "REJECTED",
  loanGoodStanding: "Good Standing",
  loanInArrears: "In Arrears",
  loanPaidUp: "Paid Up",
  loanDefaulted: "Defaulted",
  loanPendingWriteOff: "Pending Write Off",
  loanWrittenOff: "Written Off",
  loanRestructured: "Restructured",
  loanCancelled: "Cancelled",
  method_EFT: "eft",
  method_CASH: "cash",
  method_DEBIT_ORDER: "debit order",
  method_CARD: "card",
  methodWaived: "Balance waived",
  doc_ID_COPY: "ID Copy",
  doc_PAYSLIP: "Payslip",
  doc_BANK_STATEMENT: "Bank Statement",
  doc_PROOF_OF_ADDRESS: "Proof of Address",
  chargesIncludes: "Includes:",
} as const
