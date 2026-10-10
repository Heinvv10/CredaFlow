import { describe, expect, it } from "vitest"
import {
  CREDIT_LIFE_DISCLOSURE_VERSION,
  CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
  calculateCreditLifeMonthlyPremiumCents,
  creditLifeOfferMatches,
  creditLifePrincipalIsEligible,
  isCreditLifeElection,
} from "./credit-life-election"
import {
  createCreditLifeDisclosureSha256,
  createCreditLifeNoOfferDisclosureSha256,
  verifyAppliedCreditLifeDisclosure,
  verifyStoredCreditLifeDisclosure,
} from "./credit-life-election.server"

const DISCLOSURE = {
  version: CREDIT_LIFE_DISCLOSURE_VERSION,
  election: "ACCEPTED" as const,
  principalCents: 500_000,
  termDays: 30,
  monthlyPremiumCents: 2_250,
  productId: "credit-life-1",
  productName: "Acme Credit Life",
  insurerId: "insurer-1",
  insurerName: "Test Life",
}

function storedDisclosure() {
  return {
    creditLifeElection: DISCLOSURE.election,
    creditLifeProductId: DISCLOSURE.productId,
    creditLifeProductName: DISCLOSURE.productName,
    creditLifeInsurerId: DISCLOSURE.insurerId,
    creditLifeInsurerName: DISCLOSURE.insurerName,
    creditLifeMonthlyPremiumCents: DISCLOSURE.monthlyPremiumCents,
    creditLifeDisclosureVersion: DISCLOSURE.version,
    creditLifeDisclosureSha256: createCreditLifeDisclosureSha256(DISCLOSURE),
    creditLifeDisclosureAcknowledgedAt: new Date("2026-07-23T10:00:00.000Z"),
    creditLifeDisclosureAcknowledgedBy: "client-1",
  }
}

describe("credit-life disclosure evidence", () => {
  it("calculates the prescribed R4.50 per R1,000 premium in integer cents", () => {
    expect(calculateCreditLifeMonthlyPremiumCents(500_000)).toBe(2_250)
    expect(calculateCreditLifeMonthlyPremiumCents(150_000)).toBe(675)
    expect(calculateCreditLifeMonthlyPremiumCents(50_000)).toBe(225)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid principal of %s",
    (principalCents) => {
      expect(() => calculateCreditLifeMonthlyPremiumCents(principalCents)).toThrow(
        "positive integer number of cents",
      )
    },
  )

  it("only accepts explicit ACCEPTED or DECLINED elections", () => {
    expect(isCreditLifeElection("ACCEPTED")).toBe(true)
    expect(isCreditLifeElection("DECLINED")).toBe(true)
    expect(isCreditLifeElection("")).toBe(false)
    expect(isCreditLifeElection(true)).toBe(false)
  })

  it("preserves the existing above-R1,000 coverage threshold", () => {
    expect(creditLifePrincipalIsEligible(100_000)).toBe(false)
    expect(creditLifePrincipalIsEligible(100_001)).toBe(true)
    expect(creditLifePrincipalIsEligible(99_999.5)).toBe(false)
  })

  it("rejects stale or client-tampered offer fields", () => {
    const expected = {
      productId: DISCLOSURE.productId,
      productName: DISCLOSURE.productName,
      insurerId: DISCLOSURE.insurerId,
      insurerName: DISCLOSURE.insurerName,
      monthlyPremiumCents: DISCLOSURE.monthlyPremiumCents,
    }
    const submitted = {
      ...expected,
      version: CREDIT_LIFE_DISCLOSURE_VERSION,
    }

    expect(creditLifeOfferMatches(submitted, expected)).toBe(true)
    expect(creditLifeOfferMatches(
      { ...submitted, monthlyPremiumCents: submitted.monthlyPremiumCents - 1 },
      expected,
    )).toBe(false)
    expect(creditLifeOfferMatches(
      { ...submitted, insurerName: "Changed insurer" },
      expected,
    )).toBe(false)
    expect(creditLifeOfferMatches(
      { ...submitted, version: "credit-life-election-v0" },
      expected,
    )).toBe(false)
  })

  it("binds the election, loan terms, premium, product, and insurer into the hash", () => {
    const hash = createCreditLifeDisclosureSha256(DISCLOSURE)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(createCreditLifeDisclosureSha256(DISCLOSURE)).toBe(hash)

    for (const mutation of [
      { election: "DECLINED" as const },
      { principalCents: DISCLOSURE.principalCents + 1 },
      { termDays: DISCLOSURE.termDays + 1 },
      { monthlyPremiumCents: DISCLOSURE.monthlyPremiumCents + 1 },
      { productId: "credit-life-2" },
      { productName: "Other credit life" },
      { insurerId: "insurer-2" },
      { insurerName: "Other insurer" },
    ]) {
      expect(createCreditLifeDisclosureSha256({ ...DISCLOSURE, ...mutation })).not.toBe(hash)
    }
  })

  it("verifies intact stored evidence and identifies missing, premium, and hash failures", () => {
    const stored = storedDisclosure()
    const terms = { principalCents: DISCLOSURE.principalCents, termDays: DISCLOSURE.termDays }

    expect(verifyStoredCreditLifeDisclosure(stored, terms)).toEqual({
      ok: true,
      evidence: {
        ...DISCLOSURE,
        offered: true,
        disclosureSha256: stored.creditLifeDisclosureSha256,
      },
    })
    expect(verifyStoredCreditLifeDisclosure(
      { ...stored, creditLifeDisclosureAcknowledgedAt: null },
      terms,
    )).toEqual({ ok: false, reason: "missing" })
    expect(verifyStoredCreditLifeDisclosure(
      { ...stored, creditLifeMonthlyPremiumCents: DISCLOSURE.monthlyPremiumCents - 1 },
      terms,
    )).toEqual({ ok: false, reason: "premium_mismatch" })
    expect(verifyStoredCreditLifeDisclosure(
      { ...stored, creditLifeDisclosureSha256: "0".repeat(64) },
      terms,
    )).toEqual({ ok: false, reason: "hash_mismatch" })
    expect(verifyStoredCreditLifeDisclosure(
      stored,
      { ...terms, termDays: terms.termDays + 1 },
    )).toEqual({ ok: false, reason: "hash_mismatch" })
  })
})

describe("no-offer credit-life disclosure", () => {
  const NO_OFFER_TERMS = { principalCents: 100_000, termDays: 30 }

  function storedNoOffer(overrides: Record<string, unknown> = {}) {
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
        principalCents: NO_OFFER_TERMS.principalCents,
        termDays: NO_OFFER_TERMS.termDays,
      }),
      creditLifeDisclosureAcknowledgedAt: new Date("2026-07-28T10:00:00.000Z"),
      creditLifeDisclosureAcknowledgedBy: "client-1",
      ...overrides,
    }
  }

  it("verifies a decline recorded against no offer", () => {
    const stored = storedNoOffer()
    const result = verifyStoredCreditLifeDisclosure(stored, NO_OFFER_TERMS)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.evidence.offered).toBe(false)
    expect(result.evidence.productId).toBeNull()
    expect(result.evidence.insurerId).toBeNull()
    expect(result.evidence.monthlyPremiumCents).toBe(0)
    expect(result.evidence.version).toBe(CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION)
  })

  it("rejects a no-offer row that still carries an offer identity", () => {
    // Half-populated is a corrupted record, not a no-offer one.
    for (const corruption of [
      { creditLifeProductId: "credit-life-1" },
      { creditLifeProductName: "Acme Credit Life" },
      { creditLifeInsurerId: "insurer-1" },
      { creditLifeInsurerName: "Test Life" },
      { creditLifeMonthlyPremiumCents: 450 },
      { creditLifeElection: "ACCEPTED" },
    ]) {
      expect(
        verifyStoredCreditLifeDisclosure(storedNoOffer(corruption), NO_OFFER_TERMS),
      ).toEqual({ ok: false, reason: "missing" })
    }
  })

  it("rejects a no-offer hash bound to different loan terms", () => {
    // The hash covers principal and term, so re-pricing the loan after the
    // disclosure was recorded must invalidate it.
    expect(
      verifyStoredCreditLifeDisclosure(storedNoOffer(), {
        principalCents: NO_OFFER_TERMS.principalCents + 1,
        termDays: NO_OFFER_TERMS.termDays,
      }),
    ).toEqual({ ok: false, reason: "hash_mismatch" })
  })

  it("keeps a legacy all-null row failing closed", () => {
    // Pre-election rows were never asked and must NOT be un-gated by the
    // no-offer branch.
    expect(
      verifyStoredCreditLifeDisclosure(
        {
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
        },
        NO_OFFER_TERMS,
      ),
    ).toEqual({ ok: false, reason: "missing" })
  })

  it("does not collide with an offer disclosure over the same terms", () => {
    const noOffer = createCreditLifeNoOfferDisclosureSha256({
      version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
      election: "DECLINED",
      principalCents: NO_OFFER_TERMS.principalCents,
      termDays: NO_OFFER_TERMS.termDays,
    })
    const offered = createCreditLifeDisclosureSha256({
      version: CREDIT_LIFE_DISCLOSURE_VERSION,
      election: "DECLINED",
      principalCents: NO_OFFER_TERMS.principalCents,
      termDays: NO_OFFER_TERMS.termDays,
      monthlyPremiumCents: 450,
      productId: "credit-life-1",
      productName: "Acme Credit Life",
      insurerId: "insurer-1",
      insurerName: "Test Life",
    })
    expect(noOffer).not.toBe(offered)
  })
})

describe("verifyAppliedCreditLifeDisclosure — no-offer applications", () => {
  it("does not report a no-offer election as missing", () => {
    // The blockers rail renders "Credit-life election missing" from this
    // result. A no-offer application HAS a complete election, so the rail must
    // stay silent — otherwise it tells staff to recapture something that is
    // already correctly recorded, and offers a return-to-draft they don't need.
    const principalCents = 100_000
    const termDays = 30
    const result = verifyAppliedCreditLifeDisclosure({
      appliedAmount: principalCents,
      appliedTermDays: termDays,
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
        principalCents,
        termDays,
      }),
      creditLifeDisclosureAcknowledgedAt: new Date("2026-07-28T10:00:00.000Z"),
      creditLifeDisclosureAcknowledgedBy: "client-1",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.evidence.offered).toBe(false)
  })

  it("still reports a legacy all-null application as missing", () => {
    expect(verifyAppliedCreditLifeDisclosure({
      appliedAmount: 100_000,
      appliedTermDays: 30,
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
    })).toEqual({ ok: false, reason: "missing" })
  })
})

describe("credit-life premium rounding matches Postgres ROUND(numeric)", () => {
  // Postgres rounds half away from zero on exact numerics; principal is positive.
  function reference(principalCents: number): number {
    return Number((BigInt(principalCents) * BigInt(45) + BigInt(5_000)) / BigInt(10_000))
  }

  it.each([
    [101_000, 455],
    [1_339_000, 6_026],
    [100_000, 450],
    [100_001, 450],
    [100_111, 450],
    [500_000, 2_250],
  ])("premium for %i cents is %i", (principalCents, expected) => {
    expect(calculateCreditLifeMonthlyPremiumCents(principalCents)).toBe(expected)
  })

  it("agrees with the exact reference for every principal from 1 to 2,000,000 cents", () => {
    let mismatches = 0
    for (let p = 1; p <= 2_000_000; p++) {
      if (calculateCreditLifeMonthlyPremiumCents(p) !== reference(p)) mismatches++
    }
    expect(mismatches).toBe(0)
  })

  it("agrees with the exact reference on 500,000 random principals up to 500,000,000 cents", () => {
    let seed = 20261010
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    let mismatches = 0
    for (let i = 0; i < 500_000; i++) {
      const p = 1 + (next() % 500_000_000)
      if (calculateCreditLifeMonthlyPremiumCents(p) !== reference(p)) mismatches++
    }
    expect(mismatches).toBe(0)
  })

  it("rejects principals whose exact calculation would leave the safe-integer range", () => {
    expect(() =>
      calculateCreditLifeMonthlyPremiumCents(Number.MAX_SAFE_INTEGER),
    ).toThrow(RangeError)
  })
})
