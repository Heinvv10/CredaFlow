// Unit tests for the rating gate, focused on the ONE failure mode that would
// make it look green while enforcing nothing: comparing money as rands.
//
// Prisma's `Decimal.toJSON()` returns a STRING. A figure that has crossed JSON
// arrives as "420", not 420, and `"420" === 420` is always false — so a rands
// comparison would 409 every FUNERAL_COVER and LIFE_INSURANCE draft while
// appearing to work. Every test below fails if the cents comparison is
// reintroduced on rands.

import { describe, expect, it } from "vitest"
import { screenDraftRating, requiresRating, RATED_POLICY_TYPES } from "./draft-rating-gate"

const AT = new Date("2026-08-16T00:00:00Z")
const DOB = new Date("1985-03-01T00:00:00Z") // 41 at AT

/** NON-UNIFORM: four life types, four prices, so a match is meaningful. */
const BANDS = [
  { id: "b-mm", lifeType: "MAIN_MEMBER" as const, minAge: 18, maxAge: 65, sumAssured: "50000.00", premiumAmount: "420.00" },
  { id: "b-sp", lifeType: "SPOUSE" as const, minAge: 18, maxAge: 65, sumAssured: "50000.00", premiumAmount: "310.00" },
  { id: "b-ch", lifeType: "CHILD" as const, minAge: 0, maxAge: 21, sumAssured: "50000.00", premiumAmount: "75.50" },
  { id: "b-ef", lifeType: "EXTENDED_FAMILY" as const, minAge: 18, maxAge: 75, sumAssured: "50000.00", premiumAmount: "515.25" },
]

const RULES = [
  { id: "r1", lifeScope: "ALL_LIVES" as const, ruleType: "MIN_ENTRY_AGE" as const, numericValue: "18", textValue: null, active: true },
  { id: "r2", lifeScope: "ALL_LIVES" as const, ruleType: "MAX_ENTRY_AGE" as const, numericValue: "75", textValue: null, active: true },
  { id: "r3", lifeScope: "ALL_LIVES" as const, ruleType: "MAX_COVER" as const, numericValue: "50000", textValue: null, active: true },
  { id: "r4", lifeScope: "ALL_LIVES" as const, ruleType: "WAITING_PERIOD_DAYS" as const, numericValue: "180", textValue: null, active: true },
]

function reader(bands = BANDS, rules: unknown[] = RULES) {
  return {
    insuranceRateTable: {
      findMany: async () => [{
        id: "rt-1", version: 1, name: "card", basis: "AGE_BANDED",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"), effectiveTo: null, insurerId: null,
        bands,
      }],
    },
    insuranceEligibilityRule: { findMany: async () => rules },
  } as never
}

const BASE = {
  tenantId: "tenant-1",
  productId: "product-1",
  type: "FUNERAL_COVER",
  sumAssured: 50000,
  clientDateOfBirth: DOB,
  at: AT,
}

describe("screenDraftRating — money crosses JSON as a STRING", () => {
  it("accepts a premium supplied as a NUMBER", async () => {
    const result = await screenDraftRating(reader(), { ...BASE, premiumAmount: 420 })
    expect(result).toEqual({ ok: true, derivedPremium: "420.00" })
  })

  it("accepts the SAME premium supplied as a STRING, as Decimal.toJSON emits it", async () => {
    // This is the test that dies the moment anyone writes `=== ` on rands.
    const result = await screenDraftRating(reader(), { ...BASE, premiumAmount: "420" })
    expect(result).toEqual({ ok: true, derivedPremium: "420.00" })
  })

  it("accepts a string carrying explicit decimals", async () => {
    const result = await screenDraftRating(reader(), { ...BASE, premiumAmount: "420.00" })
    expect(result).toMatchObject({ ok: true })
  })

  it("accepts a sum assured supplied as a string too", async () => {
    const result = await screenDraftRating(reader(), { ...BASE, sumAssured: "50000.00", premiumAmount: "420.00" })
    expect(result).toMatchObject({ ok: true })
  })

  it("still refuses a genuine mismatch, so the tolerance above is not blanket", async () => {
    const result = await screenDraftRating(reader(), { ...BASE, premiumAmount: "300" })
    expect(result).toMatchObject({ ok: false, reason: "PREMIUM_MISMATCH", derivedPremium: "420.00" })
  })

  it("refuses a one-cent difference", async () => {
    const result = await screenDraftRating(reader(), { ...BASE, premiumAmount: "420.01" })
    expect(result).toMatchObject({ ok: false, reason: "PREMIUM_MISMATCH" })
  })

  it("names the derived figure in the refusal", async () => {
    const result = await screenDraftRating(reader(), { ...BASE, premiumAmount: 300 })
    if (result.ok) throw new Error("expected a refusal")
    expect(result.detail).toContain("420.00")
    expect(result.derivedPremium).toBe("420.00")
  })
})

describe("screenDraftRating — scope and fail-closed behaviour", () => {
  it("screens exactly FUNERAL_COVER and LIFE_INSURANCE", () => {
    expect([...RATED_POLICY_TYPES].sort()).toEqual(["FUNERAL_COVER", "LIFE_INSURANCE"])
    expect(requiresRating("CREDIT_LIFE")).toBe(false)
    expect(requiresRating("SHORT_TERM_MOTOR")).toBe(false)
    expect(requiresRating("FUNERAL_COVER")).toBe(true)
  })

  it("refuses a rated type with no productId", async () => {
    const result = await screenDraftRating(reader(), { ...BASE, productId: null, premiumAmount: 420 })
    expect(result).toMatchObject({ ok: false, reason: "PRODUCT_REQUIRED" })
  })

  it("refuses when the product is not sellable", async () => {
    // No eligibility rules at all -> mandatory terms unresolved.
    const result = await screenDraftRating(reader(BANDS, []), { ...BASE, premiumAmount: 420 })
    expect(result).toMatchObject({ ok: false, reason: "PRODUCT_NOT_SELLABLE" })
  })

  it("refuses a client with no date of birth rather than guessing an age", async () => {
    const result = await screenDraftRating(reader(), { ...BASE, clientDateOfBirth: null, premiumAmount: 420 })
    expect(result).toMatchObject({ ok: false, reason: "NO_DATE_OF_BIRTH" })
  })

  it("refuses when the card cannot price this client", async () => {
    // 41-year-old against a card whose only MAIN_MEMBER band stops at 30.
    const narrow = BANDS.map((b) => (b.id === "b-mm" ? { ...b, maxAge: 30 } : b))
    const result = await screenDraftRating(reader(narrow), { ...BASE, premiumAmount: 420 })
    expect(result).toMatchObject({ ok: false, reason: "RATING_FAILED" })
  })
})
