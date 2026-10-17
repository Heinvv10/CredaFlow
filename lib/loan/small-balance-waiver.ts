import type { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { nextPaymentDueDate, recomputeLoanBalances } from "@/lib/loan/balances"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import {
  CHARGES_FLAG_INCLUDE,
  chargesEnabled,
  chargesOutstandingAt,
} from "@/lib/loan/charges-replay"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import {
  currentSettlementAmount,
  projectReceipt,
  receiptContractualTotalsUpdate,
  settlementAuditEvidence,
} from "@/lib/loan/settlement"
import { writeReceiptSchedule } from "@/lib/loan/write-schedule"
import { WAIVER_METHOD } from "@/lib/payments/waiver"

// Closes a loan whose whole remaining balance is a sub-R1 residue (typically a
// rounding cent left by a client who paid the rounded figure). ALL money is
// CENTS. The residue is booked as a non-cash WAIVER Payment so the loan settles
// through exactly the projection, allocation and DB guards a receipt uses;
// lib/payments/waiver.ts keeps it out of every cash-collected figure. A waiver
// only reduces what the consumer owes, which a variation may do without
// re-signing (NCA s116(a)).

export const MAX_WAIVABLE_BALANCE_CENTS = 100

export type WaiverRefusal = "NOT_FOUND" | "NOT_ACTIVE" | "NOT_SMALL"

export class SmallBalanceWaiverError extends Error {
  constructor(readonly code: WaiverRefusal, readonly settlementDueCents?: number) {
    super(code)
    this.name = "SmallBalanceWaiverError"
  }
}

export async function waiveSmallBalance(
  db: Pick<typeof prisma, "$transaction">,
  input: { tenantId: string; loanId: string; reason: string; userId: string; userEmail: string | null },
): Promise<{ paymentId: string; amountCents: number }> {
  return await db.$transaction(async (tx) => {
    await lockLoanForUpdate(tx, input.loanId)
    const loan = await tx.loan.findUnique({
      where: { id: input.loanId, tenantId: input.tenantId },
      include: {
        repaymentSchedule: { orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }] },
        tenant: CHARGES_FLAG_INCLUDE,
      },
    })
    if (!loan) throw new SmallBalanceWaiverError("NOT_FOUND")
    if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") {
      throw new SmallBalanceWaiverError("NOT_ACTIVE")
    }

    const asOf = new Date()
    const ref = { tenantId: input.tenantId, loanId: input.loanId }
    const chargesOn = chargesEnabled(loan)
    const chargesOutstanding = chargesOn ? await chargesOutstandingAt(tx, ref, asOf) : 0
    // Charge-inclusive, so a residue made of default charges closes too.
    const due = currentSettlementAmount({
      loan, schedule: loan.repaymentSchedule, asOf, chargesOutstanding,
    })
    if (due < 1 || due > MAX_WAIVABLE_BALANCE_CENTS) {
      throw new SmallBalanceWaiverError("NOT_SMALL", due)
    }
    const projection = projectReceipt({
      loan, schedule: loan.repaymentSchedule, amount: due, asOf, chargesOutstanding,
    })

    const payment = await tx.payment.create({
      data: {
        tenantId: input.tenantId,
        loanId: input.loanId,
        amount: due,
        paymentMethod: WAIVER_METHOD,
        receivedAt: asOf,
        capturedBy: input.userId,
        notes: `Small balance waived: ${input.reason}`,
      },
    })

    await writeReceiptSchedule(tx, loan.repaymentSchedule, projection.rows, {
      tenantId: input.tenantId, paidAt: asOf, keepEarlierPaidAt: true,
    })

    const balances = recomputeLoanBalances(loan.principal, projection.rows, asOf)
    await tx.loan.update({
      where: { id: input.loanId, tenantId: input.tenantId },
      // lastPaymentDate/Amount deliberately untouched: they print on the
      // Certificate of Balance as the client's last payment, and a waiver is not one.
      data: {
        totalPaid: projection.newTotalPaid,
        totalInterest: projection.totalInterest,
        totalRepayable: projection.totalRepayable,
        ...receiptContractualTotalsUpdate(projection),
        outstandingPrincipal: balances.outstandingPrincipal,
        nextPaymentDate: nextPaymentDueDate(projection.rows),
        daysInArrears: balances.daysInArrears,
        arrearsAmount: balances.arrearsAmount,
        status: projection.isCompleted ? "COMPLETED" : loan.status,
        closedAt: projection.isCompleted ? asOf : loan.closedAt,
      },
    })

    const actor = { tenantId: input.tenantId, userId: input.userId, userEmail: input.userEmail }
    await tx.auditLog.create({
      data: {
        ...actor,
        action: AuditAction.SMALL_BALANCE_WAIVED,
        entity: "Loan",
        entityId: input.loanId,
        oldValue: { status: loan.status, totalPaid: loan.totalPaid },
        newValue: {
          paymentId: payment.id,
          amountCents: due,
          reason: input.reason,
          chargesOutstanding,
          ...settlementAuditEvidence(projection),
        },
      },
    })
    if (projection.isCompleted) {
      await tx.auditLog.create({
        data: {
          ...actor,
          action: AuditAction.LOAN_STATUS_CHANGED,
          entity: "Loan",
          entityId: input.loanId,
          oldValue: { status: loan.status, closedAt: loan.closedAt?.toISOString() ?? null },
          newValue: {
            status: "COMPLETED",
            closedAt: asOf.toISOString(),
            reason: "settled_by_small_balance_waiver",
            paymentId: payment.id,
          },
        },
      })
    }
    if (chargesOn) {
      await syncLoanCharges(tx, ref, asOf, {
        source: "small_balance_waiver", userId: input.userId, userEmail: input.userEmail,
      })
    }
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    return { paymentId: payment.id, amountCents: due }
  })
}
