import { isNcaJurisdiction } from "@/lib/jurisdiction/active"

export const COLLECTIONS_ELIGIBLE_STATUSES = ["ACTIVE", "DEFAULTED"] as const
export const SECTION129_MIN_DAYS_IN_ARREARS = 90
export const DUNNING_MIN_DAYS_IN_ARREARS = 1
export const SECTION129_RECENT_NOTICE_WINDOW_DAYS = 30

export interface CollectionsLoanState {
  status: string
  /**
   * Loan.ncaRegime. REQUIRED, so every caller has to select it: an optional
   * discriminator defaults to "eligible" at whichever caller forgot it.
   */
  ncaRegime: "NCA" | "NON_NCA"
  arrearsAmount: number | null | undefined
  outstandingPrincipal: number | null | undefined
  daysInArrears: number | null | undefined
}

export type CollectionsOperation = "DUNNING" | "SECTION_129"

export const SECTION129_NON_NCA_REASON =
  "Section 129 applies to NCA credit agreements only; this agreement is not regulated by the NCA"

export const SECTION129_NON_NCA_JURISDICTION_REASON =
  "Section 129 applies under the South African National Credit Act only; this lender does not operate under it"

export interface CollectionsEligibility {
  eligible: boolean
  reason: string | null
  /** True only when time alone lifts the block (the DPD threshold); callers must not parse `reason`. */
  temporary: boolean
  minimumDaysInArrears: number
}

/**
 * One policy for every collections mutation and statutory-notice surface.
 * Operation-specific timing is explicit: ordinary dunning begins at 1 DPD;
 * a Section 129 notice requires 90 DPD. Terminal/restructured/write-off states
 * are never inferred from stale positive amount columns. Section 129 is an NCA
 * remedy: a NON_NCA agreement is never eligible, however far in arrears, and
 * neither is any agreement of a lender outside the NCA's jurisdiction
 * (lib/jurisdiction: the one gate for NCA-only steps).
 * Dunning is contractual and applies to both regimes.
 */
export function evaluateCollectionsEligibility(
  loan: CollectionsLoanState,
  operation: CollectionsOperation,
): CollectionsEligibility {
  const minimumDaysInArrears = operation === "SECTION_129"
    ? SECTION129_MIN_DAYS_IN_ARREARS
    : DUNNING_MIN_DAYS_IN_ARREARS

  if (operation === "SECTION_129" && !isNcaJurisdiction()) {
    return { eligible: false, temporary: false, minimumDaysInArrears, reason: SECTION129_NON_NCA_JURISDICTION_REASON }
  }
  if (operation === "SECTION_129" && loan.ncaRegime === "NON_NCA") {
    return { eligible: false, temporary: false, minimumDaysInArrears, reason: SECTION129_NON_NCA_REASON }
  }
  if (!COLLECTIONS_ELIGIBLE_STATUSES.includes(
    loan.status as (typeof COLLECTIONS_ELIGIBLE_STATUSES)[number],
  )) {
    return {
      eligible: false,
      temporary: false,
      minimumDaysInArrears,
      reason: `loan status ${loan.status} is not eligible for collections activity`,
    }
  }
  if ((loan.arrearsAmount ?? 0) <= 0) {
    return {
      eligible: false,
      temporary: false,
      minimumDaysInArrears,
      reason: "the account has no positive arrears to collect",
    }
  }
  if ((loan.outstandingPrincipal ?? 0) <= 0) {
    return {
      eligible: false,
      temporary: false,
      minimumDaysInArrears,
      reason: "the account has no outstanding principal",
    }
  }
  if ((loan.daysInArrears ?? 0) < minimumDaysInArrears) {
    return {
      eligible: false,
      temporary: true,
      minimumDaysInArrears,
      reason: `the account is below the ${minimumDaysInArrears}-day arrears threshold`,
    }
  }
  return { eligible: true, temporary: false, reason: null, minimumDaysInArrears }
}

export function isCollectionsEligible(loan: CollectionsLoanState): boolean {
  return evaluateCollectionsEligibility(loan, "DUNNING").eligible
}

export function isSection129Eligible(loan: CollectionsLoanState): boolean {
  return evaluateCollectionsEligibility(loan, "SECTION_129").eligible
}
