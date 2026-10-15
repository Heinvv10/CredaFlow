import { describe, expect, it } from "vitest"
import { computeDefaultCharges } from "./default-charges"
import { d, input } from "./default-charges.test-helpers"

// R2,000 MICRO30 bullet due 1 Sep, 5% pm: each completed day of default is
// 200000 x 5% / 30 = R3.33, so Sep 2..10 (asOf the 11th) is R30.00 in all.
const asOf = d("2026-09-11")

describe("computeDefaultCharges — pauses", () => {
  it("is identical to no pauses when the list is absent or empty", () => {
    const without = computeDefaultCharges(input({ asOf }))
    expect(computeDefaultCharges(input({ asOf, pauses: [] }))).toEqual(without)
    expect(without.interestAccrued).toBe(3_000)
  })

  it("accrues nothing on paused days: before and after unchanged, resumes after", () => {
    // Sep 2..10 is 9 days; pausing Sep 4..6 leaves 6 days = R20.00.
    const result = computeDefaultCharges(input({ asOf, pauses: [{ from: d("2026-09-04"), until: d("2026-09-06") }] }))
    expect(result.interestAccrued).toBe(2_000)
    expect(result.postings).toEqual([{ type: "DEFAULT_INTEREST", day: "2026-09-10", amount: 2_000 }])
    // Only days before the pause: Sep 2..3 is 2 days.
    expect(computeDefaultCharges(input({ asOf: d("2026-09-04") })).interestAccrued).toBe(667)
    expect(computeDefaultCharges(input({ asOf: d("2026-09-04"), pauses: [{ from: d("2026-09-04"), until: d("2026-09-06") }] })).interestAccrued).toBe(667)
  })

  it("a pause covering the whole arrears so far accrues nothing", () => {
    const result = computeDefaultCharges(input({ asOf, pauses: [{ from: d("2026-08-01"), until: d("2026-09-30") }] }))
    expect(result.postings).toEqual([])
    expect(result).toMatchObject({ interestAccrued: 0, feesAccrued: 0 })
  })

  it("a Section 129 letter dated in the pause is not charged", () => {
    const letter = { id: "l1", date: d("2026-09-05"), amount: 9_700 }
    expect(computeDefaultCharges(input({ asOf, adminCharges: [letter] })).feesAccrued).toBe(9_700)
    const paused = computeDefaultCharges(input({ asOf, adminCharges: [letter], pauses: [{ from: d("2026-09-05"), until: d("2026-09-05") }] }))
    expect(paused.feesAccrued).toBe(0)
    expect(paused.postings.map((p) => p.type)).toEqual(["DEFAULT_INTEREST"])
  })

  it("the post-maturity service fee on a paused 1st is not charged", () => {
    const asOfOct = d("2026-10-05")
    const live = computeDefaultCharges(input({ asOf: asOfOct, monthlyServiceFee: 6_900 }))
    expect(live.postings.filter((p) => p.type === "SERVICE_FEE")).toEqual([{ type: "SERVICE_FEE", day: "2026-10-01", amount: 6_900 }])
    const paused = computeDefaultCharges(input({
      asOf: asOfOct, monthlyServiceFee: 6_900, pauses: [{ from: d("2026-10-01"), until: d("2026-10-02") }],
    }))
    expect(paused.postings.filter((p) => p.type === "SERVICE_FEE")).toEqual([])
  })

  it("receipts are still allocated on a paused day", () => {
    const receipts = [{ id: "r1", amount: 100_000, receivedAt: d("2026-09-05") }]
    const result = computeDefaultCharges(input({ asOf, receipts, pauses: [{ from: d("2026-09-04"), until: d("2026-09-06") }] }))
    expect(result.receiptSplits.map((s) => s.receiptId)).toEqual(["r1"])
    expect(result.receiptSplits[0].toSchedule + result.receiptSplits[0].toDefaultInterest + result.receiptSplits[0].toFees).toBe(100_000)
  })

  describe("in duplum (s103(5)) still holds", () => {
    // Cap = the R2,000 principal when the default began; at about R3.33 a day it is
    // reached after about 600 days (spring 2028).
    const farOut = d("2028-05-31")

    it("without a pause the cap is reached and stops the accrual", () => {
      const result = computeDefaultCharges(input({ asOf: farOut }))
      expect(result.interestAccrued).toBe(200_000)
      expect(result.inDuplum).toMatchObject({ capBase: 200_000, reached: true })
    })

    it("a pause delays the cap: fewer days accrue and it is not yet reached", () => {
      const result = computeDefaultCharges(input({ asOf: farOut, pauses: [{ from: d("2027-01-01"), until: d("2027-03-01") }] }))
      expect(result.interestAccrued).toBeLessThan(200_000)
      expect(result.interestAccrued).toBeGreaterThan(180_000)
      expect(result.inDuplum?.reached).toBe(false)
    })

    it("a pause never lets accrual pass the cap", () => {
      const result = computeDefaultCharges(input({ asOf: d("2030-01-01"), pauses: [{ from: d("2027-01-01"), until: d("2027-01-30") }] }))
      expect(result.interestAccrued + result.feesAccrued).toBeLessThanOrEqual(200_000)
      expect(result.inDuplum?.reached).toBe(true)
    })
  })
})
