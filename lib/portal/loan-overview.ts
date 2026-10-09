export const OPEN_PORTAL_LOAN_STATUSES = [
  "ACTIVE",
  "DEFAULTED",
  "RESTRUCTURED",
  "PENDING_WRITE_OFF",
] as const

const OPEN_PORTAL_LOAN_STATUS_SET = new Set<string>(OPEN_PORTAL_LOAN_STATUSES)

export interface PortalOverviewLoan {
  status: string
  outstandingPrincipal: number
  daysInArrears: number
}

export function portalOverviewLoanQuery(clientId: string, tenantId: string) {
  return {
    // Intentionally no status predicate: a settled loan is still the client's
    // historical account and must remain visible on the overview.
    where: { clientId, tenantId },
    select: {
      id: true,
      reference: true,
      status: true,
      principal: true,
      outstandingPrincipal: true,
      totalRepayable: true,
      totalPaid: true,
      daysInArrears: true,
      startDate: true,
      product: { select: { name: true } },
    },
    orderBy: { startDate: "desc" as const },
  }
}

/**
 * Keep a live obligation prominent, but retain the latest historical loan
 * once the client has paid up. The caller supplies loans newest-first.
 */
export function projectPortalLoanOverview<T extends PortalOverviewLoan>(loans: readonly T[]) {
  const openLoans = loans.filter((loan) => OPEN_PORTAL_LOAN_STATUS_SET.has(loan.status))
  const primaryLoan = openLoans[0] ?? loans[0] ?? null

  return {
    openLoans,
    primaryLoan,
    totalOutstanding: openLoans.reduce(
      (sum, loan) => sum + Number(loan.outstandingPrincipal),
      0,
    ),
    maxArrears: openLoans.reduce(
      (maximum, loan) => Math.max(maximum, loan.daysInArrears),
      0,
    ),
  }
}

export function portalLoanStatusLabel(status: string, hasArrears: boolean): string {
  if (status === "COMPLETED") return "Paid Up"
  if (status === "ACTIVE") return hasArrears ? "In Arrears" : "Good Standing"
  return status.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}
