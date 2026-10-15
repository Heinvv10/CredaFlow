import { describe, expect, it } from "vitest"
import { computeDefaultCharges } from "./default-charges"
import { d, input } from "./default-charges.test-helpers"

// R2,000 MICRO30 bullet due 1 Sep (R2,169 with its interest and fee), 5% pm: R3.33 a day of default interest.
// A recovery's charged cost is one fee posting dated the day its proceeds were applied.
const cost = { id: "cost-1", date: d("2026-09-05"), amount: 50_000 }
const asOf = d("2026-09-11")

describe("computeDefaultCharges — a recovery's charged costs", () => {
  it("posts the cost as a RECOVERY_COST fee on its day, owed like any fee", () => {
    const result = computeDefaultCharges(input({ asOf, recoveryCosts: [cost] }))
    expect(result.postings).toContainEqual({ type: "RECOVERY_COST", day: "2026-09-05", amount: 50_000, sourceId: "cost-1" })
    expect(result.feesAccrued).toBe(50_000)
    expect(result.feesOutstanding).toBe(50_000)
  })

  it("is not stopped by the recovery's freeze: a fixed cost, not an accruing charge", () => {
    const frozen = computeDefaultCharges(input({ asOf, recoveryCosts: [cost], pauses: [{ from: d("2026-09-05"), until: d("2026-09-30") }] }))
    expect(frozen.feesAccrued).toBe(50_000)
    expect(frozen.interestAccrued).toBe(1_000) // Sep 2..4 only: the interest is frozen, the cost is not
  })

  it("stays inside the in duplum headroom: what the cap refuses is not posted", () => {
    // Cap base R2,000 less the R169 of contractual interest and fee reserved less four days of interest.
    const result = computeDefaultCharges(input({ asOf, recoveryCosts: [{ ...cost, amount: 500_000 }] }))
    const posted = result.postings.find((p) => p.type === "RECOVERY_COST")
    expect(posted).toBeDefined()
    expect(posted!.amount).toBeLessThan(500_000)
    expect(posted!.amount).toBeGreaterThan(170_000)
    expect(result.inDuplum).toMatchObject({ capBase: 200_000, reached: true })
    // Once the cost has used the headroom, no more interest accrues behind it.
    expect(computeDefaultCharges(input({ asOf: d("2026-12-01"), recoveryCosts: [{ ...cost, amount: 500_000 }] })).interestAccrued).toBe(result.interestAccrued)
  })

  it("two costs on a day take the headroom in order", () => {
    const result = computeDefaultCharges(input({ asOf, recoveryCosts: [{ ...cost, id: "a", amount: 150_000 }, { ...cost, id: "b", amount: 150_000 }] }))
    const posted = result.postings.filter((p) => p.type === "RECOVERY_COST")
    expect(posted[0]).toMatchObject({ sourceId: "a", amount: 150_000 })
    expect(posted[1]!.sourceId).toBe("b")
    expect(posted[1]!.amount).toBeLessThan(150_000)
  })

  it("is not posted to a loan the day's receipts have settled: a closed loan is not re-opened", () => {
    const settling = [{ id: "r1", amount: 230_000, receivedAt: d("2026-09-05") }]
    const settled = computeDefaultCharges(input({ asOf, receipts: settling, recoveryCosts: [cost] }))
    expect(settled.postings.some((p) => p.type === "RECOVERY_COST")).toBe(false)
    expect(settled.feesOutstanding).toBe(0)
    // A receipt that leaves something owed: the cost lands after it.
    const open = computeDefaultCharges(input({ asOf, receipts: [{ id: "r1", amount: 100_000, receivedAt: d("2026-09-05") }], recoveryCosts: [cost] }))
    expect(open.postings.filter((p) => p.type === "RECOVERY_COST")).toEqual([{ type: "RECOVERY_COST", day: "2026-09-05", amount: 50_000, sourceId: "cost-1" }])
  })

  it("follows the day's receipts even when its date is earlier in the day than the receipt", () => {
    // The cost is dated by its day alone (midnight); the receipt reaches the loan at noon.
    const midnight = { ...cost, date: new Date("2026-09-05T00:00:00Z") }
    const receipts = [{ id: "r1", amount: 100_000, receivedAt: d("2026-09-05") }]
    const result = computeDefaultCharges(input({ asOf, receipts, recoveryCosts: [midnight] }))
    const without = computeDefaultCharges(input({ asOf, receipts }))
    expect(result.receiptSplits[0].toFees).toBe(without.receiptSplits[0].toFees) // the receipt did not pay the cost
    expect(result.scheduleAllocated).toBe(without.scheduleAllocated)
    expect(result.feesOutstanding - without.feesOutstanding).toBe(50_000)
  })

  it("is not charged on or after the day charges stop, nor before the first day they may start", () => {
    expect(computeDefaultCharges(input({ asOf, recoveryCosts: [cost], accrueUntil: d("2026-09-05") })).feesAccrued).toBe(0)
    expect(computeDefaultCharges(input({ asOf, recoveryCosts: [cost], accrueFrom: d("2026-09-06") })).feesAccrued).toBe(0)
  })

  it("a cost dated after the as-of day is not yet on the account", () => {
    expect(computeDefaultCharges(input({ asOf: d("2026-09-04"), recoveryCosts: [cost] })).feesAccrued).toBe(0)
  })

  it("is identical to no costs when the list is absent or empty", () => {
    const without = computeDefaultCharges(input({ asOf }))
    expect(computeDefaultCharges(input({ asOf, recoveryCosts: [] }))).toEqual(without)
  })
})
