import { describe, expect, it } from "vitest"
import { surrenderOutcome } from "./surrender-calculation"

describe("surrenderOutcome", () => {
  it.each([
    { settlementDueCents: 150_000, saleProceedsCents: 100_000, shortfallCents: 50_000, refundCents: 0 },
    { settlementDueCents: 150_000, saleProceedsCents: 150_000, shortfallCents: 0, refundCents: 0 },
    { settlementDueCents: 150_000, saleProceedsCents: 175_000, shortfallCents: 0, refundCents: 25_000 },
  ])("computes the mutually exclusive shortfall/refund result", (input) => {
    expect(surrenderOutcome(input)).toEqual({
      shortfallCents: input.shortfallCents,
      refundCents: input.refundCents,
    })
  })

  it.each([-1, 1.2, Number.NaN])("rejects an invalid money value", (value) => {
    expect(() => surrenderOutcome({ settlementDueCents: value, saleProceedsCents: 1 })).toThrow(RangeError)
    expect(() => surrenderOutcome({ settlementDueCents: 1, saleProceedsCents: value })).toThrow(RangeError)
  })
})
