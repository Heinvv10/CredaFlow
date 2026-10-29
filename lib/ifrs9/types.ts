/**
 * IFRS 9 staging, expected credit loss and interest suspension: shared shapes.
 * ALL money is integer CENTS; rates are integer basis points (1% = 100).
 * Dates are SAST calendar dates as "yyyy-mm-dd" strings.
 */

export type Stage = 1 | 2 | 3

export const STAGES: readonly Stage[] = [1, 2, 3]

/** The lender's staging and suspension policy (Ifrs9Config; defaults apply until it is saved). */
export interface Ifrs9Settings {
  /** The monthly job runs and a month may not close without its run. */
  enabled: boolean
  /** First month ("yyyy-mm") whose close needs a monthly run; null = every month once enabled. */
  effectiveFromMonth: string | null
  /** Stage 2 when days past due is MORE than this (IFRS 9 B5.5.19: "more than 30 days past due"). */
  sicrDpdOver: number
  /** Stage 3 when days past due is at or above this (IFRS 9 B5.5.37: default no later than 90 days; the product's NPL is >= 90 everywhere). */
  defaultDpd: number
  restructuredIsSicr: boolean
  debtReviewIsSicr: boolean
  /** Months of cleared triggers before Stage 2 moves back to Stage 1. */
  stage2ProbationMonths: number
  /** Months of cleared triggers before Stage 3 moves back to Stage 2. */
  stage3ProbationMonths: number
  suspensionEnabled: boolean
  /** Interest is suspended when days past due is at or above this. */
  suspensionDpd: number
  /** ... or when the loan is in Stage 3 (including its probation). */
  suspendOnStage3: boolean
}

export const DEFAULT_SETTINGS: Ifrs9Settings = {
  enabled: false,
  effectiveFromMonth: null,
  sicrDpdOver: 30,
  defaultDpd: 90,
  restructuredIsSicr: true,
  debtReviewIsSicr: true,
  stage2ProbationMonths: 3,
  stage3ProbationMonths: 6,
  suspensionEnabled: true,
  suspensionDpd: 90,
  suspendOnStage3: true,
}

/** What a staff member or an integration flags on a loan as a significant increase in credit risk. */
export const SICR_FLAG_KINDS = ["BUREAU_DOWNGRADE", "BEHAVIOUR_DOWNGRADE", "WATCHLIST", "OTHER"] as const
export type SicrFlagKind = (typeof SICR_FLAG_KINDS)[number]

/** One row of the PD/LGD table: the PD for Stage 1 is 12-month, for Stage 2 and 3 lifetime. */
export interface EclParameter {
  scopeKey: string
  stage: Stage
  pdBps: number
  lgdBps: number
}

export const DEFAULT_SCOPE = "DEFAULT"
export const productScope = (productId: string) => `PRODUCT:${productId}`
export const contractScope = (contractType: string) => `CONTRACT:${contractType}`
