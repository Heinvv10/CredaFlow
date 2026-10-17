import { describe, expect, it, vi } from "vitest"
import type { DefaultChargeResult } from "./default-charges"

const { loadChargesReplay } = vi.hoisted(() => ({ loadChargesReplay: vi.fn() }))
vi.mock("./charges-replay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./charges-replay")>()),
  loadChargesReplay,
}))

import {
  certificatePaidToDate, certificateSettlement, chargeBreakdownLines, documentLoanFigures, isS125Priced, loanSettlementFigures, section129NoticeAmounts, summariseCharges,
} from "./charges-summary"
import { currentSettlementAmount } from "./settlement"

function result(over: Partial<DefaultChargeResult>): DefaultChargeResult {
  return {
    postings: [], interestAccrued: 0, interestPaid: 0, interestOutstanding: 0,
    feesAccrued: 0, feesPaid: 0, feesOutstanding: 0, scheduleAllocated: 0,
    scheduleRows: [], unallocated: 0, receiptSplits: [], inDuplum: null, ...over,
  }
}

describe("summariseCharges", () => {
  it("splits charges into default interest, service fees and letter fees, with fee payments applied oldest first", () => {
    const summary = summariseCharges(result({
      postings: [
        { type: "DEFAULT_INTEREST", day: "2026-09-30", amount: 9_667 },
        { type: "DEFAULT_ADMIN", day: "2026-10-01", amount: 8_200, sourceId: "s129" },
        { type: "SERVICE_FEE", day: "2026-11-01", amount: 6_900 },
      ],
      interestAccrued: 9_667, interestPaid: 9_667, interestOutstanding: 0,
      feesAccrued: 15_100, feesPaid: 10_000, feesOutstanding: 5_100,
    }))
    expect(summary.buckets).toEqual({
      DEFAULT_INTEREST: { accrued: 9_667, paid: 9_667, outstanding: 0 },
      DEFAULT_ADMIN: { accrued: 8_200, paid: 8_200, outstanding: 0 },
      SERVICE_FEE: { accrued: 6_900, paid: 1_800, outstanding: 5_100 },
    })
    expect(summary.outstanding).toBe(5_100)
  })

  it("lists only the charges still owed, in the words shown to the consumer", () => {
    const summary = summariseCharges(result({
      postings: [
        { type: "DEFAULT_INTEREST", day: "2026-09-30", amount: 3_000 },
        { type: "DEFAULT_ADMIN", day: "2026-10-01", amount: 8_200, sourceId: "s129" },
      ],
      interestAccrued: 3_000, interestOutstanding: 3_000,
      feesAccrued: 8_200, feesOutstanding: 8_200,
    }))
    expect(chargeBreakdownLines(summary)).toEqual([
      { label: "Default interest", amount: 3_000 },
      { label: "Collection letter fee", amount: 8_200 },
    ])
  })
})

describe("loanSettlementFigures", () => {
  const db = { payment: { aggregate: vi.fn(async () => ({ _sum: { amount: 50_000 } })) } }
  const loan = {
    id: "loan-1", tenantId: "t1", principal: 200_000, totalInterest: 10_000, totalRepayable: 216_900,
    totalPaid: 42_000, outstandingPrincipal: 174_900, arrearsAmount: 174_900, interestRatePm: 0.05,
    interestModel: "FLAT" as const, startDate: new Date("2026-08-01"), maturityDate: new Date("2026-09-01"),
    repaymentSchedule: [{
      id: "row-1", dueDate: new Date("2026-09-01"), principalDue: 200_000, interestDue: 10_000,
      feesDue: 6_900, totalDue: 216_900, totalPaid: 42_000,
    }],
  }

  it("itemises the settlement: principal, contractual interest and fees, charges, and arrears incl. charges", async () => {
    loadChargesReplay.mockResolvedValue({
      result: result({
        postings: [{ type: "DEFAULT_INTEREST", day: "2026-09-25", amount: 8_000 }],
        interestAccrued: 8_000, interestOutstanding: 8_000,
      }),
      goLive: new Date("2026-01-01"), accrueFrom: new Date("2026-01-01"),
      loan: { defaultChargesExempt: false, defaultChargesExemptReason: null },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const figures = await loanSettlementFigures(db as any, loan, new Date("2026-09-26"))
    expect(figures).toMatchObject({
      chargesOutstanding: 8_000,
      totalToSettle: 174_900 + 8_000,
      interestAndFeesOutstanding: 0,
      arrearsIncludingCharges: 182_900,
      chargeLines: [{ label: "Default interest", amount: 8_000 }],
      paymentsReceived: 50_000,
    })
    expect(db.payment.aggregate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ paymentMethod: { not: "WAIVER" }, reversed: false, allocationStatus: "ALLOCATED" }),
    }))
  })

  it("states nothing owed for a loan CANCELLED by a disbursement reversal, charges live or not", async () => {
    loadChargesReplay.mockResolvedValue({
      result: result({ postings: [{ type: "DEFAULT_INTEREST", day: "2026-09-25", amount: 8_000 }], interestAccrued: 8_000, interestOutstanding: 8_000 }),
      goLive: new Date("2026-01-01"), accrueFrom: new Date("2026-01-01"),
      loan: { defaultChargesExempt: false, defaultChargesExemptReason: null },
    })
    const cancelled = { ...loan, status: "CANCELLED", totalPaid: 0, outstandingPrincipal: 0, arrearsAmount: 0 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const figures = await loanSettlementFigures(db as any, cancelled, new Date("2026-09-26"))
    expect(figures).toMatchObject({
      live: false, charges: null, chargeLines: [], chargesOutstanding: 0, totalToSettle: 0,
      interestAndFeesOutstanding: 0, arrearsIncludingCharges: 0,
    })
    expect(documentLoanFigures(cancelled)).toEqual({ totalRepayable: 0, outstandingPrincipal: 0, daysInArrears: 0 })
    expect(documentLoanFigures({ ...loan, status: "ACTIVE", daysInArrears: 3 })).toEqual({ totalRepayable: 216_900, outstandingPrincipal: 174_900, daysInArrears: 3 })
  })

  it("is the plain contractual settlement while charges are off", async () => {
    loadChargesReplay.mockResolvedValue(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const figures = await loanSettlementFigures(db as any, { ...loan, totalPaid: 0, outstandingPrincipal: 200_000 }, new Date("2026-09-26"))
    expect(figures).toMatchObject({ live: false, chargesOutstanding: 0, totalToSettle: 216_900, interestAndFeesOutstanding: 16_900, chargeLines: [] })
  })

  it("states what the receipt paths accept to settle, charges included, not a lower amount owing", async () => {
    loadChargesReplay.mockResolvedValue({
      result: result({ interestAccrued: 3_000, interestOutstanding: 3_000 }),
      goLive: new Date("2026-01-01"), accrueFrom: new Date("2026-01-01"),
      loan: { defaultChargesExempt: false, defaultChargesExemptReason: null },
    })
    const row = (id: string, due: string) => ({
      id, dueDate: new Date(`${due}T10:00:00+02:00`), principalDue: 100_000, interestDue: 10_000,
      feesDue: 0, totalDue: 110_000, totalPaid: 0,
    })
    const twoMonth = {
      ...loan, totalInterest: 20_000, totalRepayable: 220_000, totalPaid: 0, outstandingPrincipal: 200_000,
      arrearsAmount: 110_000, maturityDate: new Date("2026-10-01"),
      repaymentSchedule: [row("r1", "2026-09-01"), row("r2", "2026-10-01")],
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const figures = await loanSettlementFigures(db as any, twoMonth, new Date("2026-09-26T10:00:00+02:00"))
    const asOf = new Date("2026-09-26T10:00:00+02:00")
    expect(figures).toMatchObject({
      live: true,
      totalToSettle: currentSettlementAmount({ loan: twoMonth, schedule: twoMonth.repaymentSchedule, asOf }) + 3_000,
      interestAndFeesOutstanding: 20_000,
      arrearsIncludingCharges: 110_000 + 3_000,
    })
    expect(figures.totalToSettle).toBe(223_000)
    expect(section129NoticeAmounts(twoMonth, figures).totalOutstanding).toBe(223_000)
    expect(certificateSettlement(figures)?.totalToSettle).toBe(223_000)
  })
})

describe("certificatePaidToDate", () => {
  const loan = {
    id: "loan-1", tenantId: "t1", principal: 200_000, totalInterest: 10_000, totalRepayable: 216_900,
    totalPaid: 216_900, outstandingPrincipal: 0, arrearsAmount: 0, interestRatePm: 0.05,
    interestModel: "FLAT" as const, startDate: new Date("2026-08-01"), maturityDate: new Date("2026-09-01"),
    repaymentSchedule: [{
      id: "row-1", dueDate: new Date("2026-09-01"), principalDue: 200_000, interestDue: 10_000,
      feesDue: 6_900, totalDue: 216_900, totalPaid: 216_900,
    }],
  }
  const received = (amount: number, splits: number) => ({
    payment: { aggregate: vi.fn(async () => ({ _sum: { amount, defaultInterestAllocated: splits, chargeFeesAllocated: 0 } })) },
  })

  it("on a never-live loan settled with a small-balance waiver, is undefined so the certificate shows Loan.totalPaid", async () => {
    loadChargesReplay.mockResolvedValue(null)
    // R2,168.25 cash + a R0.75 waiver: cash received is below Loan.totalPaid.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const figures = await loanSettlementFigures(received(216_825, 0) as any, loan, new Date("2026-09-26"))
    expect(figures).toMatchObject({ live: false, paymentsReceived: 216_825, chargeSplitsPaid: 0 })
    expect(certificatePaidToDate(figures)).toBeUndefined()
  })

  it("after a stop, receipts that paid charges still show cash received", async () => {
    loadChargesReplay.mockResolvedValue(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const figures = await loanSettlementFigures(received(219_900, 3_000) as any, loan, new Date("2026-09-26"))
    expect(certificatePaidToDate(figures)).toBe(219_900)
  })
})

describe("the certificate's settlement block", () => {
  const row = (id: string) => ({
    id, dueDate: new Date("2026-09-01"), principalDue: 100_000, interestDue: 10_000, feesDue: 0, creditLifePremiumDue: 0,
    totalDue: 110_000, totalPaid: 0,
  })
  const instalments = [row("r1"), row("r2")]
  const loan = {
    principal: 200_000, totalInterest: 20_000, totalRepayable: 220_000, totalPaid: 0, interestRatePm: 0.05,
    interestModel: "REDUCING_BALANCE" as const, startDate: new Date("2026-08-01"), maturityDate: new Date("2026-10-01"),
    ncaRegime: "NCA", contractType: "LOAN",
  }

  it("is s125-priced only for an NCA consumer loan of several instalments, or an NCA bullet", () => {
    expect(isS125Priced(loan, instalments)).toBe(true)
    expect(isS125Priced({ ...loan, interestModel: "DAILY_ACCRUAL" }, [row("r1")])).toBe(true)
    expect(isS125Priced({ ...loan, contractType: "INSTALMENT_SALE" }, instalments)).toBe(false)
    expect(isS125Priced({ ...loan, ncaRegime: "NON_NCA" }, instalments)).toBe(false)
    expect(isS125Priced({ ...loan, ncaRegime: "NON_NCA", interestModel: "DAILY_ACCRUAL" }, [row("r1")])).toBe(false)
    expect(isS125Priced(loan, [row("r1")])).toBe(false)
  })

  const figures = (live: boolean, s125Priced: boolean, chargeSplitsPaid = 0) => ({
    live, s125Priced, chargeSplitsPaid, charges: null, chargeLines: [], chargesOutstanding: 0, totalToSettle: 211_000,
    interestAndFeesOutstanding: 11_000, arrearsIncludingCharges: 0, paymentsReceived: 9_000,
  })

  it("certifies the s125 figure with charges off, keeping Total Paid to Date on Loan.totalPaid", () => {
    expect(certificateSettlement(figures(false, true))).toEqual({
      paymentsReceived: undefined, interestAndFeesOutstanding: 11_000, charges: [], totalToSettle: 211_000,
    })
  })

  it("certifies nothing new for a contractual remainder with charges off (asset finance, NON_NCA)", () => {
    expect(certificateSettlement(figures(false, false))).toBeUndefined()
  })

  it("states cash received while charges are live", () => {
    expect(certificateSettlement(figures(true, false))?.paymentsReceived).toBe(9_000)
  })
})

it("keeps stopped historical fee postings visible without presenting forgiven fees as collectible", () => {
  const summary = summariseCharges(result({ postings: [{ type: "COLLECTION_FEE", day: "2026-01-01", amount: 25000 }], feesAccrued: 25000, feesPaid: 1000, feesOutstanding: 0 }))
  expect(summary.buckets.COLLECTION_FEE).toEqual({ accrued: 25000, paid: 1000, outstanding: 0 })
  expect(chargeBreakdownLines(summary)).toEqual([])
})
