import { describe, expect, it } from "vitest"
import { previewAffordability } from "./preview"

const base = { monthlyIncomeCents: 2_000_000, monthlyExpensesCents: 800_000, clientDebtTotalCents: 0, ownLenderInstalmentsCents: 0, proposedInstalmentCents: 300_000 }

describe("previewAffordability", () => {
  it("takes the larger of the application's and the client's declared debts", () => {
    expect(previewAffordability({ ...base, applicationDebtInstalmentsCents: [100_000, 50_000], clientDebtTotalCents: 120_000 }).totalExistingDebt).toBe(150_000)
    expect(previewAffordability({ ...base, applicationDebtInstalmentsCents: [100_000], clientDebtTotalCents: 400_000 }).totalExistingDebt).toBe(400_000)
  })

  // #138 merge: the obligations to this lender count on the application's side,
  // as the server adds them (components/applications/OwnLenderDebtRows.tsx).
  it("adds the obligations to this lender to the application's debts before taking the larger", () => {
    const withOwn = { ...base, applicationDebtInstalmentsCents: [87_000], ownLenderInstalmentsCents: 254_100 }
    expect(previewAffordability({ ...withOwn, clientDebtTotalCents: 300_000 }).totalExistingDebt).toBe(341_100)
    expect(previewAffordability({ ...withOwn, clientDebtTotalCents: 400_000 }).totalExistingDebt).toBe(400_000)
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
