import { describe, expect, it, vi } from "vitest"
import type { DefaultChargeResult } from "@/lib/loan/default-charges"

const { loadChargesReplay, prismaMock } = vi.hoisted(() => ({
  loadChargesReplay: vi.fn(),
  prismaMock: {
    loan: { findUnique: vi.fn() },
    payment: { aggregate: vi.fn(async () => ({ _sum: { amount: 50_000 } })) },
    complianceRecord: { findFirst: vi.fn(async () => null) },
  },
}))
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/loan/charges-replay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loan/charges-replay")>()),
  loadChargesReplay,
}))

import { portalLoanCharges, portalOutstanding, sumPortalCharges } from "./loan-charges"
import { staffLoanFigures } from "@/lib/loan/loan-page-figures"

describe("sumPortalCharges", () => {
  it("adds charges and the settlement amount across a client's loans, one line per charge type", () => {
    expect(sumPortalCharges([
      { outstanding: 11_200, lines: [{ label: "Default interest", amount: 3_000 }, { label: "Collection letter fee", amount: 8_200 }], settlementAmount: 100_000 },
      { outstanding: 1_000, lines: [{ label: "Default interest", amount: 1_000 }], settlementAmount: 20_000 },
      { outstanding: 0, lines: [], settlementAmount: 0 },
    ])).toEqual({
      outstanding: 12_200,
      lines: [{ label: "Default interest", amount: 4_000 }, { label: "Collection letter fee", amount: 8_200 }],
      settlementAmount: 120_000,
    })
  })

  it("has no settlement amount while charges are off", () => {
    expect(sumPortalCharges([{ outstanding: 0, lines: [], settlementAmount: null }]).settlementAmount).toBeNull()
  })
})

// Two monthly FLAT instalments of R1,100 (R1,000 principal + R100 interest);
// the first is overdue and unpaid, the second not yet due.
const row = (id: string, due: string) => ({
  id, dueDate: new Date(`${due}T10:00:00+02:00`), principalDue: 100_000, interestDue: 10_000,
  feesDue: 0, totalDue: 110_000, totalPaid: 0,
})
const loan = {
  id: "loan-1", tenantId: "t1", status: "DEFAULTED", principal: 200_000, totalInterest: 20_000,
  totalRepayable: 220_000, totalPaid: 0, outstandingPrincipal: 200_000, arrearsAmount: 110_000,
  interestRatePm: 0.05, interestModel: "FLAT" as const, startDate: new Date("2026-08-01T10:00:00+02:00"),
  maturityDate: new Date("2026-10-01T10:00:00+02:00"),
  repaymentSchedule: [row("r1", "2026-09-01"), row("r2", "2026-10-01")],
}
const asOf = new Date("2026-09-26T10:00:00+02:00")
function replay(interestOutstanding: number) {
  const result: DefaultChargeResult = {
    postings: [], interestAccrued: interestOutstanding, interestPaid: 0, interestOutstanding,
    feesAccrued: 0, feesPaid: 0, feesOutstanding: 0, scheduleAllocated: 0,
    scheduleRows: [], unallocated: 0, receiptSplits: [], inDuplum: null,
  }
  return { result, goLive: new Date(), accrueFrom: new Date(), loan: { defaultChargesExempt: false, defaultChargesExemptReason: null } }
}

describe("the balance staff and the client see for one loan", () => {
  it("is the same settlement amount on both while charges are live", async () => {
    loadChargesReplay.mockResolvedValue(replay(3_000))
    prismaMock.loan.findUnique.mockResolvedValue(loan)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const staff = await staffLoanFigures(prismaMock as any, loan, asOf)
    const portal = portalOutstanding(loan.outstandingPrincipal, await portalLoanCharges("t1", "loan-1", asOf))
    // What the receipt paths accept to settle: the contractual R2,200 (FLAT:
    // October's interest included) plus R30 of default interest.
    expect(staff.balance).toBe(223_000)
    expect(portal).toBe(223_000)
  })

  it("stays exactly as before while charges are off", async () => {
    loadChargesReplay.mockResolvedValue(null)
    prismaMock.loan.findUnique.mockResolvedValue(loan)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const staff = await staffLoanFigures(prismaMock as any, loan, asOf)
    expect(staff.balance).toBe(loan.totalRepayable - loan.totalPaid)
    expect(portalOutstanding(loan.outstandingPrincipal, await portalLoanCharges("t1", "loan-1", asOf))).toBe(200_000)
  })
})
