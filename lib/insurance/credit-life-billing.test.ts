import { describe, expect, it } from "vitest"
import {
  calculateCreditLifePremiumPeriodsForSchedule,
  creditLifePremiumPaymentLoadCents,
  creditLifePremiumsByInstallment,
} from "./credit-life-billing"

describe("credit-life billing periods", () => {
  it.each([
    [30, 1],
    [31, 2],
    [44, 2],
    [45, 2],
    [60, 2],
    [61, 3],
  ])(
    "bills every begun 30-day cover period for a %i-day bullet",
    (termDays, expectedPeriods) => {
      expect(calculateCreditLifePremiumPeriodsForSchedule(1, termDays))
        .toBe(expectedPeriods)
    },
  )

  it("never returns fewer premium periods than repayment rows", () => {
    expect(calculateCreditLifePremiumPeriodsForSchedule(3, 31)).toBe(3)
  })
})

// When no CREDIT_LIFE product is configured for the tenant, every application
// carries election=DECLINED with a premium of exactly 0. This helper must not
// demand a positive premium unconditionally — before its own `if (!accepted)`
// early return — or PASQ generation throws an uncaught RangeError and returns
// an empty 500, and no application can be approved at all.
//
// The DB models this state explicitly: the
// LoanApplication_credit_life_election_complete CHECK admits
// election=DECLINED + all product/insurer columns NULL + premium exactly 0 +
// disclosureVersion 'credit-life-no-offer-v1'.
describe("credit-life billing with no cover offered", () => {
  const noOffer = {
    scheduleLength: 1,
    premiumPeriods: 1,
    monthlyPremiumCents: 0,
    accepted: false,
  }

  it("allocates zero premiums when cover was declined and none was offered", () => {
    expect(creditLifePremiumsByInstallment(noOffer)).toEqual([0])
  })

  it("does the same across a multi-instalment schedule", () => {
    expect(creditLifePremiumsByInstallment({
      scheduleLength: 3,
      premiumPeriods: 3,
      monthlyPremiumCents: 0,
      accepted: false,
    })).toEqual([0, 0, 0])
  })

  it("reports a zero payment load rather than throwing", () => {
    expect(creditLifePremiumPaymentLoadCents(noOffer)).toBe(0)
  })

  // The guarantee that must NOT be lost: accepted cover always has a premium.
  it("still rejects ACCEPTED cover with a zero premium", () => {
    expect(() => creditLifePremiumsByInstallment({ ...noOffer, accepted: true }))
      .toThrow(/outside the supported range/i)
  })

  it("still rejects a negative premium, accepted or not", () => {
    expect(() => creditLifePremiumsByInstallment({ ...noOffer, monthlyPremiumCents: -1 }))
      .toThrow(/outside the supported range/i)
    expect(() => creditLifePremiumsByInstallment({
      ...noOffer, monthlyPremiumCents: -1, accepted: true,
    })).toThrow(/outside the supported range/i)
  })

  it("still allocates a real premium when cover was accepted", () => {
    expect(creditLifePremiumsByInstallment({
      scheduleLength: 1, premiumPeriods: 1, monthlyPremiumCents: 2250, accepted: true,
    })).toEqual([2250])
  })
})
