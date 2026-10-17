import { describe, expect, it } from "vitest"
import { normaliseAffordabilityDebts, totalAffordabilityDebt, type AffordabilityDebtInput } from "./snapshot"
import { withOwnLenderDebts, type OwnLenderDebts } from "./own-lender-debt"

const own: OwnLenderDebts = {
  lenderNames: ["Fair Score", "Fair Score Finance (Pty) Ltd"],
  loans: [
    { id: "loan-1", reference: "LN-0001", status: "ACTIVE", instalmentCents: 254_100, outstandingPrincipal: 2_713_391, daysInArrears: 27, arrearsAmount: 84_330 },
    { id: "loan-2", reference: "LN-0002", status: "PENDING_WRITE_OFF", instalmentCents: 50_000, outstandingPrincipal: 300_000, daysInArrears: 120, arrearsAmount: 150_000 },
  ],
}
const OWN_TOTAL = 254_100 + 50_000
const STORE: AffordabilityDebtInput = { sourceId: "d1", provider: "Store account", type: "RETAIL", balance: 0, monthlyInstalment: 87_000 }
const counted = (debts: AffordabilityDebtInput[]) => totalAffordabilityDebt(normaliseAffordabilityDebts(withOwnLenderDebts(debts, own)))
const row = (change: Partial<AffordabilityDebtInput>): AffordabilityDebtInput => ({ provider: "Someone", type: "PERSONAL_LOAN", balance: 0, ...change })

describe("own-lender loans in the declared debt lists", () => {
  it("counts every own loan on top of unrelated declarations", () => {
    expect(counted([STORE])).toBe(87_000 + OWN_TOTAL)
  })

  it("never lets a declaration by loan reference or id lower the counted instalment", () => {
    // A R1 declaration against LN-0001 used to suppress the R2,541 loan entirely.
    expect(counted([STORE, row({ sourceId: "LN-0001", monthlyInstalment: 100 })])).toBe(87_000 + OWN_TOTAL)
    expect(counted([STORE, row({ sourceId: "loan-1", monthlyInstalment: 100 })])).toBe(87_000 + OWN_TOTAL)
    // A larger declaration counts as declared: max(declared, instalment).
    expect(counted([STORE, row({ sourceId: "LN-0001", monthlyInstalment: 300_000 })])).toBe(87_000 + 300_000 + 50_000)
  })

  it("strips a supplied own-loan sourceId instead of treating it as the lender's entry", () => {
    expect(counted([STORE, row({ sourceId: "own-loan:loan-1", monthlyInstalment: 100 })])).toBe(87_000 + 100 + OWN_TOTAL)
  })

  it("recognises the lender only by an exact trading or legal name", () => {
    // Exact (normalised) name: covers the own loans, max rule.
    expect(counted([STORE, row({ provider: "FAIR SCORE", monthlyInstalment: 254_100 })])).toBe(87_000 + OWN_TOTAL)
    expect(counted([STORE, row({ provider: "Fair Score Finance (Pty) Ltd", monthlyInstalment: 100 })])).toBe(87_000 + OWN_TOTAL)
    // Substrings in either direction are other creditors, not this lender.
    expect(counted([STORE, row({ provider: "Fair", monthlyInstalment: 254_100 })])).toBe(87_000 + 254_100 + OWN_TOTAL)
    expect(counted([STORE, row({ provider: "Fair Score Clothing Store", monthlyInstalment: 254_100 })])).toBe(87_000 + 254_100 + OWN_TOTAL)
  })
})
