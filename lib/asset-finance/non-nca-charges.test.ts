import { describe, expect, it } from "vitest"
import { computeDefaultCharges } from "@/lib/loan/default-charges"
import { computeNonNcaCharges, type NonNcaChargeInput } from "./non-nca-charges"

// Midday SAST so a date never straddles the SAST/UTC day boundary.
const d = (ymd: string) => new Date(`${ymd}T12:00:00+02:00`)

// Three monthly instalments of R1,100 (R1,000 principal + R100 interest).
// Contract rate 1% pm = 12% a year; margin 2% => default rate 14% a year,
// actual/365. Collection fee R250 per missed instalment.
const instalment = (dueDate: string) => ({
  dueDate: d(dueDate), principalDue: 100_000, interestDue: 10_000, feesDue: 0, totalDue: 110_000,
})
const base: NonNcaChargeInput = {
  schedule: [instalment("2026-01-31"), instalment("2026-02-28"), instalment("2026-03-31")],
  receipts: [],
  interestRatePm: 0.01,
  maturityDate: d("2026-03-31"),
  asOf: d("2026-03-10"),
  defaultInterestMargin: 0.02,
  collectionFeeCents: 25_000,
}

describe("computeNonNcaCharges", () => {
  it("one missed instalment, then a part payment: interest → collection fee → principal", () => {
    const result = computeNonNcaCharges({
      ...base,
      receipts: [{ id: "r1", amount: 60_000, receivedAt: d("2026-02-11") }],
      asOf: d("2026-02-21"),
    })
    // Feb 1..10 on R1,100 overdue: 10 x 110000 x 0.14/365 = 421.92.
    // The receipt pays default interest 422, the instalment's interest 10000,
    // the fee 25000, then 24578 principal: row 1 has 34578, so R754.22 of
    // principal stays overdue. Feb 11..20: 10 x 75422 x 0.14/365 = 289.29.
    // Total 711.21 → 711, posted at the last completed day.
    expect(result.postings).toEqual([
      { type: "COLLECTION_FEE", day: "2026-02-01", amount: 25_000 },
      { type: "DEFAULT_INTEREST", day: "2026-02-20", amount: 711 },
    ])
    expect(result.receiptSplits).toEqual([{ receiptId: "r1", toDefaultInterest: 422, toFees: 25_000, toSchedule: 34_578 }])
    expect(result).toMatchObject({
      interestAccrued: 711, interestPaid: 422, interestOutstanding: 289,
      feesAccrued: 25_000, feesPaid: 25_000, feesOutstanding: 0,
      scheduleAllocated: 34_578, unallocated: 0, inDuplum: null,
    })
    expect(result.scheduleRows.map((row) => row.paid)).toEqual([34_578, 0, 0])
  })

  it("two missed instalments: a fee each, interest on both once both are overdue", () => {
    const result = computeNonNcaCharges(base)
    // Feb 1..28: 28 x 110000 x 0.14/365 = 1181.37 → 1181 at month end.
    // Mar 1..9: 9 x 220000 x 0.14/365 = 759.45; total 1940.82 → 1941, so 760.
    expect(result.postings).toEqual([
      { type: "COLLECTION_FEE", day: "2026-02-01", amount: 25_000 },
      { type: "DEFAULT_INTEREST", day: "2026-02-28", amount: 1_181 },
      { type: "COLLECTION_FEE", day: "2026-03-01", amount: 25_000 },
      { type: "DEFAULT_INTEREST", day: "2026-03-09", amount: 760 },
    ])
    expect(result).toMatchObject({ interestAccrued: 1_941, feesAccrued: 50_000, inDuplum: null })
  })

  it("margin and fee unset on the product: no charges, receipts still allocated", () => {
    const result = computeNonNcaCharges({
      ...base,
      defaultInterestMargin: null,
      collectionFeeCents: null,
      receipts: [{ id: "r1", amount: 60_000, receivedAt: d("2026-02-11") }],
    })
    expect(result.postings).toEqual([])
    expect(result).toMatchObject({ interestAccrued: 0, feesAccrued: 0, scheduleAllocated: 60_000, unallocated: 0 })
    expect(result.receiptSplits).toEqual([{ receiptId: "r1", toDefaultInterest: 0, toFees: 0, toSchedule: 60_000 }])
  })

  it("a margin of 0 is the contract rate alone, not 'unset'", () => {
    const result = computeNonNcaCharges({ ...base, defaultInterestMargin: 0, collectionFeeCents: null })
    // 12% a year: Feb 28 x 110000 x 0.12/365 = 1012.60 → 1013; total
    // (28 x 110000 + 9 x 220000) x 0.12/365 = 1663.56 → 1664, so 651.
    expect(result.postings).toEqual([
      { type: "DEFAULT_INTEREST", day: "2026-02-28", amount: 1_013 },
      { type: "DEFAULT_INTEREST", day: "2026-03-09", amount: 651 },
    ])
  })

  it("an instalment paid the day after its due date carries no fee and no interest", () => {
    const result = computeNonNcaCharges({
      ...base,
      receipts: [{ id: "r1", amount: 110_000, receivedAt: d("2026-02-01") }],
      asOf: d("2026-02-10"),
    })
    expect(result.postings).toEqual([])
    expect(result.scheduleRows[0]).toEqual({ paid: 110_000, completedBy: "r1" })
  })

  it("has no in duplum cap: charges run past the unpaid principal at default", () => {
    // R100 principal + R10 interest due 31 Jan 2025, never paid. 5% pm = 60%
    // a year + 40% margin = 100% a year on R110 for 730 days = R220, plus the
    // R50 fee: R270 against an in duplum cap of R100.
    const input: NonNcaChargeInput = {
      schedule: [{ dueDate: d("2025-01-31"), principalDue: 10_000, interestDue: 1_000, feesDue: 0, totalDue: 11_000 }],
      receipts: [],
      interestRatePm: 0.05,
      maturityDate: d("2025-01-31"),
      asOf: d("2027-02-01"),
      defaultInterestMargin: 0.4,
      collectionFeeCents: 5_000,
    }
    const nonNca = computeNonNcaCharges(input)
    expect(nonNca.interestAccrued).toBe(22_000)
    expect(nonNca.feesAccrued).toBe(5_000)
    expect(nonNca.inDuplum).toBeNull()

    // The NCA engine on the same loan stops at the cap.
    const nca = computeDefaultCharges({ ...input, adminCharges: [], monthlyServiceFee: 0 })
    expect(nca.inDuplum).toMatchObject({ capBase: 10_000, reached: true })
    expect(nca.interestAccrued + nca.feesAccrued).toBeLessThanOrEqual(10_000)
    expect(nonNca.interestAccrued + nonNca.feesAccrued).toBeGreaterThan(nca.inDuplum?.capBase ?? Infinity)
  })

  it("posts nothing before accrueFrom or on/after accrueUntil", () => {
    const fromGoLive = computeNonNcaCharges({ ...base, accrueFrom: d("2026-03-05") })
    // The Feb 1 and Mar 1 fees fall before go-live; Mar 5..9 accrue on R2,200.
    // 5 x 220000 x 0.14/365 = 421.92 → 422.
    expect(fromGoLive.postings).toEqual([{ type: "DEFAULT_INTEREST", day: "2026-03-09", amount: 422 }])

    const untilWriteOff = computeNonNcaCharges({ ...base, accrueUntil: d("2026-02-02") })
    // Only Feb 1: the fee and 110000 x 0.14/365 = 42.19 → 42.
    expect(untilWriteOff.postings).toEqual([
      { type: "COLLECTION_FEE", day: "2026-02-01", amount: 25_000 },
      { type: "DEFAULT_INTEREST", day: "2026-02-01", amount: 42 },
    ])
  })
})
