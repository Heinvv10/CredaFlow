import { describe, it, expect } from "vitest"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"

// income 20000, expenses 8000 -> discretionary 12000 (all cents ×100)
const base = {
  monthlyIncomeCents: 2_000_000, monthlyExpensesCents: 800_000,
  declaredDebtCents: 100_000, bureauObligationsCents: 100_000,
  proposedInstalmentCents: 300_000, ndiBufferPct: 110,
}

describe("evaluateAffordabilityGate", () => {
  it("passes when NDI covers instalment × buffer", () => {
    // NDI = 1_200_000 - 100_000 = 1_100_000; required = 300_000 * 1.1 = 330_000
    expect(evaluateAffordabilityGate(base).blocked).toBe(false)
  })
  it("uses max(declared, bureau) as the debt", () => {
    // bureau 900_000 > declared 100_000 -> NDI = 1_200_000 - 900_000 = 300_000
    // required = 330_000 -> blocked
    const r = evaluateAffordabilityGate({ ...base, bureauObligationsCents: 900_000 })
    expect(r.blocked).toBe(true)
  })
  it("blocks when NDI < instalment × buffer", () => {
    const r = evaluateAffordabilityGate({ ...base, proposedInstalmentCents: 1_100_000 })
    expect(r.blocked).toBe(true)
  })
  it("computes requiredNdi with integer-exact math, matching the DB guard's NUMERIC ceil", () => {
    // 186_900 × 110 / 100 = 205_590 exactly. Float-first math
    // (186_900 * (110 / 100)) lands an epsilon above the true product, so
    // Math.ceil reports 205_591 — one cent off what the approval trigger
    // recomputes in NUMERIC, which rejects the entire approval evidence.
    const r = evaluateAffordabilityGate({
      monthlyIncomeCents: 2_800_000, monthlyExpensesCents: 1_200_000,
      declaredDebtCents: 0, bureauObligationsCents: 0,
      proposedInstalmentCents: 186_900, ndiBufferPct: 110,
    })
    expect(r.requiredNdi).toBe(205_590)
    expect(evaluateAffordabilityGate(base).requiredNdi).toBe(330_000)
  })
  it("blocks on the 70% discretionary-income ratio even when NDI clears the buffer", () => {
    // income 1_000_000, no expenses/debt -> discretionary 1_000_000, NDI 1_000_000.
    // instalment 800_000 -> required NDI = ceil(800_000 × 1.1) = 880_000 (NDI clears it),
    // but ratio = 800_000 / 1_000_000 = 0.8 > 0.7 -> must block on the ratio branch.
    const r = evaluateAffordabilityGate({
      monthlyIncomeCents: 1_000_000, monthlyExpensesCents: 0,
      declaredDebtCents: 0, bureauObligationsCents: 0,
      proposedInstalmentCents: 800_000, ndiBufferPct: 110,
    })
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/70%/)
  })
})
