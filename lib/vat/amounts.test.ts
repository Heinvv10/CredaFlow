import { describe, expect, it } from "vitest"
import { addVat, splitInclusive, vatOnExclusive } from "./amounts"

const STANDARD = 1500 // 15%

describe("vatOnExclusive: exclusive × rate, half-up to the cent", () => {
  it.each([
    [0, 0],
    [1, 0], // 0.15
    [3, 0], // 0.45
    [4, 1], // 0.60
    [10, 2], // 1.50 exactly: half rounds up
    [30, 5], // 4.50
    [50, 8], // 7.50
    [70, 11], // 10.50
    [100, 15],
    [99_999, 15_000], // 14 999.85
    [123_456_789, 18_518_518], // 18 518 518.35
    [2_147_483_647, 322_122_547], // INTEGER max: 322 122 547.05
  ])("%i cents → %i cents VAT", (excl, vat) => {
    expect(vatOnExclusive(excl, STANDARD)).toBe(vat)
  })

  it("is zero at a zero rate", () => {
    expect(vatOnExclusive(123_456, 0)).toBe(0)
  })

  it.each([[-1], [1.5], [Number.NaN]])("refuses %s cents", (cents) => {
    expect(() => vatOnExclusive(cents, STANDARD)).toThrow(RangeError)
  })

  it.each([[-1], [10_000], [1500.5]])("refuses rate %s", (rate) => {
    expect(() => vatOnExclusive(100, rate)).toThrow(RangeError)
  })
})

describe("addVat", () => {
  it("adds the VAT to give the inclusive amount", () => {
    expect(addVat(100_000_000, STANDARD)).toEqual({ exclVatCents: 100_000_000, vatCents: 15_000_000, inclVatCents: 115_000_000 })
  })
})

describe("splitInclusive: exclusive = inclusive / (1 + rate), half-up; VAT is the rest", () => {
  it.each([
    [0, 0, 0],
    [1, 1, 0], // 0.8696 → 1
    [100, 87, 13], // 86.957 → 87
    [115, 100, 15],
    [1_150_000, 1_000_000, 150_000],
    [999_999, 869_564, 130_435], // 869 564.35 → 869 564
  ])("%i cents → %i excl + %i VAT", (incl, excl, vat) => {
    expect(splitInclusive(incl, STANDARD)).toEqual({ exclVatCents: excl, vatCents: vat, inclVatCents: incl })
  })

  it("always adds back to the inclusive amount, and agrees with addVat to within a cent", () => {
    for (let incl = 0; incl <= 20_000; incl++) {
      const split = splitInclusive(incl, STANDARD)
      expect(split.exclVatCents + split.vatCents).toBe(incl)
      expect(Math.abs(addVat(split.exclVatCents, STANDARD).inclVatCents - incl)).toBeLessThanOrEqual(1)
    }
  })
})
