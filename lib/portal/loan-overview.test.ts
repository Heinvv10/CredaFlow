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
    })
  })
})
