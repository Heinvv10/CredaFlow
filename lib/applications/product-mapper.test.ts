import { describe, expect, it } from "vitest"
import { toApplicationProduct, type LoanProductRow } from "./product-mapper"

const ROW: LoanProductRow = {
  productType: "MICRO",
  id: "p1",
  name: "30-Day Micro Loan",
  code: "MICRO30",
  minAmount: 50000,            // cents → R 500
  maxAmount: 200000,           // cents → R 2,000
  minTermDays: 7,
  maxTermDays: 30,
  interestRatePm: 0.05,
  interestModel: "FLAT",
  initiationFeeModel: "FLAT_PCT" as const,
  initiationFeePct: 0.15,
  initiationFeeMax: 100000,    // cents (stays cents on output)
  monthlyServiceFee: 0,
}

describe("toApplicationProduct", () => {
  // The headline invariant. DB stores {min,max}Amount as cents; the wizard
  // contract is rand. If anyone re-removes the /100, this test fails before
  // staging does.
  it("divides minAmount and maxAmount by 100 (cents → rand)", () => {
    const out = toApplicationProduct(ROW)
    expect(out.minAmount).toBe(500)
    expect(out.maxAmount).toBe(2000)
  })

  it("leaves initiationFeeMax and monthlyServiceFee as cents (contract preserved)", () => {
    const out = toApplicationProduct(ROW)
    expect(out.initiationFeeMax).toBe(100000)
    expect(out.monthlyServiceFee).toBe(0)
  })

  it("coerces Decimal-shaped inputs via Number()", () => {
    // Prisma Decimal columns arrive with a toString(). Number() walks through.
    const decimalRow: LoanProductRow = {
      ...ROW,
      interestRatePm: { toString: () => "0.025" },
      initiationFeeModel: "FLAT_PCT" as const,
      initiationFeePct: { toString: () => "0.02" },
    }
    const out = toApplicationProduct(decimalRow)
    expect(out.interestRatePm).toBe(0.025)
    expect(out.interestRate).toBe(0.025)
    expect(out.initiationFeePct).toBe(0.02)
  })

  it("passes term days through unchanged", () => {
    const out = toApplicationProduct(ROW)
    expect(out.minTermDays).toBe(7)
    expect(out.maxTermDays).toBe(30)
  })
})
