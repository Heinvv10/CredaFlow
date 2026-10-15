import { describe, expect, it } from "vitest"
import { computeNonNcaCharges, type NonNcaChargeInput } from "./non-nca-charges"

const d = (ymd: string) => new Date(`${ymd}T12:00:00+02:00`)
const instalment = (dueDate: string) => ({
  dueDate: d(dueDate), principalDue: 100_000, interestDue: 10_000, feesDue: 0, totalDue: 110_000,
})
// The same agreement as non-nca-charges.test.ts: 14% a year default rate, R250 collection fee.
const base: NonNcaChargeInput = {
  schedule: [instalment("2026-01-31"), instalment("2026-02-28"), instalment("2026-03-31")],
  receipts: [],
  interestRatePm: 0.01,
  maturityDate: d("2026-03-31"),
  asOf: d("2026-03-10"),
  defaultInterestMargin: 0.02,
  collectionFeeCents: 25_000,
}

describe("computeNonNcaCharges — pauses", () => {
  it("is identical to no pauses when the list is absent or empty", () => {
    expect(computeNonNcaCharges({ ...base, pauses: [] })).toEqual(computeNonNcaCharges(base))
  })

  it("accrues nothing on paused days, and resumes after", () => {
    // Unpaused: Feb 28 x 110000 x 0.14/365 = 1181.37 -> 1181, then Mar 1..9 -> 760 (total 1941).
    // Pausing Feb 10..19 (10 days) leaves 18 x 110000 x 0.14/365 = 759.45 in
    // Feb; March is unchanged at 759.45, so the total 1518.90 -> 1519.
    const result = computeNonNcaCharges({ ...base, pauses: [{ from: d("2026-02-10"), until: d("2026-02-19") }] })
    expect(result.postings).toEqual([
      { type: "COLLECTION_FEE", day: "2026-02-01", amount: 25_000 },
      { type: "DEFAULT_INTEREST", day: "2026-02-28", amount: 759 },
      { type: "COLLECTION_FEE", day: "2026-03-01", amount: 25_000 },
      { type: "DEFAULT_INTEREST", day: "2026-03-09", amount: 760 },
    ])
    expect(result.interestAccrued).toBe(1_519)
  })

  it("a collection fee falling on a paused day is not charged", () => {
    const result = computeNonNcaCharges({ ...base, pauses: [{ from: d("2026-03-01"), until: d("2026-03-03") }] })
    expect(result.postings.filter((p) => p.type === "COLLECTION_FEE")).toEqual([
      { type: "COLLECTION_FEE", day: "2026-02-01", amount: 25_000 },
    ])
    expect(result.feesAccrued).toBe(25_000)
  })

  it("a pause covering the whole arrears so far charges nothing", () => {
    const result = computeNonNcaCharges({ ...base, pauses: [{ from: d("2026-01-01"), until: d("2026-03-31") }] })
    expect(result.postings).toEqual([])
    expect(result).toMatchObject({ interestAccrued: 0, feesAccrued: 0 })
  })

  it("receipts are still allocated on a paused day", () => {
    const result = computeNonNcaCharges({
      ...base,
      receipts: [{ id: "r1", amount: 60_000, receivedAt: d("2026-02-11") }],
      pauses: [{ from: d("2026-02-10"), until: d("2026-02-19") }],
    })
    expect(result.receiptSplits.map((s) => s.receiptId)).toEqual(["r1"])
    expect(result.unallocated).toBe(0)
  })
})
