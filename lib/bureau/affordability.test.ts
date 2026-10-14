/**
 * Bureau-derived expenses reach affordability end to end: a normalised report
 * → the stored CreditBureauCheck.obligations → bureauMonthlyObligations → the
 * approval gate, which takes max(application debts, client-record debts,
 * bureau instalments). Pure: no database, no provider.
 */
import { describe, expect, it } from "vitest"
import { bureauMonthlyObligations } from "@/lib/affordability/snapshot"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
import { reportObligations } from "./persist"
import { simulatedReport } from "./providers/simulated"
import type { BureauReport } from "./types"

const consumer = {
  monthlyIncomeCents: 3_000_000,
  monthlyExpensesCents: 1_000_000,
  proposedInstalmentCents: 150_000,
  ndiBufferPct: 110,
}

function gateWith(report: BureauReport, declaredDebtCents: number) {
  return evaluateAffordabilityGate({
    ...consumer,
    declaredDebtCents,
    bureauObligationsCents: bureauMonthlyObligations(reportObligations(report)),
  })
}

describe("bureau tradeline instalments in affordability", () => {
  it("stores the open tradelines' instalments as the bureau obligation", () => {
    // HIGH_DEBT: R9 500 + R6 200 + R1 850 + R900 open = R18 450.
    expect(bureauMonthlyObligations(reportObligations(simulatedReport("HIGH_DEBT")))).toBe(1_845_000)
    // CLEAN: the closed R1 200 personal loan is not counted.
    expect(bureauMonthlyObligations(reportObligations(simulatedReport("CLEAN")))).toBe(395_000)
  })

  it("a higher bureau instalment total lowers disposable income", () => {
    const declared = 200_000
    const clean = gateWith(simulatedReport("CLEAN"), declared)
    const heavy = gateWith(simulatedReport("HIGH_DEBT"), declared)
    expect(heavy.ndi).toBeLessThan(clean.ndi)
    expect(clean.ndi - heavy.ndi).toBe(1_845_000 - 395_000)
  })

  it("bureau debt above the declared debt wins and can turn an affordable loan into a refusal", () => {
    const declaredOnly = evaluateAffordabilityGate({ ...consumer, declaredDebtCents: 200_000, bureauObligationsCents: 0 })
    const withBureau = gateWith(simulatedReport("HIGH_DEBT"), 200_000)
    expect(declaredOnly.blocked).toBe(false)
    expect(withBureau.ndi).toBe(declaredOnly.ndi - (1_845_000 - 200_000))
    expect(withBureau.blocked).toBe(true)
  })

  it("declared debt above the bureau's still governs (the max, not a replacement)", () => {
    const clean = gateWith(simulatedReport("CLEAN"), 900_000)
    const declaredOnly = evaluateAffordabilityGate({ ...consumer, declaredDebtCents: 900_000, bureauObligationsCents: 0 })
    expect(clean.ndi).toBe(declaredOnly.ndi)
  })
})
