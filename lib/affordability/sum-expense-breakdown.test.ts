import { describe, expect, it } from "vitest"
import { sumExpenseBreakdown } from "./sum-expense-breakdown"

describe("sumExpenseBreakdown", () => {
  it("returns 0 when all fields are 0", () => {
    expect(
      sumExpenseBreakdown({
        housing: 0, transport: 0, food: 0, education: 0, insurance: 0,
        clothing: 0, entertainment: 0, medical: 0, other: 0,
      }),
    ).toBe(0)
  })

  it("sums all nine cents fields", () => {
    expect(
      sumExpenseBreakdown({
        housing: 500_00, transport: 100_00, food: 200_00, education: 0, insurance: 50_00,
        clothing: 25_00, entertainment: 0, medical: 0, other: 0,
      }),
    ).toBe(875_00)
  })
})
