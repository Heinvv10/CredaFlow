import { describe, expect, it } from "vitest"
import { arrearsWithCharges } from "./charge-labels"

describe("arrearsWithCharges", () => {
  it("adds the default charges owed to the schedule arrears shown to people", () => {
    expect(arrearsWithCharges({ arrearsAmount: 169_900, chargesOutstanding: 12_448 }, true)).toBe(182_348)
    expect(arrearsWithCharges({ arrearsAmount: 169_900, chargesOutstanding: 0 }, true)).toBe(169_900)
  })

  it("ignores the stored charges once the tenant has switched charges off (kill switch)", () => {
    expect(arrearsWithCharges({ arrearsAmount: 169_900, chargesOutstanding: 12_448 }, false)).toBe(169_900)
  })
})
