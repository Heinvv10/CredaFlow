/**
 * IFRS 9 staging, expected credit loss and interest suspension: shared shapes.
 * ALL money is integer CENTS; rates are integer basis points (1% = 100).
 * Dates are SAST calendar dates as "yyyy-mm-dd" strings.
 */

export type Stage = 1 | 2 | 3

export const STAGES: readonly Stage[] = [1, 2, 3]

export type InterestBasis = "FULL_SUSPENSION" | "NET_BASIS"

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
  /** The stage a RESTRUCTURED loan, and a loan under NCA s86 debt review, is at least in (1 = no effect). */
  restructuredStage: Stage
  debtReviewStage: Stage
  /** Months of cleared triggers before Stage 2 moves back to Stage 1. */
  stage2ProbationMonths: number
  /** Months of cleared triggers before Stage 3 moves back to Stage 2. */
  stage3ProbationMonths: number
  /** Months a formerly RESTRUCTURED loan stays in its stage (the longer of this and the stage's own probation). */
  restructuredProbationMonths: number
  suspensionEnabled: boolean
  /** A Stage 3 loan at or above this many days past due is suspended (never below defaultDpd, so only Stage 3 is). */
  suspensionDpd: number
  /** ... and so is every Stage 3 loan, including its probation, when set. */
  suspendOnStage3: boolean
  /** FULL_SUSPENSION: prudential / regulatory (tender 2.8.3). NET_BASIS: IFRS 9 5.4.1(b). */
  stage3InterestBasis: InterestBasis
}

export const DEFAULT_SETTINGS: Ifrs9Settings = {
  enabled: false,
  effectiveFromMonth: null,
  sicrDpdOver: 30,
  defaultDpd: 90,
  restructuredStage: 2,
  debtReviewStage: 2,
  stage2ProbationMonths: 3,
  stage3ProbationMonths: 6,
  restructuredProbationMonths: 12,
  suspensionEnabled: true,
  suspensionDpd: 90,
  suspendOnStage3: true,
  stage3InterestBasis: "FULL_SUSPENSION",
}

/**
 * The contract types whose interest suspension is journalled (accounting/sources-ifrs9.ts). Asset-finance
 * interest stays in income, so for those the exposure keeps it and nothing is "suspended".
 */
export const JOURNALS_SUSPENSE: readonly string[] = ["LOAN"]
export const journalsSuspense = (contractType: string): boolean => JOURNALS_SUSPENSE.includes(contractType)

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
