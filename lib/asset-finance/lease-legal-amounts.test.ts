import { describe, expect, it } from "vitest"
import { cpaCancellationCharge, totalLossAmount } from "./lease-termination"

const rentals = [{ dueDate: "2027-02-01", rentalExclVatCents: 100_000 }, { dueDate: "2027-03-01", rentalExclVatCents: 100_000 }]
const base = { rentals, terminationDate: "2027-01-01", annualRate: 0.12 }
describe("CPA Reg 5 cancellation charge", () => {
  it("credits the goods and adds only documented actual costs; ignores any contractual percentage", () => {
    const amount = cpaCancellationCharge({ ...base, goodsValueCents: 150_000, costs: [{ amountCents: 5_000, description: "Recovery", evidence: "synthetic-evidence.pdf" }] })
    expect(amount.pvCents).toBeLessThan(200_000)
    expect(amount.chargeCents).toBe(amount.pvCents - 150_000 + 5_000)
  })
  it("floors at zero and caps below the undiscounted remaining rentals", () => {
    expect(cpaCancellationCharge({ ...base, goodsValueCents: 500_000, costs: [] }).chargeCents).toBe(0)
    expect(cpaCancellationCharge({ ...base, goodsValueCents: 0, costs: [{ amountCents: 50_000, description: "Refurbishment", evidence: "synthetic.pdf" }] }).chargeCents).toBe(199_999)
  })
  it("refuses undocumented costs and invalid valuation", () => {
    expect(() => cpaCancellationCharge({ ...base, goodsValueCents: -1, costs: [] })).toThrow()
    expect(() => cpaCancellationCharge({ ...base, goodsValueCents: 1, costs: [{ amountCents: 1, description: "Recovery", evidence: "" }] })).toThrow()
  })
})
describe("total loss", () => {
  it("arrears + PV less insurer payment, without a penalty, floored at zero", () => {
    const loss = totalLossAmount({ ...base, arrearsCents: 12_000, insuranceProceedsCents: 150_000 })
    expect(loss.totalCents).toBe(loss.pvCents + 12_000 - 150_000)
    expect(totalLossAmount({ ...base, arrearsCents: 0, insuranceProceedsCents: 999_999 }).totalCents).toBe(0)
  })
})
