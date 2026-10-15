import { describe, expect, it } from "vitest"
import { computeNonNcaCharges, type NonNcaChargeInput } from "./non-nca-charges"

const d = (ymd: string) => new Date(`${ymd}T12:00:00+02:00`)
const instalment = (dueDate: string) => ({
  dueDate: d(dueDate), principalDue: 100_000, interestDue: 10_000, feesDue: 0, totalDue: 110_000,
})
// The agreement of non-nca-charges.test.ts: two instalments, default interest, a R250 collection fee.
const base: NonNcaChargeInput = {
  schedule: [instalment("2026-01-31"), instalment("2026-02-28")],
  receipts: [],
  interestRatePm: 0.01,
  maturityDate: d("2026-02-28"),
  asOf: d("2026-03-10"),
  defaultInterestMargin: 0.02,
  collectionFeeCents: 25_000,
}
const cost = { id: "cost-1", date: d("2026-03-02"), amount: 40_000 }

describe("computeNonNcaCharges — a recovery's charged costs", () => {
  it("posts the whole cost on its day (no cap on a NON_NCA agreement), owed as a fee", () => {
    const huge = computeNonNcaCharges({ ...base, recoveryCosts: [{ ...cost, amount: 90_000_000 }] })
    expect(huge.postings).toContainEqual({ type: "RECOVERY_COST", day: "2026-03-02", amount: 90_000_000, sourceId: "cost-1" })
    const result = computeNonNcaCharges({ ...base, recoveryCosts: [cost] })
    expect(result.feesAccrued - computeNonNcaCharges(base).feesAccrued).toBe(40_000)
  })

  it("is not stopped by the freeze, which still stops the interest", () => {
    const frozen = computeNonNcaCharges({ ...base, recoveryCosts: [cost], pauses: [{ from: d("2026-03-02"), until: d("2026-03-31") }] })
    expect(frozen.postings.filter((p) => p.type === "RECOVERY_COST")).toHaveLength(1)
    expect(frozen.interestAccrued).toBeLessThan(computeNonNcaCharges(base).interestAccrued)
  })

  it("is paid before principal by a later receipt, like a fee", () => {
    const receipts = [{ id: "r1", amount: 150_000, receivedAt: d("2026-03-05") }]
    const withCost = computeNonNcaCharges({ ...base, receipts, recoveryCosts: [cost] })
    const without = computeNonNcaCharges({ ...base, receipts })
    expect(withCost.receiptSplits[0].toFees - without.receiptSplits[0].toFees).toBe(40_000)
    expect(without.scheduleAllocated - withCost.scheduleAllocated).toBe(40_000)
  })

  it("is not posted to a loan the day's receipts have settled, and not outside the charge window", () => {
    const settling = [{ id: "r1", amount: 400_000, receivedAt: d("2026-03-02") }]
    expect(computeNonNcaCharges({ ...base, receipts: settling, recoveryCosts: [cost] }).postings.some((p) => p.type === "RECOVERY_COST")).toBe(false)
    expect(computeNonNcaCharges({ ...base, recoveryCosts: [cost], accrueUntil: d("2026-03-02") }).postings.some((p) => p.type === "RECOVERY_COST")).toBe(false)
    expect(computeNonNcaCharges({ ...base, recoveryCosts: [cost], asOf: d("2026-03-01") }).postings.some((p) => p.type === "RECOVERY_COST")).toBe(false)
  })

  it("is identical to no costs when the list is absent or empty", () => {
    expect(computeNonNcaCharges({ ...base, recoveryCosts: [] })).toEqual(computeNonNcaCharges(base))
  })
})
