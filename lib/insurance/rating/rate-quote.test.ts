import { describe, expect, it } from "vitest"
import { ageAtDate, rateLife, rateQuote, type RateBandInput } from "./rate-quote"

// Non-uniform on purpose. Premiums differ across age band, life type AND cover
// tier, so an assertion cannot pass by accident against a flat fixture: swap
// any two bands and at least one expectation below breaks.
const AGE_BANDED_BANDS: RateBandInput[] = [
  { id: "mm-18-35-10k", lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 35, sumAssured: "10000.00", premiumAmount: "42.50" },
  { id: "mm-18-35-25k", lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 35, sumAssured: "25000.00", premiumAmount: "97.30" },
  { id: "mm-36-55-10k", lifeType: "MAIN_MEMBER", minAge: 36, maxAge: 55, sumAssured: "10000.00", premiumAmount: "68.15" },
  { id: "mm-36-55-25k", lifeType: "MAIN_MEMBER", minAge: 36, maxAge: 55, sumAssured: "25000.00", premiumAmount: "159.90" },
  { id: "sp-18-55-10k", lifeType: "SPOUSE", minAge: 18, maxAge: 55, sumAssured: "10000.00", premiumAmount: "38.05" },
  { id: "ch-0-13-5k", lifeType: "CHILD", minAge: 0, maxAge: 13, sumAssured: "5000.00", premiumAmount: "9.75" },
  { id: "ch-14-21-5k", lifeType: "CHILD", minAge: 14, maxAge: 21, sumAssured: "5000.00", premiumAmount: "14.40" },
]

const FLAT_BANDS: RateBandInput[] = [
  { id: "flat-mm-10k", lifeType: "MAIN_MEMBER", minAge: 0, maxAge: 120, sumAssured: "10000.00", premiumAmount: "55.00" },
  { id: "flat-mm-20k", lifeType: "MAIN_MEMBER", minAge: 0, maxAge: 120, sumAssured: "20000.00", premiumAmount: "104.60" },
  { id: "flat-ch-5k", lifeType: "CHILD", minAge: 0, maxAge: 120, sumAssured: "5000.00", premiumAmount: "12.25" },
]

const PER_MILLE_BANDS: RateBandInput[] = [
  { id: "pm-mm-18-40", lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 40, sumAssured: "0.00", premiumAmount: "3.30" },
  { id: "pm-mm-41-65", lifeType: "MAIN_MEMBER", minAge: 41, maxAge: 65, sumAssured: "0.00", premiumAmount: "7.85" },
  { id: "pm-sp-18-65", lifeType: "SPOUSE", minAge: 18, maxAge: 65, sumAssured: "0.00", premiumAmount: "5.50" },
]

describe("ageAtDate", () => {
  it("counts completed years against the caller's effective date", () => {
    expect(ageAtDate(new Date("1990-06-15T00:00:00Z"), new Date("2026-06-15T00:00:00Z"))).toBe(36)
  })

  it("has not yet turned on the day before the birthday", () => {
    expect(ageAtDate(new Date("1990-06-15T00:00:00Z"), new Date("2026-06-14T00:00:00Z"))).toBe(35)
  })

  it("returns 0 for an infant rather than a negative age", () => {
    expect(ageAtDate(new Date("2026-01-02T00:00:00Z"), new Date("2026-06-01T00:00:00Z"))).toBe(0)
  })

  it("refuses a date of birth after the effective date instead of guessing", () => {
    expect(() => ageAtDate(new Date("2027-01-01T00:00:00Z"), new Date("2026-06-01T00:00:00Z"))).toThrow(
      /before the effective date/,
    )
  })
})

describe("rateLife — AGE_BANDED", () => {
  it("prices the band matching life type, age and cover tier", () => {
    const result = rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "MAIN_MEMBER", 40, "25000.00")
    expect(result).toEqual({ ok: true, bandId: "mm-36-55-25k", premium: "159.90", premiumCents: 15990 })
  })

  it("distinguishes cover tier at the same age", () => {
    expect(rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "MAIN_MEMBER", 40, "10000.00")).toMatchObject({
      ok: true,
      premium: "68.15",
    })
  })

  it("distinguishes life type at the same age and cover", () => {
    expect(rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "SPOUSE", 30, "10000.00")).toMatchObject({
      ok: true,
      premium: "38.05",
    })
    expect(rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "MAIN_MEMBER", 30, "10000.00")).toMatchObject({
      ok: true,
      premium: "42.50",
    })
  })

  it("includes both boundary ages of a band", () => {
    expect(rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "CHILD", 0, "5000.00")).toMatchObject({ bandId: "ch-0-13-5k" })
    expect(rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "CHILD", 13, "5000.00")).toMatchObject({ bandId: "ch-0-13-5k" })
    expect(rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "CHILD", 14, "5000.00")).toMatchObject({ bandId: "ch-14-21-5k" })
    expect(rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "CHILD", 21, "5000.00")).toMatchObject({ bandId: "ch-14-21-5k" })
  })

  it("fails explicitly one year past the top band rather than pricing at zero", () => {
    const result = rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "CHILD", 22, "5000.00")
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: "NO_MATCHING_BAND" })
    expect(result).not.toHaveProperty("premium")
  })

  it("fails explicitly on a cover amount no band offers", () => {
    expect(rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "MAIN_MEMBER", 30, "15000.00")).toMatchObject({
      ok: false,
      reason: "NO_MATCHING_BAND",
    })
  })

  it("fails explicitly on a life type the rate card does not cover", () => {
    expect(rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "EXTENDED_FAMILY", 30, "10000.00")).toMatchObject({
      ok: false,
      reason: "NO_MATCHING_BAND",
    })
  })

  it("reports an empty rate card distinctly from an unmatched life", () => {
    expect(rateLife([], "AGE_BANDED", "MAIN_MEMBER", 30, "10000.00")).toMatchObject({
      ok: false,
      reason: "NO_BANDS_CONFIGURED",
    })
  })

  it("errors on overlapping bands instead of taking the first match", () => {
    const overlapping: RateBandInput[] = [
      ...AGE_BANDED_BANDS,
      { id: "mm-30-45-25k", lifeType: "MAIN_MEMBER", minAge: 30, maxAge: 45, sumAssured: "25000.00", premiumAmount: "88.00" },
    ]
    const result = rateLife(overlapping, "AGE_BANDED", "MAIN_MEMBER", 33, "25000.00")
    expect(result).toMatchObject({ ok: false, reason: "AMBIGUOUS_BANDS" })
    expect(result.ok === false && result.bandIds).toEqual(["mm-18-35-25k", "mm-30-45-25k"])
  })

  it("refuses a non-integer or negative age rather than coercing it", () => {
    expect(rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "MAIN_MEMBER", 30.5, "10000.00")).toMatchObject({
      ok: false,
      reason: "INVALID_AGE",
    })
    expect(rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "MAIN_MEMBER", -1, "10000.00")).toMatchObject({
      ok: false,
      reason: "INVALID_AGE",
    })
  })

  it("refuses a zero or negative sum assured", () => {
    expect(rateLife(AGE_BANDED_BANDS, "AGE_BANDED", "MAIN_MEMBER", 30, "0.00")).toMatchObject({
      ok: false,
      reason: "INVALID_SUM_ASSURED",
    })
  })
})

describe("rateLife — FLAT", () => {
  it("prices by cover tier and ignores age entirely", () => {
    const young = rateLife(FLAT_BANDS, "FLAT", "MAIN_MEMBER", 19, "20000.00")
    const old = rateLife(FLAT_BANDS, "FLAT", "MAIN_MEMBER", 74, "20000.00")
    expect(young).toMatchObject({ ok: true, bandId: "flat-mm-20k", premium: "104.60" })
    expect(old).toEqual(young)
  })

  it("still distinguishes cover tier and life type", () => {
    expect(rateLife(FLAT_BANDS, "FLAT", "MAIN_MEMBER", 30, "10000.00")).toMatchObject({ premium: "55.00" })
    expect(rateLife(FLAT_BANDS, "FLAT", "CHILD", 30, "5000.00")).toMatchObject({ premium: "12.25" })
  })

  it("fails on an unoffered cover tier rather than falling back to a neighbour", () => {
    expect(rateLife(FLAT_BANDS, "FLAT", "MAIN_MEMBER", 30, "15000.00")).toMatchObject({
      ok: false,
      reason: "NO_MATCHING_BAND",
    })
  })

  it("errors when two bands share a life type and cover tier", () => {
    const duplicated: RateBandInput[] = [
      ...FLAT_BANDS,
      { id: "flat-mm-10k-dup", lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 65, sumAssured: "10000.00", premiumAmount: "51.00" },
    ]
    expect(rateLife(duplicated, "FLAT", "MAIN_MEMBER", 30, "10000.00")).toMatchObject({
      ok: false,
      reason: "AMBIGUOUS_BANDS",
    })
  })
})

describe("rateLife — PER_MILLE", () => {
  it("multiplies the per-R1000 rate by the cover amount", () => {
    // 3.30 per R1000 on R150 000 = 495.00
    expect(rateLife(PER_MILLE_BANDS, "PER_MILLE", "MAIN_MEMBER", 30, "150000.00")).toEqual({
      ok: true,
      bandId: "pm-mm-18-40",
      premium: "495.00",
      premiumCents: 49500,
    })
  })

  it("uses the age band's rate, not a single flat rate", () => {
    // 7.85 per R1000 on R150 000 = 1177.50
    expect(rateLife(PER_MILLE_BANDS, "PER_MILLE", "MAIN_MEMBER", 41, "150000.00")).toMatchObject({
      bandId: "pm-mm-41-65",
      premium: "1177.50",
    })
  })

  it("rounds the half-cent up rather than truncating it", () => {
    // 5.50 per R1000 on R1 001.00 = 5.5055 -> 5.51
    expect(rateLife(PER_MILLE_BANDS, "PER_MILLE", "SPOUSE", 30, "1001.00")).toMatchObject({ premium: "5.51" })
  })

  it("stays exact where float multiplication drifts", () => {
    // 3.30 * 1_000_000 / 1000 = 3300.00 exactly.
    expect(rateLife(PER_MILLE_BANDS, "PER_MILLE", "MAIN_MEMBER", 25, "1000000.00")).toMatchObject({
      premium: "3300.00",
    })
  })

  it("fails outside every age band rather than pricing at zero", () => {
    expect(rateLife(PER_MILLE_BANDS, "PER_MILLE", "MAIN_MEMBER", 66, "150000.00")).toMatchObject({
      ok: false,
      reason: "NO_MATCHING_BAND",
    })
  })
})

describe("rateLife — a matched band must still price above zero", () => {
  // Matching a band is not the same as having a price. A band captured as 0.00
  // — a data-entry slip, an insurer's placeholder row — used to return
  // { ok: true, premium: "0.00" }, which is exactly the free cover the
  // NO_MATCHING_BAND rule exists to prevent, arrived at through the front door.
  it("refuses a FLAT band captured at 0.00 rather than selling cover for free", () => {
    const bands: RateBandInput[] = [
      { id: "flat-mm-10k-zero", lifeType: "MAIN_MEMBER", minAge: 0, maxAge: 120, sumAssured: "10000.00", premiumAmount: "0.00" },
    ]
    const result = rateLife(bands, "FLAT", "MAIN_MEMBER", 30, "10000.00")
    expect(result).toMatchObject({ ok: false, reason: "NON_POSITIVE_PREMIUM" })
    expect(result).not.toHaveProperty("premium")
  })

  it("refuses a FLAT band captured at a negative premium", () => {
    const bands: RateBandInput[] = [
      { id: "flat-mm-10k-neg", lifeType: "MAIN_MEMBER", minAge: 0, maxAge: 120, sumAssured: "10000.00", premiumAmount: "-50.00" },
    ]
    expect(rateLife(bands, "FLAT", "MAIN_MEMBER", 30, "10000.00")).toMatchObject({
      ok: false,
      reason: "NON_POSITIVE_PREMIUM",
    })
  })

  it("refuses an AGE_BANDED band captured at 0.00", () => {
    const bands: RateBandInput[] = [
      { id: "mm-18-35-10k-zero", lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 35, sumAssured: "10000.00", premiumAmount: "0.00" },
    ]
    expect(rateLife(bands, "AGE_BANDED", "MAIN_MEMBER", 30, "10000.00")).toMatchObject({
      ok: false,
      reason: "NON_POSITIVE_PREMIUM",
    })
  })

  it("refuses a PER_MILLE quote whose rounded premium underflows to zero", () => {
    // 3.30 per R1 000 on R1.51 of cover is 0.004983 -> rounds to 0 cents.
    expect(rateLife(PER_MILLE_BANDS, "PER_MILLE", "MAIN_MEMBER", 30, "1.51")).toMatchObject({
      ok: false,
      reason: "NON_POSITIVE_PREMIUM",
    })
  })

  it("still prices the smallest PER_MILLE premium that reaches one cent", () => {
    // R1.52 of cover rounds to 0.01 — one cent above the underflow boundary.
    expect(rateLife(PER_MILLE_BANDS, "PER_MILLE", "MAIN_MEMBER", 30, "1.52")).toMatchObject({
      ok: true,
      premium: "0.01",
    })
  })

  it("fails the whole quote when one life's band prices at zero", () => {
    const bands: RateBandInput[] = [
      { id: "flat-mm-10k", lifeType: "MAIN_MEMBER", minAge: 0, maxAge: 120, sumAssured: "10000.00", premiumAmount: "55.00" },
      { id: "flat-ch-5k-zero", lifeType: "CHILD", minAge: 0, maxAge: 120, sumAssured: "5000.00", premiumAmount: "0.00" },
    ]
    const result = rateQuote(
      bands,
      "FLAT",
      [
        { ref: "main", lifeType: "MAIN_MEMBER", dateOfBirth: new Date("1986-01-10T00:00:00Z"), sumAssured: "10000.00" },
        { ref: "child-1", lifeType: "CHILD", dateOfBirth: new Date("2016-07-04T00:00:00Z"), sumAssured: "5000.00" },
      ],
      new Date("2026-08-15T00:00:00Z"),
    )
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty("totalPremium")
    expect(result.failures).toEqual([
      expect.objectContaining({ ref: "child-1", reason: "NON_POSITIVE_PREMIUM" }),
    ])
  })
})

describe("rateQuote", () => {
  const effectiveDate = new Date("2026-08-15T00:00:00Z")

  const lives = [
    { ref: "main", lifeType: "MAIN_MEMBER" as const, dateOfBirth: new Date("1986-01-10T00:00:00Z"), sumAssured: "25000.00" },
    { ref: "spouse", lifeType: "SPOUSE" as const, dateOfBirth: new Date("1990-03-02T00:00:00Z"), sumAssured: "10000.00" },
    { ref: "child-1", lifeType: "CHILD" as const, dateOfBirth: new Date("2016-07-04T00:00:00Z"), sumAssured: "5000.00" },
  ]

  it("rates every life at its own age and sums exactly", () => {
    const result = rateQuote(AGE_BANDED_BANDS, "AGE_BANDED", lives, effectiveDate)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected a rated quote")

    expect(result.perLife).toEqual([
      { ref: "main", lifeType: "MAIN_MEMBER", ageAtEntry: 40, bandId: "mm-36-55-25k", premium: "159.90", premiumCents: 15990, sumAssured: "25000.00" },
      { ref: "spouse", lifeType: "SPOUSE", ageAtEntry: 36, bandId: "sp-18-55-10k", premium: "38.05", premiumCents: 3805, sumAssured: "10000.00" },
      { ref: "child-1", lifeType: "CHILD", ageAtEntry: 10, bandId: "ch-0-13-5k", premium: "9.75", premiumCents: 975, sumAssured: "5000.00" },
    ])
    // 159.90 + 38.05 + 9.75 = 207.70
    expect(result.totalPremium).toBe("207.70")
    expect(result.totalPremiumCents).toBe(20770)
    expect(result.totalSumAssured).toBe("40000.00")
  })

  it("derives age from the caller's effective date, not from today", () => {
    // Same main member, quoted a day before their birthday: one band younger.
    const earlier = rateQuote(AGE_BANDED_BANDS, "AGE_BANDED", [lives[0]], new Date("2026-01-09T00:00:00Z"))
    expect(earlier.perLife[0]).toMatchObject({ ageAtEntry: 39, bandId: "mm-36-55-25k" })

    const atThirtySix = rateQuote(AGE_BANDED_BANDS, "AGE_BANDED", [lives[0]], new Date("2022-01-10T00:00:00Z"))
    expect(atThirtySix.perLife[0]).toMatchObject({ ageAtEntry: 36, bandId: "mm-36-55-25k" })

    const atThirtyFive = rateQuote(AGE_BANDED_BANDS, "AGE_BANDED", [lives[0]], new Date("2022-01-09T00:00:00Z"))
    expect(atThirtyFive.perLife[0]).toMatchObject({ ageAtEntry: 35, bandId: "mm-18-35-25k" })
  })

  it("fails the whole quote when any one life cannot be rated, and exposes no total", () => {
    const withUnrateable = [
      ...lives,
      { ref: "gran", lifeType: "EXTENDED_FAMILY" as const, dateOfBirth: new Date("1948-05-05T00:00:00Z"), sumAssured: "10000.00" },
    ]
    const result = rateQuote(AGE_BANDED_BANDS, "AGE_BANDED", withUnrateable, effectiveDate)

    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty("totalPremium")
    expect(result.failures).toEqual([
      expect.objectContaining({ ref: "gran", lifeType: "EXTENDED_FAMILY", ageAtEntry: 78, reason: "NO_MATCHING_BAND" }),
    ])
    // The lives that did rate are still reported, for the operator's diagnosis.
    expect(result.perLife).toHaveLength(3)
  })

  it("treats a quote with no lives as a failure, never a R0.00 quote", () => {
    const result = rateQuote(AGE_BANDED_BANDS, "AGE_BANDED", [], effectiveDate)
    expect(result.ok).toBe(false)
    expect(result.failures).toEqual([expect.objectContaining({ reason: "NO_LIVES" })])
  })

  it("reports a duplicate life ref rather than silently overwriting one", () => {
    const result = rateQuote(AGE_BANDED_BANDS, "AGE_BANDED", [lives[0], lives[0]], effectiveDate)
    expect(result.ok).toBe(false)
    expect(result.failures).toEqual([expect.objectContaining({ reason: "DUPLICATE_LIFE_REF", ref: "main" })])
  })

  it("collects every failing life, not just the first", () => {
    const twoBad = [
      { ref: "a", lifeType: "EXTENDED_FAMILY" as const, dateOfBirth: new Date("1960-01-01T00:00:00Z"), sumAssured: "10000.00" },
      { ref: "b", lifeType: "CHILD" as const, dateOfBirth: new Date("1990-01-01T00:00:00Z"), sumAssured: "5000.00" },
    ]
    const result = rateQuote(AGE_BANDED_BANDS, "AGE_BANDED", twoBad, effectiveDate)
    expect(result.failures.map((f) => f.ref)).toEqual(["a", "b"])
  })

  it("sums a PER_MILLE quote from per-life rounded premiums", () => {
    const perMilleLives = [
      { ref: "main", lifeType: "MAIN_MEMBER" as const, dateOfBirth: new Date("1986-01-10T00:00:00Z"), sumAssured: "150000.00" },
      { ref: "spouse", lifeType: "SPOUSE" as const, dateOfBirth: new Date("1990-03-02T00:00:00Z"), sumAssured: "1001.00" },
    ]
    const result = rateQuote(PER_MILLE_BANDS, "PER_MILLE", perMilleLives, effectiveDate)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected a rated quote")
    // main is 40 at the effective date, so pm-mm-18-40 applies:
    // 3.30 x 150 000 / 1000 = 495.00; spouse 5.50 x 1 001 / 1000 = 5.5055 -> 5.51
    expect(result.perLife.map((l) => l.premium)).toEqual(["495.00", "5.51"])
    expect(result.totalPremium).toBe("500.51")
    expect(result.totalSumAssured).toBe("151001.00")
  })
})
