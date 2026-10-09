import { describe, expect, it } from "vitest"
import { chargesOwing, chargesOwingByBand } from "./charges-owing"

const loan = (daysInArrears: number, chargesOutstanding: number) => ({ daysInArrears, chargesOutstanding })

describe("chargesOwing", () => {
  it("is the synced figure while charges are live, and 0 otherwise", () => {
    expect(chargesOwing(loan(12, 4_500), true)).toBe(4_500)
    expect(chargesOwing(loan(12, 4_500), false)).toBe(0)
  })
})

describe("chargesOwingByBand", () => {
  const loans = [
    loan(1, 100), loan(30, 200), // 1-30
    loan(31, 400), // 31-60
    loan(89, 800), // 61-89
    loan(90, 1_600), loan(200, 3_200), // 90+
    loan(0, 6_400), loan(0, 12_800), // schedule paid up, charges still owed
    loan(15, 0),
  ]

  it("sums charges into the same DPD bands as instalment arrears", () => {
    const result = chargesOwingByBand(loans, true)
    expect(result.byBand).toEqual({
      "1-30 DPD": 300,
      "31-60 DPD": 400,
      "61-89 DPD": 800,
      "90+ DPD": 4_800,
    })
  })

  it("reports charges on loans with no instalment arrears separately, so the total still ties", () => {
    const result = chargesOwingByBand(loans, true)
    expect(result.notInArrears).toEqual({ count: 2, amount: 19_200 })
    expect(result.total).toBe(300 + 400 + 800 + 4_800 + 19_200)
  })

  it("shows nothing while charges are not live, whatever the stored column holds", () => {
    const result = chargesOwingByBand(loans, false)
    expect(Object.values(result.byBand)).toEqual([0, 0, 0, 0])
    expect(result.notInArrears).toEqual({ count: 0, amount: 0 })
    expect(result.total).toBe(0)
  })
})
