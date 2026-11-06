import type { Jurisdiction } from "./profiles"

/**
 * Kenyan consumer-credit rules, as data. UNVERIFIED: every value here is the demo's reading of the
 * Central Bank of Kenya's rules for digital and non-deposit-taking credit providers and of the Excise
 * Duty Act, not confirmed by the lender's Kenyan counsel or its finance team. Pure data: nothing here
 * talks to the database or reads the active jurisdiction.
 *
 * WIRED: only `feeExciseRate`, and only as a disclosure. The key facts statement prints the excise
 * duty already included in the fees ({{quote.exciseDuty}}, lib/documents/tokens.ts); nothing is
 * charged on top and the loan calculator is unchanged. Whether the lender charges it on top instead
 * is for finance and counsel to confirm: that would change the calculator, the schedule and the
 * approved terms.
 *
 * NOT WIRED (data only, no code reads them yet): the CRB listing threshold and notice, the notice of a
 * change of terms, the complaint deadline, the interest cap on a non-performing loan, the order a
 * payment is allocated in, and the notice before a guarantor is contacted. Collections, allocation
 * (lib/collections-engine) and the bureau still behave as they do for every lender.
 */
export const KENYA_RULES = {
  /** UNVERIFIED: excise duty on fees charged by a lender, 20% since the Finance Act 2023. */
  feeExciseRate: 0.2,
  /** UNVERIFIED, NOT WIRED: no negative CRB listing below KES 1,000 (cents). */
  crbListingMinCents: 100_000,
  /** UNVERIFIED, NOT WIRED: days of notice to the borrower before a negative CRB listing. */
  crbNoticeDays: 30,
  /** UNVERIFIED, NOT WIRED: days of notice before a change of the terms takes effect. */
  termChangeNoticeDays: 30,
  /** UNVERIFIED, NOT WIRED: days to resolve a complaint. */
  complaintResolutionDays: 30,
  /** UNVERIFIED, NOT WIRED: once a loan is non-performing, interest stops accruing beyond the principal outstanding then. */
  nplInterestCap: "PRINCIPAL_AT_NPL",
  /** UNVERIFIED, NOT WIRED: the order a repayment is allocated in. lib/collections-engine keeps its own order. */
  allocationOrder: ["PRINCIPAL", "FEES", "INTEREST"],
  /** UNVERIFIED, NOT WIRED: days of notice to the borrower before a guarantor is contacted. */
  guarantorContactNoticeDays: 14,
} as const

/** The excise rate on a lender's fees, by jurisdiction. Only Kenya has one here (UNVERIFIED, above). */
const FEE_EXCISE_RATE: Record<Jurisdiction, number> = { ZA: 0, LS: 0, KE: KENYA_RULES.feeExciseRate }

export function feeExciseRate(jurisdiction: Jurisdiction): number {
  return FEE_EXCISE_RATE[jurisdiction]
}

/** The excise inside fees that already include it, in whole cents: round(fees x rate / (1 + rate)). Disclosed, not added. */
export function exciseIncludedInFees(feesCents: number, rate: number): number {
  return Math.round((feesCents * rate) / (1 + rate))
}
