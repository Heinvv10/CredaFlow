import { describe, expect, it } from "vitest"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
import { liveAffordability, snapshotAffordability } from "./affordability-facts"

const base = { monthlyIncomeCents: 2_000_000, monthlyExpensesCents: 800_000, declaredDebtCents: 100_000, bureauObligationsCents: 300_000, proposedInstalmentCents: 150_000, ndiBufferPct: 110, expensesBelowMinimum: false }

describe("liveAffordability: the staff approval gate's own arithmetic", () => {
  it("takes the higher of declared and bureau debt, as the approval does", () => {
    const f = liveAffordability(base)
    expect(f.monthlyDebtCents).toBe(300_000)
    expect(f.ndiCents).toBe(900_000)
  })

  it("agrees with evaluateAffordabilityGate on whether the application passes, at the edge", () => {
    for (const instalment of [100_000, 818_181, 818_182, 900_000, 1_100_000]) {
      const gate = evaluateAffordabilityGate({ monthlyIncomeCents: base.monthlyIncomeCents, monthlyExpensesCents: base.monthlyExpensesCents, declaredDebtCents: base.declaredDebtCents, bureauObligationsCents: base.bureauObligationsCents, proposedInstalmentCents: instalment, ndiBufferPct: base.ndiBufferPct })
      expect(liveAffordability({ ...base, proposedInstalmentCents: instalment }).affordabilityGatePasses, `instalment ${instalment}`).toBe(!gate.blocked)
    }
  })

  it("does not round: cover and debt-to-income keep their fractions", () => {
    const f = liveAffordability({ ...base, proposedInstalmentCents: 700_000 })
    expect(f.ndiCoverPct).toBeCloseTo((900_000 / 700_000) * 100, 10)
    expect(f.ndiCoverPct).not.toBe(Math.round(f.ndiCoverPct!))
    expect(f.dtiPct).toBeCloseTo(((300_000 + 700_000) / 2_000_000) * 100, 10)
  })

  it("a 109.99% cover is below a 110% threshold (rounding it to 110 would let it through)", () => {
    // ndi 1_099_900 over an instalment of 1_000_000 is 109.99%.
    const f = liveAffordability({ ...base, monthlyIncomeCents: 2_199_900, monthlyExpensesCents: 800_000, declaredDebtCents: 300_000, bureauObligationsCents: 0, proposedInstalmentCents: 1_000_000 })
    expect(f.ndiCoverPct).toBeLessThan(110)
    expect(f.ndiCoverPct).toBeCloseTo(109.99, 6)
  })

  it("without an instalment the facts that need one are missing, not zero", () => {
    const f = liveAffordability({ ...base, proposedInstalmentCents: null })
    expect(f).toMatchObject({ ndiCents: 900_000, ndiCoverPct: null, dtiPct: null, affordabilityGatePasses: null })
  })

  it("without income debt-to-income is missing", () => {
    expect(liveAffordability({ ...base, monthlyIncomeCents: 0 }).dtiPct).toBeNull()
  })

  it("carries the Regulation 23A flag through", () => {
    expect(liveAffordability({ ...base, expensesBelowMinimum: true }).expensesBelowMinimum).toBe(true)
  })
})

describe("snapshotAffordability: a historical decision's own recorded numbers", () => {
  const snapshot = {
    inputs: { monthlyIncomeCents: 2_000_000, declaredDebtCents: 100_000, bureauObligationsCents: 300_000 },
    outcome: { netDisposableIncomeCents: 900_000, ndiAfterLoanCents: 750_000, requiredNdiCents: 165_000, isAffordable: true },
    expenses: { mle: { belowMinimum: false } },
  }
  it("reads ndi, the instalment it was gated on and the verdict from the snapshot", () => {
    const f = snapshotAffordability(snapshot as never)
    expect(f).toMatchObject({ monthlyDebtCents: 300_000, ndiCents: 900_000, affordabilityGatePasses: true, expensesBelowMinimum: false, instalmentCents: 150_000 })
    expect(f.ndiCoverPct).toBeCloseTo(600, 10)
    expect(f.dtiPct).toBeCloseTo(((300_000 + 150_000) / 2_000_000) * 100, 10)
  })
})
