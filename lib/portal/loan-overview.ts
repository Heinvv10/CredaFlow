import { recomputeLoanBalances, type ScheduleRowLike } from "@/lib/loan/balances"

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
  principal?: number
  /** When present, arrears are derived from it as of the view, not read from the nightly-stamped columns. */
  repaymentSchedule?: ScheduleRowLike[]
}

/**
 * Days overdue and the amount overdue as of `asOf`, from the schedule by the
 * one definition the DPD cron and payment paths use (lib/loan/balances.ts).
 * The stored daysInArrears/arrearsAmount are only as fresh as the last cron
 * run: the borrower was told 27 days on a day it was 29 (Fair Score audit
 * 2026-10-16).
 */
export function portalLoanArrears(loan: PortalOverviewLoan, asOf: Date): { days: number; amount: number } {
  if (!loan.repaymentSchedule || loan.principal === undefined) return { days: loan.daysInArrears, amount: 0 }
  const live = recomputeLoanBalances(loan.principal, loan.repaymentSchedule, asOf)
  return { days: live.daysInArrears, amount: live.arrearsAmount }
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
      repaymentSchedule: {
        orderBy: { dueDate: "asc" as const },
        select: { dueDate: true, principalDue: true, interestDue: true, feesDue: true, totalDue: true, totalPaid: true },
      },
    },
    orderBy: { startDate: "desc" as const },
  }
}

/**
 * Keep a live obligation prominent, but retain the latest historical loan
 * once the client has paid up. The caller supplies loans newest-first.
 */
export function projectPortalLoanOverview<T extends PortalOverviewLoan>(loans: readonly T[], asOf: Date = new Date()) {
  const openLoans = loans.filter((loan) => OPEN_PORTAL_LOAN_STATUS_SET.has(loan.status))
  const primaryLoan = openLoans[0] ?? loans[0] ?? null
  const arrears = openLoans.map((loan) => portalLoanArrears(loan, asOf))

  return {
    openLoans,
    primaryLoan,
    totalOutstanding: openLoans.reduce(
      (sum, loan) => sum + Number(loan.outstandingPrincipal),
      0,
    ),
    maxArrears: arrears.reduce((maximum, loan) => Math.max(maximum, loan.days), 0),
    /** Cents overdue across the open loans: what brings the account up to date, before charges. */
    overdueAmount: arrears.reduce((sum, loan) => sum + loan.amount, 0),
  }
}

export function portalLoanStatusLabel(status: string, hasArrears: boolean): string {
  if (status === "COMPLETED") return "Paid Up"
  if (status === "ACTIVE") return hasArrears ? "In Arrears" : "Good Standing"
  return status.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}
