import { describe, expect, it } from "vitest"
import { computeDefaultCharges } from "@/lib/loan/default-charges"
import { d, input, row } from "./default-charges.test-helpers"

describe("computeDefaultCharges", () => {
  it("charges nothing on a loan that is not overdue", () => {
    const r = computeDefaultCharges(input({ asOf: d("2026-09-01") }))
    expect(r.postings).toEqual([])
    expect(r.interestAccrued).toBe(0)
    expect(r.inDuplum).toBeNull()
  })

  it("accrues default interest on overdue principal from the day after the missed due date, completed days only", () => {
    // Sep 2..Sep 10 = 9 completed days x R2,000 x 5% / 30 days in September.
    const r = computeDefaultCharges(input({}))
    expect(r.interestAccrued).toBe(3_000)
    expect(r.interestOutstanding).toBe(3_000)
    expect(r.postings).toEqual([
      { type: "DEFAULT_INTEREST", day: "2026-09-10", amount: 3_000 },
    ])
  })

  it("divides the monthly rate by the days in the calendar month", () => {
    // Oct 2..Oct 11 = 10 days x 200000 x 0.05 / 31 = 3225.8
    const oct = row("2026-10-01", 200_000, 10_000)
    const r = computeDefaultCharges(input({
      schedule: [oct], maturityDate: oct.dueDate, asOf: d("2026-10-12"),
    }))
    expect(r.interestAccrued).toBe(3_226)
  })

  it("allocates a receipt to default interest first, then the instalment's interest and fees, then principal", () => {
    const r = computeDefaultCharges(input({
      receipts: [{ id: "p1", amount: 50_000, receivedAt: d("2026-09-06") }],
    }))
    // Sep 2..5 accrue 1333.33 → 1333 paid first. 48667 then covers R169 of
    // interest+fees and R317.67 of principal, leaving 168233 overdue principal
    // for Sep 6..10: 5 x 168233 x 0.05 / 30 = 1401.94. Total 2735.28.
    expect(r.receiptSplits).toEqual([
      { receiptId: "p1", toDefaultInterest: 1_333, toFees: 0, toSchedule: 48_667 },
    ])
    expect(r.interestAccrued).toBe(2_735)
    expect(r.interestPaid).toBe(1_333)
    expect(r.interestOutstanding).toBe(1_402)
    expect(r.scheduleAllocated).toBe(48_667)
  })

  it("charges the service fee on the 1st of each calendar month after maturity while the instalment is unpaid", () => {
    const r = computeDefaultCharges(input({
      monthlyServiceFee: 6_900, asOf: d("2026-11-15"),
    }))
    expect(r.feesAccrued).toBe(13_800)
    // Sep 2..30: 29 x 333.33 = 9666.67 | Oct: 31 x 200000x0.05/31 = 10000 |
    // Nov 1..14: 14 x 333.33 = 4666.67  → 24333.33
    expect(r.interestAccrued).toBe(24_333)
    expect(r.postings).toEqual([
      { type: "DEFAULT_INTEREST", day: "2026-09-30", amount: 9_667 },
      { type: "SERVICE_FEE", day: "2026-10-01", amount: 6_900 },
      { type: "DEFAULT_INTEREST", day: "2026-10-31", amount: 10_000 },
      { type: "SERVICE_FEE", day: "2026-11-01", amount: 6_900 },
      { type: "DEFAULT_INTEREST", day: "2026-11-14", amount: 4_666 },
    ])
  })

  it("posts a default administration charge on the letter date and allocates it after all due interest", () => {
    const r = computeDefaultCharges(input({
      adminCharges: [{ id: "s129-1", date: d("2026-09-05"), amount: 8_200 }],
      receipts: [{ id: "p1", amount: 10_000, receivedAt: d("2026-09-08") }],
    }))
    expect(r.postings).toContainEqual(
      { type: "DEFAULT_ADMIN", day: "2026-09-05", amount: 8_200, sourceId: "s129-1" },
    )
    // Sep 2..7 default interest = 6 x 333.33 = 2000, then 8000 of the
    // instalment's R100 contractual interest (s126(3)); the fee is unpaid.
    expect(r.receiptSplits).toEqual([
      { receiptId: "p1", toDefaultInterest: 2_000, toFees: 0, toSchedule: 8_000 },
    ])
    expect(r.feesOutstanding).toBe(8_200)
  })

  it("stops all charges once everything owed is paid, and does not start service fees", () => {
    const r = computeDefaultCharges(input({
      monthlyServiceFee: 6_900,
      receipts: [{ id: "p1", amount: 216_900 + 3_000, receivedAt: d("2026-09-11") }],
      asOf: d("2026-10-20"),
    }))
    expect(r.interestAccrued).toBe(3_000)
    expect(r.feesAccrued).toBe(0)
    expect(r.interestOutstanding).toBe(0)
    expect(r.scheduleAllocated).toBe(216_900)
    expect(r.inDuplum).toBeNull()
  })

  it("never lets charges accrued during default exceed the unpaid principal at default (in duplum, s103(5))", () => {
    const small = row("2026-01-01", 10_000, 500)
    const r = computeDefaultCharges(input({
      schedule: [small],
      maturityDate: small.dueDate,
      monthlyServiceFee: 1_000,
      adminCharges: [{ id: "s129-1", date: d("2026-02-01"), amount: 8_200 }],
      asOf: d("2029-01-01"),
    }))
    expect(r.interestAccrued + r.feesAccrued).toBe(10_000)
    expect(r.inDuplum).toEqual({ capBase: 10_000, accrued: 10_000, reached: true })
    const last = r.postings[r.postings.length - 1]
    expect(last.day < "2027-01-01").toBe(true)
  })

  it("counts contractual interest falling due during default toward the in duplum cap", () => {
    const rows = [row("2026-01-01", 5_000, 500), row("2026-02-01", 5_000, 4_000)]
    const r = computeDefaultCharges(input({
      schedule: rows, maturityDate: rows[1].dueDate, asOf: d("2030-01-01"),
    }))
    // cap 10000 (all principal unpaid at default) − row 2's R40 interest.
    expect(r.interestAccrued).toBe(6_000)
    expect(r.inDuplum).toEqual({ capBase: 10_000, accrued: 10_000, reached: true })
  })

  it("starts a new default, with a new cap, after the first one is fully cured", () => {
    const rows = [row("2026-01-01", 50_000, 2_500), row("2026-02-01", 50_000, 2_500)]
    // Jan 2..10: 9 x 50000 x 0.05 / 31 = 725.81 → 726, paid with the instalment.
    const r = computeDefaultCharges(input({
      schedule: rows,
      maturityDate: rows[1].dueDate,
      receipts: [{ id: "p1", amount: 52_500 + 726, receivedAt: d("2026-01-11") }],
      asOf: d("2026-02-11"),
    }))
    expect(r.receiptSplits[0]).toEqual(
      { receiptId: "p1", toDefaultInterest: 726, toFees: 0, toSchedule: 52_500 },
    )
    // Feb 2..10: 9 x 50000 x 0.05 / 28 = 803.57; cumulative 1529.38.
    expect(r.interestAccrued).toBe(1_529)
    expect(r.inDuplum?.capBase).toBe(50_000)
    expect(r.inDuplum?.reached).toBe(false)
  })

  it("leaves a loan with no missed payment allocated exactly as before", () => {
    const rows = [row("2026-01-01", 50_000, 2_500), row("2026-02-01", 50_000, 2_500)]
    const r = computeDefaultCharges(input({
      schedule: rows,
      maturityDate: rows[1].dueDate,
      receipts: [
        { id: "p1", amount: 52_500, receivedAt: d("2026-01-01") },
        { id: "p2", amount: 30_000, receivedAt: d("2026-01-20") },
      ],
      asOf: d("2026-01-25"),
    }))
    expect(r.postings).toEqual([])
    expect(r.scheduleAllocated).toBe(82_500)
    expect(r.receiptSplits.map((s) => s.toSchedule)).toEqual([52_500, 30_000])
  })

  it("reports money beyond everything owed as unallocated instead of absorbing it", () => {
    const r = computeDefaultCharges(input({
      receipts: [{ id: "p1", amount: 300_000, receivedAt: d("2026-09-01") }],
    }))
    expect(r.scheduleAllocated).toBe(216_900)
    expect(r.unallocated).toBe(83_100)
  })

  describe("accrueFrom (go-live cut-off)", () => {
    it("accrues nothing before accrueFrom, but keeps the in duplum base from the true default start", () => {
      // Default began Sep 2 on R2,000; charging starts Sep 6: Sep 6..10 only.
      const r = computeDefaultCharges(input({ accrueFrom: d("2026-09-06") }))
      expect(r.interestAccrued).toBe(1_667)
      expect(r.postings).toEqual([{ type: "DEFAULT_INTEREST", day: "2026-09-10", amount: 1_667 }])
      expect(r.inDuplum).toEqual({ capBase: 200_000, accrued: 1_667, reached: false })
    })

    it("posts no service fee or letter charge dated before accrueFrom, and does post them after", () => {
      const r = computeDefaultCharges(input({
        monthlyServiceFee: 6_900,
        adminCharges: [
          { id: "s129-early", date: d("2026-09-05"), amount: 8_200 },
          { id: "s129-late", date: d("2026-10-03"), amount: 8_200 },
        ],
        accrueFrom: d("2026-10-02"),
        asOf: d("2026-11-02"),
      }))
      const fees = r.postings.filter((p) => p.type !== "DEFAULT_INTEREST")
      expect(fees).toEqual([
        { type: "DEFAULT_ADMIN", day: "2026-10-03", amount: 8_200, sourceId: "s129-late" },
        { type: "SERVICE_FEE", day: "2026-11-01", amount: 6_900 },
      ])
      // Oct 2..31 = 30 x 200000 x 0.05 / 31 = 9677.42; Nov 1 = 333.33.
      expect(r.interestAccrued).toBe(10_011)
    })

    it("with accrueFrom after asOf, charges nothing and allocates receipts to the schedule exactly as before", () => {
      const r = computeDefaultCharges(input({
        monthlyServiceFee: 6_900,
        receipts: [{ id: "p1", amount: 50_000, receivedAt: d("2026-09-06") }],
        accrueFrom: d("2026-09-12"),
      }))
      expect(r.postings).toEqual([])
      expect(r.receiptSplits).toEqual([{ receiptId: "p1", toDefaultInterest: 0, toFees: 0, toSchedule: 50_000 }])
      expect(r.scheduleAllocated).toBe(50_000)
    })
  })
})
