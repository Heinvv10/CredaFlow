export const CREDIT_LIFE_DISCLOSURE_VERSION = "credit-life-election-v1" as const
/**
 * Recorded when the tenant has no active credit-life product with an active
 * insurer, so there was no cover to offer and nothing to quote. Distinct from
 * CREDIT_LIFE_DISCLOSURE_VERSION (an election against a concrete offer) and
 * from a NULL version (a legacy row that was never asked, which must keep
 * failing closed at the approval and disbursement gates).
 */
export const CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION = "credit-life-no-offer-v1" as const
export const CREDIT_LIFE_AUTO_BUNDLE_THRESHOLD_CENTS = 100_000

export const CREDIT_LIFE_ELECTIONS = ["ACCEPTED", "DECLINED"] as const
export type CreditLifeElection = (typeof CREDIT_LIFE_ELECTIONS)[number]

export interface CreditLifeOffer {
  productId: string
  productName: string
  insurerId: string
  insurerName: string
}

export interface CreditLifePresentedOffer extends CreditLifeOffer {
  autoBundleEnabled: boolean
}

export interface CreditLifeDisclosureEvidence extends CreditLifeOffer {
  version: typeof CREDIT_LIFE_DISCLOSURE_VERSION
  election: CreditLifeElection
  principalCents: number
  termDays: number
  monthlyPremiumCents: number
  acknowledgedAt: Date
  acknowledgedBy: string
}

/**
 * The disclosure hashed when no cover was offered. Deliberately excludes the
 * product, insurer and premium: there was no offer, so hashing placeholders
 * for them would assert a disclosure that never happened.
 */
export interface CreditLifeNoOfferDisclosureEvidence {
  version: typeof CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION
  election: "DECLINED"
  principalCents: number
  termDays: number
}

export function isCreditLifeElection(value: unknown): value is CreditLifeElection {
  return value === "ACCEPTED" || value === "DECLINED"
}

export function creditLifePrincipalIsEligible(principalCents: number): boolean {
  return (
    Number.isSafeInteger(principalCents)
    && principalCents > CREDIT_LIFE_AUTO_BUNDLE_THRESHOLD_CENTS
  )
}

/**
 * Credit Life Insurance Regulations, 2017, reg 3(1): R4.50 per R1,000 of
 * deferred amount per month. Keep this one integer-cents calculation shared by
 * every screen, PASQ artifact, policy writer, and database assertion.
 */
export function calculateCreditLifeMonthlyPremiumCents(
  principalCents: number,
): number {
  if (!Number.isSafeInteger(principalCents) || principalCents <= 0) {
    throw new RangeError("Credit-life principal must be a positive integer number of cents")
  }
  return Math.round(principalCents * 0.0045)
}

export function creditLifeOfferMatches(
  submitted: {
    productId: unknown
    productName: unknown
    insurerId: unknown
    insurerName: unknown
    monthlyPremiumCents: unknown
    version: unknown
  },
  expected: CreditLifeOffer & { monthlyPremiumCents: number },
): boolean {
  return (
    submitted.version === CREDIT_LIFE_DISCLOSURE_VERSION
    && submitted.productId === expected.productId
    && submitted.productName === expected.productName
    && submitted.insurerId === expected.insurerId
    && submitted.insurerName === expected.insurerName
    && submitted.monthlyPremiumCents === expected.monthlyPremiumCents
  )
}
