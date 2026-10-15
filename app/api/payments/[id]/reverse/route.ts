import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { allocateReceipts, recomputeLoanBalances, nextPaymentDueDate } from "@/lib/loan/balances"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { CHARGES_FLAG_INCLUDE, chargesEnabled } from "@/lib/loan/charges-replay"
import { latestCashReceipt, resyncChargesIfLive, scheduleShareOfReceipts } from "@/lib/loan/receipt-charges"
import { restoreContractualBulletSchedule } from "@/lib/loan/settlement"
import { guardSentence } from "@/lib/asset-finance/recovery-result"
import { restampSchedulePaidAt } from "@/lib/loan/schedule-paid-at"

class PaymentAlreadyReversedError extends Error {}
class RecoveryProceedsKeptError extends Error {}

const PROCEEDS_KEPT = "This receipt is a recovery's sale proceeds and cannot be reversed"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("LOAN_ADMIN")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const { id } = await params
      const { reason } = await req.json() as { reason?: string }

      if (!reason?.trim()) {
        return NextResponse.json({ error: "Reversal reason required" }, { status: 422 })
      }

      const payment = await prisma.payment.findUnique({
        where: { id, tenantId: tenant.id },
        select: {
          id: true,
          loanId: true,
          amount: true,
          reversed: true,
          allocationStatus: true,
        },
      })

      if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 })
      if (payment.reversed) return NextResponse.json({ error: "Payment already reversed" }, { status: 409 })
      if (payment.allocationStatus !== "ALLOCATED") {
        return NextResponse.json(
          { error: "Only allocated payments can be reversed; use receipt reconciliation instead" },
          { status: 409 },
        )
      }

      const asOf = new Date()

      try {
        await prisma.$transaction(async (tx) => {
          // Serialise against concurrent receipts on this loan before touching its
          // balances — otherwise a payment landing mid-reversal is
          // lost from the re-derived totals.
          await lockLoanForUpdate(tx, payment.loanId)

          // A recovery's sale-proceeds receipt is kept (the database refuses it too:
          // Payment_recovery_proceeds_kept). Checked after the loan lock, which the
          // proceeds step also takes, so a race answers 409 rather than 500.
          const [recoveries, sales] = await Promise.all([
            tx.recovery.count({ where: { tenantId: tenant.id, proceedsPaymentId: id } }),
            tx.remarketingSale.count({ where: { tenantId: tenant.id, proceedsPaymentId: id } }),
          ])
          if (recoveries + sales > 0) throw new RecoveryProceedsKeptError()

          // The pre-transaction projection is only a fast-path. Claim the
          // reversal authoritatively after the loan lock so two staff requests
          // cannot overwrite actor/time/reason or emit duplicate evidence.
          const claimed = await tx.payment.updateMany({
            where: {
              id,
              tenantId: tenant.id,
              reversed: false,
              allocationStatus: "ALLOCATED",
            },
            data: {
              reversed: true,
              reversedAt: asOf,
              reversedById: guard.user.id,
              reversalReason: reason,
            },
          })
          if (claimed.count !== 1) throw new PaymentAlreadyReversedError()

          // An over-payment is stored as an allocated receipt plus an UNAPPLIED
          // "refund due" sibling. Reversing only the parent leaves the sibling
          // asserting the client is owed money for a deposit that, post-reversal
          // (a bounced EFT, say), was never received — and staff could pay it
          // out. Reversed rows are excluded from every total, so cascading here
          // retires the claim without deleting the evidence.
          //
          // Scoped to UNAPPLIED: once staff have actually paid the refund out,
          // reconcile flips the sibling to REFUNDED. Cascading over that row
          // would mark real disbursed cash as reversed, leaving neither a
          // receipt nor a refund in the ledger — the money would simply vanish
          // from the trail. A REFUNDED sibling is a recovery matter for a
          // human, not something to retire silently.
          const reversedExcess = await tx.payment.updateMany({
            where: {
              parentPaymentId: id,
              tenantId: tenant.id,
              reversed: false,
              allocationStatus: "UNAPPLIED",
            },
            data: {
              reversed: true,
              reversedAt: asOf,
              reversedById: guard.user.id,
              reversalReason: `Parent receipt reversed: ${reason}`,
            },
          })

          // Refunds already disbursed cannot be retired by reversing the
          // parent — the lender is out that cash and has to recover it. Counted
          // so the audit row states the obligation instead of losing it.
          const settledRefunds = await tx.payment.count({
            where: {
              parentPaymentId: id,
              tenantId: tenant.id,
              reversed: false,
              allocationStatus: "REFUNDED",
            },
          })

          const loan = await tx.loan.findUniqueOrThrow({
            where: { id: payment.loanId, tenantId: tenant.id },
            include: { repaymentSchedule: { orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }] }, tenant: CHARGES_FLAG_INCLUDE },
          })

        // Re-derive schedule + balances from the sum of the loan's remaining
        // (non-reversed) receipts. A reversal is NOT "add the gross amount back
        // to outstandingPrincipal" — that over-restores principal by the
        // interest+fees portion and leaves paid instalments marked PAID while
        // totalPaid drops. Both payment paths derive schedule state
        // from the same allocation so they can never disagree. Charge splits
        // are excluded (scheduleShareOfReceipts), flag on or off.
        const totalReceipts = await scheduleShareOfReceipts(tx, payment.loanId)

        const contractualRows = restoreContractualBulletSchedule({
          loan,
          schedule: loan.repaymentSchedule,
        })
        const perRowPaid = allocateReceipts(contractualRows, totalReceipts)
        const postRows = contractualRows.map((row, i) => ({
          ...row,
          totalPaid: perRowPaid[i],
        }))

        for (let i = 0; i < postRows.length; i++) {
          const before = loan.repaymentSchedule[i]
          const after = postRows[i]
          const isPaid = after.totalPaid >= after.totalDue
          const isPartial = after.totalPaid > 0 && !isPaid
          const status = isPaid ? "PAID" : isPartial ? "PARTIAL" : "PENDING"
          if (
            after.totalPaid === before.totalPaid
            && after.interestDue === before.interestDue
            && after.totalDue === before.totalDue
            && before.status === status
          ) continue
          await tx.repaymentSchedule.update({
            where: { id: after.id },
            data: {
              totalPaid: after.totalPaid,
              interestDue: after.interestDue,
              totalDue: after.totalDue,
              status,
              paidAt: isPaid ? (before.paidAt ?? asOf) : null,
            },
          })
        }
        // The loop skips a row whose amounts held, but the receipt that paid it
        // may be the one just reversed: re-date every row from the replay.
        // Fast path, not correctness: on a charges-live loan the sync below re-dates every row anyway.
        if (!chargesEnabled(loan)) {
          await restampSchedulePaidAt(tx, { tenantId: tenant.id, loanId: payment.loanId }, {
            source: "payment_reversal", userId: guard.user.id, userEmail: guard.user.email ?? null,
          })
        }

        const balances = recomputeLoanBalances(loan.principal, postRows, asOf)
        const restoredTotalInterest =
          loan.contractualTotalInterest ?? loan.totalInterest
        const restoredTotalRepayable =
          loan.contractualTotalRepayable ?? loan.totalRepayable
        const remainsCompleted = totalReceipts >= restoredTotalRepayable

        // Roll last-payment fields back to the most recent remaining receipt (or
        // clear them if the reversed payment was the only one).
        const latestRemaining = await latestCashReceipt(tx, payment.loanId)

          const nextStatus =
            remainsCompleted
              ? "COMPLETED"
              : loan.status === "COMPLETED"
                ? "ACTIVE"
                : loan.status
          const nextClosedAt = remainsCompleted
            ? loan.closedAt
            : loan.status === "COMPLETED"
              ? null
              : loan.closedAt

          await tx.loan.update({
            where: { id: payment.loanId, tenantId: tenant.id },
            data: {
            totalPaid: totalReceipts,
            totalInterest: restoredTotalInterest,
            totalRepayable: restoredTotalRepayable,
            outstandingPrincipal: balances.outstandingPrincipal,
            arrearsAmount: balances.arrearsAmount,
            daysInArrears: balances.daysInArrears,
            nextPaymentDate: nextPaymentDueDate(postRows),
            lastPaymentDate: latestRemaining?.receivedAt ?? null,
            lastPaymentAmount: latestRemaining?.amount ?? null,
            // Only re-open a previously-COMPLETED loan that the remaining
            // receipts no longer settle. NEVER clobber a DEFAULTED / WRITTEN_OFF
            // / RESTRUCTURED / CANCELLED status — a reversal on a written-off or
            // defaulted loan must not resurrect it onto the active book (review
            // C-1); the DPD cron re-derives DEFAULTED from arrears as needed.
              status: nextStatus,
              closedAt: nextClosedAt,
            },
          })

          // With charges live the replay re-derives charges, splits, totalPaid,
          // schedule and status; before the audit, which states the result.
          const synced = await resyncChargesIfLive(tx, loan, { tenantId: tenant.id, loanId: payment.loanId }, asOf, {
            source: "payment_reversal", userId: guard.user.id, userEmail: guard.user.email ?? null,
          }, "reversal")

          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: guard.user.id,
              userEmail: guard.user.email,
              action: AuditAction.PAYMENT_REVERSED,
              entity: "Payment",
              entityId: id,
              oldValue: {
                reversed: false,
                loanId: payment.loanId,
                loanStatus: loan.status,
                loanTotalPaid: loan.totalPaid,
              },
              newValue: {
                reversed: true,
                reversedAt: asOf.toISOString(),
                reason: reason.trim(),
                originalAmount: payment.amount,
                // Auditors must be able to see that the refund-due claim was
                // retired by this same action, not left standing.
                reversedExcessReceipts: reversedExcess.count,
                // Non-zero means real money was refunded against a receipt that
                // has now been reversed: a recovery the lender must chase.
                refundsAlreadyPaidOut: settledRefunds,
                loanId: payment.loanId,
                loanStatus: synced?.status ?? nextStatus,
                loanTotalPaid: synced?.totalPaid ?? totalReceipts,
                resultingTotalInterest: restoredTotalInterest,
                resultingTotalRepayable: restoredTotalRepayable,
              },
            },
          })
          if (nextStatus !== loan.status) {
            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: guard.user.id,
                userEmail: guard.user.email,
                action: AuditAction.LOAN_STATUS_CHANGED,
                entity: "Loan",
                entityId: payment.loanId,
                oldValue: {
                  status: loan.status,
                  closedAt: loan.closedAt?.toISOString() ?? null,
                },
                newValue: {
                  status: nextStatus,
                  closedAt: nextClosedAt?.toISOString() ?? null,
                  reason: "payment_reversed",
                  paymentId: id,
                },
              },
            })
          }
        })
      } catch (error) {
        if (error instanceof RecoveryProceedsKeptError || guardSentence(error)?.includes("sale-proceeds receipt is not reversed")) {
          return NextResponse.json({ error: PROCEEDS_KEPT }, { status: 409 })
        }
        if (error instanceof PaymentAlreadyReversedError) {
          return NextResponse.json(
            { error: "Payment already reversed" },
            { status: 409 },
          )
        }
        console.error(error)
        return NextResponse.json(
          { error: "Failed to reverse payment" },
          { status: 500 },
        )
      }

      return NextResponse.json({ success: true })
    })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: "Failed to reverse payment" }, { status: 500 })
  }
}
