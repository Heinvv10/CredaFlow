import type { prisma } from "@/lib/prisma"
import { allocateReceipts, recomputeLoanBalances, type ScheduleRowLike } from "@/lib/loan/balances"
import type { ContractualRow, SettlementLoanLike } from "@/lib/loan/settlement"
import {
  ContractualScheduleMissingError, isRepricedInstalmentLoan, loadSettlementEvidence, restoreContractualSchedule,
} from "@/lib/loan/contractual-schedule"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"

// The loan book as it stood at a past instant, rebuilt from receipts.
//
// There is no stored history of Loan.outstandingPrincipal — it is overwritten
// on every payment. The reports overview used to compare today's book with
// "today's balance of loans that started before this month", which is not last
// month's book: every receipt since then shrank it and every loan settled since
// then vanished from it, so month-on-month growth was overstated every month.
//
// The rebuild re-runs the derivation the payment and reversal paths use
// (allocateReceipts → recomputeLoanBalances over the contractual schedule), fed
// only the receipts that were live at `asOf`, so at `asOf = now` it reproduces
// the stored outstandingPrincipal.
//
// It assumes every schedule payment is a Payment row. The admin schedule route
// (/api/loans/[id]/schedule/[scheduleId]) that used to set totalPaid by hand
// no longer can.

export interface AsOfReceipt {
  amount: number
  receivedAt: Date
  reversed: boolean
  reversedAt: Date | null
  allocationStatus: "ALLOCATED" | "UNAPPLIED" | "REFUNDED"
  defaultInterestAllocated: number
  chargeFeesAllocated: number
}

export interface AsOfLoan extends SettlementLoanLike {
  closedAt: Date | null
  /** an early instalment settlement's recorded contractual rows (lib/loan/contractual-schedule.ts) */
  contractualRows?: ContractualRow[] | null
  repaymentSchedule: Array<ScheduleRowLike & { id: string }>
  payments: AsOfReceipt[]
}

/** Receipts on the schedule at `asOf`: received before it, not yet reversed, less the default-charge splits. */
function scheduleShareAsOf(receipts: AsOfReceipt[], asOf: Date): number {
  return receipts
    .filter((r) =>
      r.allocationStatus === "ALLOCATED"
      && r.receivedAt < asOf
      && (!r.reversed || (r.reversedAt !== null && r.reversedAt >= asOf)))
    .reduce((sum, r) => sum + r.amount - r.defaultInterestAllocated - r.chargeFeesAllocated, 0)
}

export function outstandingPrincipalAsOf(loan: AsOfLoan, asOf: Date): number {
  const schedule = [...loan.repaymentSchedule].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
  // An early settlement re-prices the schedule to what it earned; before the
  // loan closed, the contractual rows are what the receipts were paid against.
  const settled = loan.closedAt !== null && loan.closedAt <= asOf
  const rows = settled ? schedule : restoreContractualSchedule({ loan, schedule, contractualRows: loan.contractualRows ?? null })
  const paid = allocateReceipts(rows, scheduleShareAsOf(loan.payments, asOf))
  return recomputeLoanBalances(
    loan.principal,
    rows.map((row, i) => ({ ...row, totalPaid: paid[i] })),
    asOf,
  ).outstandingPrincipal
}

/**
 * The collectible book at `asOf` (lib/loan/collectible-book.ts), so it compares
 * like-for-like with the collectible book today: loans disbursed before `asOf`
 * that are collectible now, or that left the book — closed or written off —
 * after it. There is no status history, so a loan's status at `asOf` is not
 * known; leaving the book is dated, which is why the population is built from
 * the exits rather than from a status filter.
 */
export async function loadBookAsOf(
  db: Pick<typeof prisma, "loan" | "auditLog" | "payment" | "repaymentSchedule" | "bankTransaction">,
  tenantId: string,
  asOf: Date,
): Promise<number> {
  const loans = await db.loan.findMany({
    where: {
      tenantId,
      startDate: { lt: asOf },
      OR: [
        { status: { in: [...COLLECTIBLE_STATUSES] } },
        { closedAt: { gte: asOf } },
        { writeOffAt: { gte: asOf } },
      ],
    },
    select: {
      id: true, principal: true, totalInterest: true, totalRepayable: true,
      contractualTotalInterest: true, contractualTotalRepayable: true,
      totalPaid: true, interestRatePm: true, interestModel: true,
      startDate: true, maturityDate: true, closedAt: true, ncaRegime: true, contractType: true,
      repaymentSchedule: {
        select: {
          id: true, installmentNo: true, dueDate: true, principalDue: true, interestDue: true, feesDue: true,
          creditLifePremiumDue: true, totalDue: true, totalPaid: true,
        },
      },
      payments: {
        select: {
          amount: true, receivedAt: true, reversed: true, reversedAt: true, allocationStatus: true,
          defaultInterestAllocated: true, chargeFeesAllocated: true,
        },
      },
    },
  })
  // An s125 re-priced loan without its settlement evidence is refused rather
  // than rebuilt on the re-priced rows, which would understate the book.
  const repriced = loans.filter((loan) => isRepricedInstalmentLoan(loan, loan.repaymentSchedule))
  const evidence = await loadSettlementEvidence(db, tenantId, repriced.map((loan) => loan.id))
  for (const loan of repriced) if (!evidence.has(loan.id)) throw new ContractualScheduleMissingError(loan.id)
  return loans.reduce((sum, loan) => sum + outstandingPrincipalAsOf({ ...loan, contractualRows: evidence.get(loan.id)?.rows ?? null }, asOf), 0)
}
