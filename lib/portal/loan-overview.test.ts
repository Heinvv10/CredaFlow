import { describe, expect, it } from "vitest"
import {
  portalLoanStatusLabel,
  portalOverviewLoanQuery,
  projectPortalLoanOverview,
} from "./loan-overview"

function loan(
  id: string,
  status: string,
  outstandingPrincipal: number,
  daysInArrears = 0,
) {
  return { id, status, outstandingPrincipal, daysInArrears }
}

describe("projectPortalLoanOverview", () => {
  it("queries all of the client's loans instead of filtering out history", () => {
    const query = portalOverviewLoanQuery("client-1", "tenant-1")

    expect(query.where).toEqual({ clientId: "client-1", tenantId: "tenant-1" })
    expect(query.where).not.toHaveProperty("status")
    expect(query.select).toEqual(expect.objectContaining({
      reference: true,
      status: true,
      totalPaid: true,
    }))
  })

  it("keeps a completed loan visible with its historical values after settlement", () => {
    const completed = {
      ...loan("loan-completed", "COMPLETED", 0),
      reference: "LN-PAID-UP",
      totalPaid: 633_496,
    }

    const result = projectPortalLoanOverview([completed])

    expect(result.primaryLoan).toBe(completed)
    expect(result.primaryLoan?.reference).toBe("LN-PAID-UP")
    expect(result.primaryLoan?.totalPaid).toBe(633_496)
    expect(result.openLoans).toEqual([])
    expect(result.totalOutstanding).toBe(0)
    expect(portalLoanStatusLabel(result.primaryLoan!.status, false)).toBe("Paid Up")
  })

  it("prioritises an open obligation while retaining historical loans", () => {
    const latestCompleted = loan("loan-completed", "COMPLETED", 0)
    const restructured = loan("loan-open", "RESTRUCTURED", 245_000, 12)

    const result = projectPortalLoanOverview([latestCompleted, restructured])

    expect(result.primaryLoan).toBe(restructured)
    expect(result.openLoans).toEqual([restructured])
    expect(result.totalOutstanding).toBe(245_000)
    expect(result.maxArrears).toBe(12)
  })

  it("returns an empty projection when the client has no loans", () => {
    expect(projectPortalLoanOverview([])).toEqual({
      openLoans: [],
      primaryLoan: null,
      totalOutstanding: 0,
      maxArrears: 0,
      overdueAmount: 0,
    })
  })
})

// Elize, Fair Score audit 2026-10-16: instalment due 17 Sep part-paid (R843.30
// short), audited on 16 Oct. The stored DPD said 27 (stamped by the cron on
// 14 Oct); the borrower is 29 days overdue, and was never told the amount.
describe("projectPortalLoanOverview: arrears as of today", () => {
  const row = (dueDate: string, totalDue: number, totalPaid: number) => ({
    dueDate: new Date(dueDate), principalDue: totalDue - 50_000, interestDue: 50_000, feesDue: 0, totalDue, totalPaid,
  })
  const elize = {
    ...loan("loan-elize", "ACTIVE", 2_713_391, 27),
    principal: 3_400_000,
    repaymentSchedule: [
      row("2026-08-17T06:30:01Z", 339_000, 339_000),
      row("2026-09-17T06:30:01Z", 339_000, 254_670),
      row("2026-10-17T06:30:01Z", 339_000, 0),
    ],
  }

  it("counts the days from the earliest unpaid due date to today, and the amount overdue", () => {
    const result = projectPortalLoanOverview([elize], new Date("2026-10-16T10:00:00Z"))
    expect(result.maxArrears).toBe(29)
    expect(result.overdueAmount).toBe(84_330)
  })

  it("selects the schedule so the view can derive it", () => {
    expect(portalOverviewLoanQuery("c", "t").select).toEqual(expect.objectContaining({
      principal: true,
      repaymentSchedule: expect.objectContaining({ orderBy: { dueDate: "asc" } }),
    }))
  })
})
