/**
 * What staff read off the loan and reconciliation screens, read through the
 * simulator's read-only connection (sim/readonly-db.ts): the app serves these
 * as server-rendered pages, not JSON. Nothing here writes.
 */
import { southAfricanCalendarDate } from "../../../lib/compliance/sa-business-days"
import { readDb } from "../sim/readonly-db"

export interface ScheduleRow {
  installmentNo: number
  /** SAST calendar day the instalment falls due. */
  dueDay: string
  totalDue: number
  totalPaid: number
}

export interface LoanView {
  id: string
  reference: string
  status: string
  collectionsStage: string
  daysInArrears: number
  arrearsAmount: number
  outstandingPrincipal: number
  rows: ScheduleRow[]
}

export async function readLoan(loanId: string): Promise<LoanView> {
  const loan = await readDb().loan.findUnique({
    where: { id: loanId },
    select: {
      id: true, reference: true, status: true, collectionsStage: true,
      daysInArrears: true, arrearsAmount: true, outstandingPrincipal: true,
      repaymentSchedule: {
        orderBy: { installmentNo: "asc" },
        select: { installmentNo: true, dueDate: true, totalDue: true, totalPaid: true },
      },
    },
  })
  if (!loan) throw new Error(`loan ${loanId} not found`)
  return {
    id: loan.id,
    reference: loan.reference,
    status: loan.status,
    collectionsStage: loan.collectionsStage,
    daysInArrears: loan.daysInArrears,
    arrearsAmount: loan.arrearsAmount,
    outstandingPrincipal: loan.outstandingPrincipal,
    rows: loan.repaymentSchedule.map((r) => ({
      installmentNo: r.installmentNo,
      dueDay: southAfricanCalendarDate(r.dueDate),
      totalDue: r.totalDue,
      totalPaid: r.totalPaid,
    })),
  }
}

export interface StatementLine {
  txnId: string
  /** UNMATCHED | PROPOSED | MATCHED | IGNORED */
  matchStatus: string
  matchedLoanId: string | null
  amountCents: number
  postedDay: string
  /** The statement's Description cell, as imported. */
  description: string | null
}

/** Every line of one statement import, as the reconciliation screen lists them. */
export async function statementLines(importId: string): Promise<StatementLine[]> {
  const rows = await readDb().bankTransaction.findMany({
    where: { importId },
    select: { id: true, matchStatus: true, matchedLoanId: true, amountCents: true, postedDate: true, rawReference: true },
    orderBy: { postedDate: "asc" },
  })
  return rows.map((r) => ({
    txnId: r.id,
    matchStatus: r.matchStatus,
    matchedLoanId: r.matchedLoanId,
    amountCents: r.amountCents,
    postedDay: r.postedDate.toISOString().slice(0, 10),
    description: r.rawReference,
  }))
}
