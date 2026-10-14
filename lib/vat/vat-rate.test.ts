import { describe, expect, it } from "vitest"
import { NoVatRateError, rateOn, rateTenThousandthsOf, type VatRateRow } from "./vat-rate"

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

// The migration's seed row, plus a hypothetical later change (not a real
// rate) to exercise the boundary between two rows.
const ROWS: VatRateRow[] = [
  { effectiveDate: day("2040-01-01"), rate: "0.1700" },
  { effectiveDate: day("2018-04-01"), rate: "0.1500" },
]

describe("rateOn", () => {
  it("has no rate before the first row takes effect", () => {
    expect(() => rateOn(ROWS, "2018-03-31")).toThrow(NoVatRateError)
  })

  it("applies a rate from its effective date, inclusive", () => {
    expect(rateOn(ROWS, "2018-04-01")).toEqual({ effectiveDate: "2018-04-01", rate: "0.1500", rateTenThousandths: 1500 })
  })

  it("keeps the rate until the day before the next row, whatever the row order", () => {
    expect(rateOn(ROWS, "2039-12-31").rateTenThousandths).toBe(1500)
    expect(rateOn(ROWS, "2040-01-01").rateTenThousandths).toBe(1700)
  })

  it("refuses an empty table and a date that is not a calendar date", () => {
    expect(() => rateOn([], "2026-10-13")).toThrow(NoVatRateError)
    expect(() => rateOn(ROWS, "2026-02-30")).toThrow(RangeError)
  })
})

describe("rateTenThousandthsOf", () => {
  it("converts a four-place rate exactly", () => {
    expect(rateTenThousandthsOf("0.1500")).toBe(1500)
    expect(rateTenThousandthsOf("0.0001")).toBe(1)
  })

  it.each([["0.15005"], ["-0.01"], ["1"]])("refuses %s", (rate) => {
    expect(() => rateTenThousandthsOf(rate)).toThrow(RangeError)
  })
})
