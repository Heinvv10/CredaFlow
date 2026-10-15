import { describe, expect, it, vi } from "vitest"
import type { DefaultChargeResult } from "./default-charges"

const { loadChargesReplay } = vi.hoisted(() => ({ loadChargesReplay: vi.fn() }))
vi.mock("./charges-replay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./charges-replay")>()),
  loadChargesReplay,
}))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { staffLoanFigures } from "./loan-page-figures"

function replay(interestOutstanding: number, feesOutstanding = 0) {
  const result: DefaultChargeResult = {
    postings: [], interestAccrued: interestOutstanding, interestPaid: 0, interestOutstanding,
    feesAccrued: feesOutstanding, feesPaid: 0, feesOutstanding, scheduleAllocated: 0,
    scheduleRows: [], unallocated: 0, receiptSplits: [], inDuplum: null,
  }
  return { result, goLive: new Date(), accrueFrom: new Date(), loan: { defaultChargesExempt: false, defaultChargesExemptReason: null } }
}

// The UI fixture loan: R2,169 FLAT bullet, R500 received of which R30 paid
// default interest, so R470 applied to the instalment.
const loan = {
  id: "loan-1", tenantId: "t1", status: "ACTIVE", principal: 200_000, totalInterest: 10_000,
  totalRepayable: 216_900, totalPaid: 47_000, outstandingPrincipal: 169_900, arrearsAmount: 169_900,
  interestRatePm: 0.05, interestModel: "FLAT" as const, startDate: new Date("2026-08-01"),
  maturityDate: new Date("2026-09-01"),
  repaymentSchedule: [{
    id: "row-1", dueDate: new Date("2026-09-01"), principalDue: 200_000, interestDue: 10_000,
    feesDue: 6_900, totalDue: 216_900, totalPaid: 47_000,
  }],
}
const db = {
  payment: { aggregate: vi.fn(async () => ({ _sum: { amount: 50_000 } })) },
  complianceRecord: { findFirst: vi.fn(async (): Promise<{ data: unknown } | null> => null) },
}
const asOf = new Date("2026-09-26")

describe("staffLoanFigures", () => {
  it("quotes settlement, balance and arrears including default charges, and cash paid", async () => {
    loadChargesReplay.mockResolvedValue(replay(4_248, 8_200))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const figures = await staffLoanFigures(db as any, loan, asOf)
    expect(figures).toMatchObject({
      settlementAmount: 182_348,
      balance: 182_348,
      arrears: 182_348,
      cashPaid: 50_000,
      waivable: false,
    })
  })

  it("shows a loan cancelled by a disbursement reversal as owing nothing", async () => {
    loadChargesReplay.mockResolvedValue(replay(4_248, 8_200))
    const cancelled = { ...loan, status: "CANCELLED", totalPaid: 0 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await staffLoanFigures(db as any, cancelled, asOf)).toMatchObject({
      settlementAmount: 0, balance: 0, maturityBalance: 0, arrears: 0, waivable: false,
    })
  })

  it("offers the waiver only for a 1-100 cent settlement on a loan still being serviced", async () => {
    loadChargesReplay.mockResolvedValue(null)
    const residue = { ...loan, totalPaid: 216_825, outstandingPrincipal: 75, arrearsAmount: 75 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await staffLoanFigures(db as any, residue, asOf)).waivable).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await staffLoanFigures(db as any, { ...residue, status: "WRITTEN_OFF" }, asOf)).waivable).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await staffLoanFigures(db as any, { ...residue, totalPaid: 216_799 }, asOf)).waivable).toBe(false)
  })

  it("shows what settles the loan today as its balance while charges are live, not the maturity total", async () => {
    loadChargesReplay.mockResolvedValue(replay(0))
    // R2,000 daily-accrual bullet at 10% a month, 15 days in: R100 accrued of R200.
    const daily = {
      ...loan, totalInterest: 20_000, totalRepayable: 220_000, totalPaid: 0, outstandingPrincipal: 200_000,
      arrearsAmount: 0, interestModel: "DAILY_ACCRUAL" as const, interestRatePm: 0.1,
      startDate: new Date("2026-09-01T10:00:00+02:00"), maturityDate: new Date("2026-10-01T10:00:00+02:00"),
      repaymentSchedule: [{
        id: "row-1", dueDate: new Date("2026-10-01T10:00:00+02:00"), principalDue: 200_000, interestDue: 20_000,
        feesDue: 0, totalDue: 220_000, totalPaid: 0,
      }],
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const figures = await staffLoanFigures(db as any, daily, new Date("2026-09-16T10:00:00+02:00"))
    expect(figures).toMatchObject({ settlementAmount: 210_000, balance: 210_000, maturityBalance: 220_000 })
  })

  it("carries the reason the latest Section 129 notice's charge could not be posted", async () => {
    loadChargesReplay.mockResolvedValue(replay(0))
    db.complianceRecord.findFirst.mockResolvedValueOnce({ data: { lifecycle: "ISSUED", chargesNotDerived: "refused: re-open" } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await staffLoanFigures(db as any, loan, asOf)).chargesNotDerived).toBe("refused: re-open")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await staffLoanFigures(db as any, loan, asOf)).chargesNotDerived).toBeNull()
  })
})
