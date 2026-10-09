import { describe, expect, it, vi } from "vitest"
import { computeDefaultCharges, type DefaultChargeResult } from "@/lib/loan/default-charges"
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { d, input, row } from "./default-charges.test-helpers"

// The engine test for the s126(3) order: a receipt pays all due interest, then
// all due fees and charges, then principal. `order.legacy` lets the property
// test replay the same loan under the old order (default interest, charges,
// then the schedule instalment by instalment) to compare the two.
const order = vi.hoisted(() => ({ legacy: false }))
vi.mock("./receipt-allocation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./receipt-allocation")>()
  return {
    ...actual,
    allocateReceipt: (args: Parameters<typeof actual.allocateReceipt>[0]) =>
      actual.allocateReceipt({ ...args, s126: args.s126 && !order.legacy }),
  }
})

const principalRealised = (
  schedule: Array<{ principalDue: number; totalDue: number }>,
  r: DefaultChargeResult,
) => schedule.map((s, i) => Math.min(s.principalDue, Math.max(0, r.scheduleRows[i].paid - (s.totalDue - s.principalDue))))

describe("computeDefaultCharges: s126(3) order", () => {
  // The bullet: R2,000 principal, R100 interest, R69 fees, due 1 Sep. A letter
  // on 5 Sep; Sep 2..7 default interest = 6 x 333.33 = R20.00.
  const letter = [{ id: "s129-1", date: d("2026-09-05"), amount: 8_200 }]

  it("a receipt pays due interest, then the letter before the instalment's contractual fees", () => {
    const r = computeDefaultCharges(input({
      adminCharges: letter, receipts: [{ id: "p1", amount: 20_000, receivedAt: d("2026-09-08") }],
    }))
    expect(r.receiptSplits).toEqual([{ receiptId: "p1", toDefaultInterest: 2_000, toFees: 8_000, toSchedule: 10_000 }])
  })

  it("and principal only once every due interest, fee and charge is paid", () => {
    const r = computeDefaultCharges(input({
      adminCharges: letter, receipts: [{ id: "p1", amount: 30_000, receivedAt: d("2026-09-08") }],
    }))
    // R20 default interest, R100 interest, R82 letter, R69 fees, R29 principal.
    expect(r.receiptSplits).toEqual([{ receiptId: "p1", toDefaultInterest: 2_000, toFees: 8_200, toSchedule: 19_800 }])
    expect(principalRealised([input({}).schedule[0]], r)).toEqual([2_900])
  })

  it("posts a letter while only an instalment is overdue and no charge is owed", () => {
    const r = computeDefaultCharges(input({ interestRatePm: 0, adminCharges: letter }))
    expect(r.feesAccrued).toBe(8_200)
  })

  describe("two instalments overdue, a receipt that does not clear the first", () => {
    const rows = [row("2026-01-01", 100_000, 10_000), row("2026-02-01", 100_000, 10_000)]
    const base = {
      schedule: rows, maturityDate: rows[1].dueDate, interestRatePm: 0, asOf: d("2026-02-10"),
      receipts: [{ id: "p1", amount: 115_000, receivedAt: d("2026-02-05") }],
    }

    it("pays both instalments' interest before either's principal, which recomputeLoanBalances reads back", () => {
      const r = computeDefaultCharges(input(base))
      expect(r.scheduleRows.map((s) => s.paid)).toEqual([105_000, 10_000])
      const booked = rows.map((s, i) => ({ ...s, totalPaid: r.scheduleRows[i].paid }))
      expect(recomputeLoanBalances(200_000, booked, base.asOf).outstandingPrincipal).toBe(105_000)
    })

    it("keeps the old instalment-by-instalment fill for a receipt before go-live", () => {
      const r = computeDefaultCharges(input({ ...base, accrueFrom: d("2026-02-06") }))
      expect(r.scheduleRows.map((s) => s.paid)).toEqual([110_000, 5_000])
    })
  })

  it("dates a paid instalment by the receipt that completed it", () => {
    const rows = [row("2026-01-01", 100_000, 10_000), row("2026-02-01", 100_000, 10_000)]
    const r = computeDefaultCharges(input({
      schedule: rows, maturityDate: rows[1].dueDate, interestRatePm: 0, asOf: d("2026-02-10"),
      receipts: [
        { id: "p1", amount: 115_000, receivedAt: d("2026-02-05") },
        { id: "p2", amount: 5_000, receivedAt: d("2026-02-06") },
        { id: "p3", amount: 100_000, receivedAt: d("2026-02-07") },
      ],
    }))
    expect(r.scheduleRows).toEqual([{ paid: 110_000, completedBy: "p2" }, { paid: 110_000, completedBy: "p3" }])
  })

  it("over 3,000 random single-instalment loans, realises exactly the principal the old order did", () => {
    const DAY = 86_400_000
    const bad: unknown[] = []
    for (let seed = 1; seed < 3000; seed++) {
      let x = seed
      const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
      const start = d("2026-01-31").getTime()
      const principalDue = 5_000 + Math.floor(rnd() * 50_000)
      const schedule = [{ dueDate: new Date(start + 30 * DAY), principalDue, interestDue: 500 + Math.floor(rnd() * 5_000), feesDue: 690, totalDue: 0 }]
      schedule[0].totalDue = principalDue + schedule[0].interestDue + 690
      const receipts = Array.from({ length: Math.floor(rnd() * 5) }, (_, i) => ({ id: `r${i}`, amount: 1_000 + Math.floor(rnd() * 20_000), receivedAt: new Date(start + Math.floor(rnd() * 300) * DAY) }))
      const adminCharges = Array.from({ length: Math.floor(rnd() * 3) }, (_, i) => ({ id: `l${i}`, amount: 8_200, date: new Date(start + Math.floor(rnd() * 300) * DAY) }))
      const loan = { schedule, receipts, adminCharges, interestRatePm: 0.05, monthlyServiceFee: 6_900, maturityDate: schedule[0].dueDate, asOf: new Date(start + 400 * DAY) }
      order.legacy = true
      const legacy = computeDefaultCharges(loan)
      order.legacy = false
      const s126 = computeDefaultCharges(loan)
      const same = (r: DefaultChargeResult) => [
        ...principalRealised(schedule, r), r.interestAccrued, r.feesAccrued, r.unallocated,
        r.scheduleAllocated + r.interestPaid + r.feesPaid,
      ]
      if (JSON.stringify(same(legacy)) !== JSON.stringify(same(s126))) bad.push({ seed, legacy: same(legacy), s126: same(s126) })
    }
    expect(bad.slice(0, 5)).toEqual([])
  }, 60_000)
})
