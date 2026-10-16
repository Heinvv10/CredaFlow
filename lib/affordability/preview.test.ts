import { describe, expect, it } from "vitest"
import { previewAffordability } from "./preview"

const base = { monthlyIncomeCents: 2_000_000, monthlyExpensesCents: 800_000, clientDebtTotalCents: 0, proposedInstalmentCents: 300_000 }

describe("previewAffordability", () => {
  it("takes the larger of the application's and the client's declared debts", () => {
    expect(previewAffordability({ ...base, applicationDebtInstalmentsCents: [100_000, 50_000], clientDebtTotalCents: 120_000 }).totalExistingDebt).toBe(150_000)
    expect(previewAffordability({ ...base, applicationDebtInstalmentsCents: [100_000], clientDebtTotalCents: 400_000 }).totalExistingDebt).toBe(400_000)
  })

  it("ignores negative or missing instalments and rounds to cents", () => {
    expect(previewAffordability({ ...base, applicationDebtInstalmentsCents: [-500, Number.NaN, 100.4] }).totalExistingDebt).toBe(100)
  })

  it("is unaffordable once the instalment leaves no disposable income", () => {
    const tight = previewAffordability({ ...base, applicationDebtInstalmentsCents: [1_000_000] })
    expect(tight.ndiAfterLoan).toBe(2_000_000 - 800_000 - 1_000_000 - 300_000)
    expect(tight.isAffordable).toBe(false)
    expect(previewAffordability({ ...base, applicationDebtInstalmentsCents: [] }).isAffordable).toBe(true)
  })
})
