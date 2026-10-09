import { describe, expect, it } from "vitest"
import {
  CREDIT_LIFE_DISCLOSURE_VERSION,
  CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
  calculateCreditLifeMonthlyPremiumCents,
  type CreditLifeOffer,
} from "./credit-life-election"
import {
  createCreditLifeDisclosureSha256,
  createCreditLifeNoOfferDisclosureSha256,
  type StoredCreditLifeDisclosure,
} from "./credit-life-election.server"
import { creditLifeEvidenceSurvivesReturnToReview } from "./credit-life-return-to-review"

const PRINCIPAL_CENTS = 200_000
const TERM_DAYS = 30
const TERMS = { principalCents: PRINCIPAL_CENTS, termDays: TERM_DAYS }

const OFFER: CreditLifeOffer = {
  productId: "prod-1",
  productName: "Credit Life Cover",
  insurerId: "ins-1",
  insurerName: "Example Insurer",
}

function noOfferRow(): StoredCreditLifeDisclosure {
  return {
    creditLifeElection: "DECLINED",
    creditLifeProductId: null,
    creditLifeProductName: null,
    creditLifeInsurerId: null,
    creditLifeInsurerName: null,
    creditLifeMonthlyPremiumCents: 0,
    creditLifeDisclosureVersion: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
    creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256({
      version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
      election: "DECLINED",
      principalCents: PRINCIPAL_CENTS,
      termDays: TERM_DAYS,
    }),
    creditLifeDisclosureAcknowledgedAt: new Date("2026-08-11T07:43:17.639Z"),
    creditLifeDisclosureAcknowledgedBy: "client-1",
  }
}

function offeredRow(election: "ACCEPTED" | "DECLINED" = "ACCEPTED"): StoredCreditLifeDisclosure {
  const monthlyPremiumCents = calculateCreditLifeMonthlyPremiumCents(PRINCIPAL_CENTS)
  return {
    creditLifeElection: election,
    creditLifeProductId: OFFER.productId,
    creditLifeProductName: OFFER.productName,
    creditLifeInsurerId: OFFER.insurerId,
    creditLifeInsurerName: OFFER.insurerName,
    creditLifeMonthlyPremiumCents: monthlyPremiumCents,
    creditLifeDisclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
    creditLifeDisclosureSha256: createCreditLifeDisclosureSha256({
      version: CREDIT_LIFE_DISCLOSURE_VERSION,
      election,
      principalCents: PRINCIPAL_CENTS,
      termDays: TERM_DAYS,
      monthlyPremiumCents,
      ...OFFER,
    }),
    creditLifeDisclosureAcknowledgedAt: new Date("2026-08-11T07:43:17.639Z"),
    creditLifeDisclosureAcknowledgedBy: "client-1",
  }
}

describe("creditLifeEvidenceSurvivesReturnToReview", () => {
  // Un-approving a loan to correct a credit obligation must not clear a
  // credit-life election that is still valid: the rail would demand a recapture
  // that only the wizard can do, and reaching the wizard also discards the
  // bureau enquiry. A no-offer disclosure's hash covers only version, election,
  // principal and term, none of which the un-approval touches. Nothing about it
  // has gone stale, so clearing it would buy a fresh bureau enquiry on the
  // consumer's record in exchange for re-recording identical evidence.
  it("retains a no-offer election when there is still no credit-life offer", () => {
    expect(creditLifeEvidenceSurvivesReturnToReview(noOfferRow(), TERMS, null))
      .toEqual({ retain: true })
  })

  // The row asserts no cover was offered. Once an insurer is onboarded that
  // assertion is false, and the DB approval guard rejects it anyway — so clear
  // it here and make staff recapture against the offer that now exists.
  it("clears a no-offer election once an offer becomes available", () => {
    expect(creditLifeEvidenceSurvivesReturnToReview(noOfferRow(), TERMS, OFFER))
      .toEqual({ retain: false, reason: "offer_now_available" })
  })

  it("retains an offer-backed election when the same offer still resolves", () => {
    expect(creditLifeEvidenceSurvivesReturnToReview(offeredRow(), TERMS, OFFER))
      .toEqual({ retain: true })
  })

  it("retains a declined offer-backed election when the offer is unchanged", () => {
    expect(creditLifeEvidenceSurvivesReturnToReview(offeredRow("DECLINED"), TERMS, OFFER))
      .toEqual({ retain: true })
  })

  it("clears an offer-backed election when the insurer changed", () => {
    expect(creditLifeEvidenceSurvivesReturnToReview(offeredRow(), TERMS, {
      ...OFFER,
      insurerId: "ins-2",
      insurerName: "Different Insurer",
    })).toEqual({ retain: false, reason: "offer_changed" })
  })

  it("clears an offer-backed election when the offer is withdrawn entirely", () => {
    expect(creditLifeEvidenceSurvivesReturnToReview(offeredRow(), TERMS, null))
      .toEqual({ retain: false, reason: "offer_changed" })
  })

  // A legacy all-null row must keep failing closed: retaining it would leave an
  // application under review with no election and no blocker telling anyone.
  it("clears evidence that does not verify", () => {
    expect(creditLifeEvidenceSurvivesReturnToReview({
      creditLifeElection: null,
      creditLifeProductId: null,
      creditLifeProductName: null,
      creditLifeInsurerId: null,
      creditLifeInsurerName: null,
      creditLifeMonthlyPremiumCents: null,
      creditLifeDisclosureVersion: null,
      creditLifeDisclosureSha256: null,
      creditLifeDisclosureAcknowledgedAt: null,
      creditLifeDisclosureAcknowledgedBy: null,
    }, TERMS, null)).toEqual({ retain: false, reason: "unverifiable" })
  })

  // The premium is derived from the principal, so a tampered stored premium
  // must not survive just because the offer identity still matches.
  it("clears evidence whose stored premium no longer matches the principal", () => {
    expect(creditLifeEvidenceSurvivesReturnToReview(
      { ...offeredRow(), creditLifeMonthlyPremiumCents: 1 },
      TERMS,
      OFFER,
    )).toEqual({ retain: false, reason: "unverifiable" })
  })
})
