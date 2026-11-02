import { describe, expect, it } from "vitest"
import { computeDefaultCharges } from "@/lib/loan/default-charges"
import { d, input } from "@/lib/loan/default-charges.test-helpers"
import { loanTermsRateHistory } from "./rate-history"

const start = new Date("2026-01-10T08:00:00+02:00")
const row = (sequence: number, interestRatePm: number, createdAt: string, referenceEffectiveDate: string | null = null) => ({ sequence, interestRatePm, createdAt: new Date(createdAt), referenceEffectiveDate: referenceEffectiveDate ? new Date(referenceEffectiveDate) : null })

describe("loanTermsRateHistory", () => {
  it("is null while the loan has one rate, so nothing changes for it", () => {
    expect(loanTermsRateHistory([row(1, 0.02, "2026-01-10T08:00:00Z")], start)).toBeNull()
    expect(loanTermsRateHistory([], start)).toBeNull()
    expect(loanTermsRateHistory(undefined, start)).toBeNull()
  })

  it("starts at the loan's start, and takes the later of the reference's day and the day the row was written", () => {
    const history = loanTermsRateHistory([row(2, 0.03, "2026-06-01T01:00:00Z", "2026-05-01"), row(1, 0.02, "2026-01-05T08:00:00Z", "2025-12-01"), row(3, 0.04, "2026-07-01T01:00:00Z", "2026-08-01")], start)!
    expect(history.map((h) => h.effectiveDate.toISOString().slice(0, 10))).toEqual(["2026-01-10", "2026-06-01", "2026-08-01"])
    expect(history.map((h) => Math.round(h.annualRate * 100) / 100)).toEqual([0.24, 0.36, 0.48])
  })
})

describe("default interest on a loan whose rate moved", () => {
  const accrued = (over: Parameters<typeof input>[0]) => computeDefaultCharges(input(over)).interestAccrued
  const asOf = d("2026-09-21")

  it("keeps each closed day at the rate of that day, and adding a later day does not restate the earlier ones", () => {
    const before = accrued({ interestRatePm: 0.02, asOf: d("2026-09-11") })
    const history = [{ effectiveDate: d("2026-01-01"), annualRate: 0.24 }, { effectiveDate: d("2026-09-11"), annualRate: 0.36 }]
    expect(accrued({ interestRatePm: 0.03, rateHistory: history, asOf: d("2026-09-11") })).toBe(before)
    const rest = accrued({ interestRatePm: 0.03, rateHistory: history, asOf })
    expect(rest).toBeGreaterThan(before)
    expect(rest).toBeLessThan(accrued({ interestRatePm: 0.03, asOf }))
  })

  it("is what it was with no history", () => {
    expect(accrued({ interestRatePm: 0.03, asOf })).toBe(accrued({ interestRatePm: 0.03, rateHistory: undefined, asOf }))
  })
})
