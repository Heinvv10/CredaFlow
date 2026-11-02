/** The kinds of loan change (tender item 2.6.6) and what a proposal carries. All money is integer cents. */
export const LOAN_CHANGE_KIND = "LOAN_CHANGE"

/** Rewrite the unpaid part of the loan's own schedule. */
export const IN_PLACE_TYPES = ["RESCHEDULE", "RESTRUCTURE", "PAYMENT_HOLIDAY", "RATE_CHANGE", "TERM_CHANGE"] as const
/** Settle the old loan(s) with existing settlement logic and book a new one. */
export const NEW_LOAN_TYPES = ["TOP_UP", "REFINANCE", "CONSOLIDATION"] as const
export const LOAN_CHANGE_TYPES = [...IN_PLACE_TYPES, ...NEW_LOAN_TYPES] as const

export type InPlaceType = (typeof IN_PLACE_TYPES)[number]
export type NewLoanType = (typeof NEW_LOAN_TYPES)[number]
export type LoanChangeType = (typeof LOAN_CHANGE_TYPES)[number]

export const LOAN_CHANGE_LABELS: Record<LoanChangeType, string> = {
  RESCHEDULE: "Reschedule", RESTRUCTURE: "Restructure", PAYMENT_HOLIDAY: "Payment holiday", RATE_CHANGE: "Rate change", TERM_CHANGE: "Term change",
  TOP_UP: "Top-up", REFINANCE: "Refinance", CONSOLIDATION: "Consolidation",
}

export const isNewLoanType = (type: LoanChangeType): type is NewLoanType => (NEW_LOAN_TYPES as readonly string[]).includes(type)

export type InPlaceChange =
  | { type: "RESCHEDULE"; firstDueDate: string }
  | { type: "RESTRUCTURE"; interestRatePm?: number; instalments?: number }
  | { type: "PAYMENT_HOLIDAY"; holidayInstalments: number }
  | { type: "RATE_CHANGE"; interestRatePm: number }
  | { type: "TERM_CHANGE"; instalments: number }

export type NewLoanChange =
  | { type: "TOP_UP"; newMoneyCents: number; payoutReference: string; instalments: number; interestRatePm?: number }
  | { type: "REFINANCE"; instalments: number; interestRatePm?: number }
  | { type: "CONSOLIDATION"; otherLoanIds: string[]; instalments: number; interestRatePm?: number }

/** The whole of what the checker approves. */
export type LoanChangePayload = (InPlaceChange | NewLoanChange) & {
  loanId: string
  reason: string
  /** The signed variation or new agreement on the lender's own wording: a ClientDocument of the borrower. */
  signedDocumentId: string
}
