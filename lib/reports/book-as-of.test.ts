import { describe, expect, it, vi } from "vitest"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"
import { loadBookAsOf, outstandingPrincipalAsOf, type AsOfLoan, type AsOfReceipt } from "./book-as-of"

const at = (iso: string) => new Date(iso)

const receipt = (amount: number, receivedAt: string, over: Partial<AsOfReceipt> = {}): AsOfReceipt => ({
  amount, receivedAt: at(receivedAt), reversed: false, reversedAt: null, allocationStatus: "ALLOCATED",
  defaultInterestAllocated: 0, chargeFeesAllocated: 0, ...over,
})

// R3,000 over two instalments of R1,500 principal + R200 interest + R100 fees.
const twoInstalments = (payments: AsOfReceipt[]): AsOfLoan => ({
  principal: 300000, totalInterest: 40000, totalRepayable: 360000,
  contractualTotalInterest: null, contractualTotalRepayable: null,
  totalPaid: 0, interestRatePm: 5, interestModel: "FLAT",
  startDate: at("2026-07-01T10:00:00Z"), maturityDate: at("2026-09-01T10:00:00Z"), closedAt: null,
  repaymentSchedule: [
    { id: "b", dueDate: at("2026-09-01T10:00:00Z"), principalDue: 150000, interestDue: 20000, feesDue: 10000, totalDue: 180000, totalPaid: 0 },
    { id: "a", dueDate: at("2026-08-01T10:00:00Z"), principalDue: 150000, interestDue: 20000, feesDue: 10000, totalDue: 180000, totalPaid: 0 },
  ],
  payments,
})

const monthEnd = at("2026-08-15T00:00:00Z")

describe("outstandingPrincipalAsOf", () => {
  it("takes principal only after interest and fees, earliest instalment first", () => {
    // R1,000 covers the Aug instalment's R300 interest+fees, then R700 principal.
    expect(outstandingPrincipalAsOf(twoInstalments([receipt(100000, "2026-08-01T12:00:00Z")]), monthEnd)).toBe(230000)
  })

  it("ignores a receipt received after the as-of instant", () => {
    const loan = twoInstalments([receipt(180000, "2026-08-01T12:00:00Z"), receipt(180000, "2026-08-20T12:00:00Z")])
    expect(outstandingPrincipalAsOf(loan, monthEnd)).toBe(150000)
    expect(outstandingPrincipalAsOf(loan, at("2026-09-02T00:00:00Z"))).toBe(0)
  })

  it("counts a receipt reversed after the as-of instant, not one reversed before it", () => {
    const reversedLater = receipt(180000, "2026-08-01T12:00:00Z", { reversed: true, reversedAt: at("2026-08-20T00:00:00Z") })
    const reversedBefore = receipt(180000, "2026-08-01T12:00:00Z", { reversed: true, reversedAt: at("2026-08-10T00:00:00Z") })
    expect(outstandingPrincipalAsOf(twoInstalments([reversedLater]), monthEnd)).toBe(150000)
    expect(outstandingPrincipalAsOf(twoInstalments([reversedBefore]), monthEnd)).toBe(300000)
  })

  it("leaves out receipts that are not allocated and the part that paid default charges", () => {
    const loan = twoInstalments([
      receipt(180000, "2026-08-01T12:00:00Z", { defaultInterestAllocated: 20000, chargeFeesAllocated: 10000 }),
      receipt(50000, "2026-08-02T12:00:00Z", { allocationStatus: "UNAPPLIED" }),
    ])
    // R1,500 reaches the schedule: R300 interest+fees, R1,200 principal.
    expect(outstandingPrincipalAsOf(loan, monthEnd)).toBe(180000)
  })

  it("rebuilds an early-settled bullet loan on its contract before it closed and repriced after", () => {
    // Contract: R2,000 + R400 interest + R100 fees. Settled early on 10 Aug at R50 accrued interest.
    const loan: AsOfLoan = {
      principal: 200000, totalInterest: 5000, totalRepayable: 215000,
      contractualTotalInterest: 40000, contractualTotalRepayable: 250000,
      totalPaid: 215000, interestRatePm: 5, interestModel: "DAILY_ACCRUAL",
      startDate: at("2026-08-01T10:00:00Z"), maturityDate: at("2026-08-31T10:00:00Z"), closedAt: at("2026-08-10T12:00:00Z"),
      repaymentSchedule: [
        { id: "a", dueDate: at("2026-08-31T10:00:00Z"), principalDue: 200000, interestDue: 5000, feesDue: 10000, totalDue: 215000, totalPaid: 215000 },
      ],
      payments: [receipt(100000, "2026-08-05T12:00:00Z"), receipt(115000, "2026-08-10T12:00:00Z")],
    }
    // 8 Aug: R1,000 paid against the contractual row — R500 interest+fees, R500 principal.
    expect(outstandingPrincipalAsOf(loan, at("2026-08-08T00:00:00Z"))).toBe(150000)
    expect(outstandingPrincipalAsOf(loan, at("2026-08-11T00:00:00Z"))).toBe(0)
  })
})

describe("loadBookAsOf", () => {
  it("sums the loans open at the instant and asks only for those", async () => {
    const findMany = vi.fn().mockResolvedValue([
      twoInstalments([receipt(100000, "2026-08-01T12:00:00Z")]),
      twoInstalments([]),
    ])
    expect(await loadBookAsOf({ loan: { findMany } } as never, "t1", monthEnd)).toBe(530000)
    // The collectible book then: collectible now, or left the book after the instant.
    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      startDate: { lt: monthEnd },
      OR: [
        { status: { in: [...COLLECTIBLE_STATUSES] } },
        { closedAt: { gte: monthEnd } },
        { writeOffAt: { gte: monthEnd } },
      ],
    })
  })
})
