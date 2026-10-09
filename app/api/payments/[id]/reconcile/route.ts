import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { CASH_RECEIPTS } from "@/lib/payments/waiver"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { recomputeLoanBalances, nextPaymentDueDate } from "@/lib/loan/balances"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { CHARGES_FLAG_INCLUDE, chargesEnabled } from "@/lib/loan/charges-replay"
import { projectChargeAwareReceipt } from "@/lib/loan/charge-aware-receipt"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import {
  backdatingInterestRebate,
  receiptContractualTotalsUpdate,
  SettlementOverpaymentError,
  settlementAuditEvidence,
} from "@/lib/loan/settlement"
import {
  rejectUnauthorisedBackdating,
  valueDateEvidence,
  VALUE_DATE_MESSAGES,
} from "@/lib/loan/value-date"
import { triggerNotification } from "@/lib/notifications"
import { closingValueDate } from "@/lib/loan/receipt-charges"
import { restampSchedulePaidAt } from "@/lib/loan/schedule-paid-at"
import { ChargesSyncRefused } from "@/lib/loan/charges-verdict"

class ReceiptReconciliationConflict extends Error {}
class ReceiptNotAllocatable extends Error {}
class ReceiptRebateNotAuthorised extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}
class ReceiptOverSettlement extends Error {
  constructor(readonly maxAmountCents: number) {
    super("Receipt exceeds current settlement")
  }
}

type ReconciliationAction = "allocate" | "record_refund"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const guard = await requireApiRole("LOAN_ADMIN")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const { id } = await params
      const body = await req.json() as {
        action?: ReconciliationAction
        reason?: string
        reference?: string
        valueDateOverrideReason?: string
      }
      const reason = body.reason?.trim()
      const reference = body.reference?.trim()
      // No role check here: this whole route already requires LOAN_ADMIN, so
      // anyone who can reach it is senior enough to authorise a rebate.
      //
      // Type-guarded to match the sibling in app/api/payments/route.ts: without
      // it a non-string calls .trim() and 500s, hiding a client bug in the
      // server log instead of naming it.
      if (
        body.valueDateOverrideReason != null
        && typeof body.valueDateOverrideReason !== "string"
      ) {
        return NextResponse.json(
          { error: "valueDateOverrideReason must be text" },
          { status: 400 },
        )
      }
      const valueDateOverrideReason = body.valueDateOverrideReason?.trim()

      if (body.action !== "allocate" && body.action !== "record_refund") {
        return NextResponse.json(
          { error: "action must be allocate or record_refund" },
          { status: 400 },
        )
      }
      if (!reason) {
        return NextResponse.json(
          { error: "Reconciliation reason required" },
          { status: 422 },
        )
      }
      if (!reference) {
        return NextResponse.json(
          { error: "Bank or refund reference required" },
          { status: 422 },
        )
      }

      // Resolve only the lock target outside the transaction. All authoritative
      // state is re-read after the loan lock, before any reconciliation claim.
      const candidate = await prisma.payment.findUnique({
        where: { id, tenantId: tenant.id },
        select: { id: true, loanId: true },
      })
      if (!candidate) {
        return NextResponse.json({ error: "Receipt not found" }, { status: 404 })
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          await lockLoanForUpdate(tx, candidate.loanId)

          const payment = await tx.payment.findUnique({
            where: { id, tenantId: tenant.id },
          })
          if (
            !payment
            || payment.loanId !== candidate.loanId
            || payment.reversed
            || payment.allocationStatus !== "UNAPPLIED"
          ) {
            throw new ReceiptReconciliationConflict()
          }

          const reconciledAt = new Date()

          if (body.action === "record_refund") {
            const claimed = await tx.payment.updateMany({
              where: {
                id,
                tenantId: tenant.id,
                reversed: false,
                allocationStatus: "UNAPPLIED",
              },
              data: {
                allocationStatus: "REFUNDED",
                reconciliationReason: reason,
                reconciliationReference: reference,
                reconciledAt,
                reconciledById: guard.user.id,
              },
            })
            if (claimed.count !== 1) throw new ReceiptReconciliationConflict()

            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: guard.user.id,
                userEmail: guard.user.email,
                action: AuditAction.PAYMENT_REFUND_RECORDED,
                entity: "Payment",
                entityId: id,
                oldValue: {
                  allocationStatus: "UNAPPLIED",
                  reconciliationReason: payment.reconciliationReason,
                },
                newValue: {
                  allocationStatus: "REFUNDED",
                  reason,
                  externalRefundReference: reference,
                  reconciledAt: reconciledAt.toISOString(),
                  amount: payment.amount,
                  loanId: payment.loanId,
                  // This action records evidence of an external refund already
                  // completed by staff; it never calls a banking provider.
                  initiatesMoneyMovement: false,
                },
              },
            })

            return {
              paymentId: id,
              loanId: payment.loanId,
              allocationStatus: "REFUNDED" as const,
              initiatesMoneyMovement: false,
            }
          }

          const loan = await tx.loan.findUnique({
            where: { id: payment.loanId, tenantId: tenant.id },
            include: {
              repaymentSchedule: { orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }] },
              tenant: CHARGES_FLAG_INCLUDE,
            },
          })
          if (!loan || !["ACTIVE", "DEFAULTED"].includes(loan.status)) {
            throw new ReceiptNotAllocatable()
          }
          const chargesRef = { tenantId: tenant.id, loanId: payment.loanId }
          const chargesOn = chargesEnabled(loan)

          let projection
          let chargesBackdating
          try {
            ({ projection, chargesBackdating } = await projectChargeAwareReceipt(tx, {
              loan,
              schedule: loan.repaymentSchedule,
              amount: payment.amount,
              // Priced at the VALUE date, not reconcile time. This screen is by
              // definition where delayed receipts land, so pricing at reconcile
              // time charges the client for the entire delay — the exact gap
              // this column exists to close. On a R500 000 PO Funding loan a
              // 21-day lag is R8 750 of interest the consumer never incurred,
              // on a statement that prints the value date beside it.
              //
              // The PRICING is guarded by the DAILY_ACCRUAL case in
              // route.test.ts, which fails if this reverts to `reconciledAt`.
              // It has to be DAILY_ACCRUAL: FLAT is not re-priced by date and
              // cannot observe this at all. The separate question of whether
              // the rebate is ALLOWED is enforced below, not here.
              receivedAt: payment.receivedAt,
              asOf: reconciledAt,
            }))
          } catch (error) {
            if (error instanceof SettlementOverpaymentError) {
              throw new ReceiptOverSettlement(error.maxAmountCents)
            }
            throw error
          }

          // The rebate is bounded HERE as well as at capture, because the bound
          // is measured against interest accrued as at NOW. A receipt whose
          // one-day back-date was trivially within the limit when it was
          // created rebates every day it then sat UNAPPLIED — so a receipt that
          // passed on the way in can breach the same limit on the way out.
          // Measured with backdatingInterestRebate, not projection.interestRebate:
          // the latter also contains the lawful s125 early-settlement rebate
          // every client earns by paying early, and bounding that would refuse
          // ordinary early settlements.
          const backdating = backdatingInterestRebate({
            loan,
            schedule: loan.repaymentSchedule,
            asOf: reconciledAt,
            receivedAt: payment.receivedAt,
          })
          const override = valueDateOverrideReason
            ? {
                reason: valueDateOverrideReason,
                approvedById: guard.user.id,
                approvedByEmail: guard.user.email ?? null,
              }
            : null
          // Default charges erased by the date count too.
          const rebateRejection = rejectUnauthorisedBackdating({
            interest: backdating,
            charges: chargesBackdating,
            override,
          })
          if (rebateRejection) {
            throw new ReceiptRebateNotAuthorised(
              VALUE_DATE_MESSAGES[rebateRejection],
            )
          }

          const claimed = await tx.payment.updateMany({
            where: {
              id,
              tenantId: tenant.id,
              reversed: false,
              allocationStatus: "UNAPPLIED",
            },
            data: {
              allocationStatus: "ALLOCATED",
              reconciliationReason: reason,
              reconciliationReference: reference,
              reconciledAt,
              reconciledById: guard.user.id,
            },
          })
          if (claimed.count !== 1) throw new ReceiptReconciliationConflict()

          const postRows = projection.rows
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
                paidAt: isPaid ? (before.paidAt ?? payment.receivedAt) : null,
              },
            })
          }
          // A held receipt dated before one already on the loan changes which
          // receipt completed rows the loop skipped: re-date every row from the replay.
          if (!chargesOn) {
            await restampSchedulePaidAt(tx, chargesRef, {
              source: "reconcile", userId: guard.user.id, userEmail: guard.user.email ?? null,
            })
          }

          const balances = recomputeLoanBalances(
            loan.principal,
            postRows,
            reconciledAt,
          )
          const latestAllocated = await tx.payment.findFirst({
            where: {
              loanId: payment.loanId,
              tenantId: tenant.id,
              reversed: false,
              allocationStatus: "ALLOCATED",
              // The last PAYMENT (Certificate of Balance): a waiver is not one.
              ...CASH_RECEIPTS,
            },
            orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
            select: { amount: true, createdAt: true, receivedAt: true },
          })
          const nextStatus = projection.isCompleted ? "COMPLETED" : loan.status
          // Closed when the money arrived, matching the other two writers —
          // otherwise the same settlement carries a different closedAt
          // depending on which screen booked it.
          const nextClosedAt = projection.isCompleted
            ? await closingValueDate(tx, payment.loanId, payment.receivedAt)
            : loan.closedAt

          await tx.loan.update({
            where: { id: payment.loanId, tenantId: tenant.id },
            data: {
              totalPaid: projection.newTotalPaid,
              totalInterest: projection.totalInterest,
              totalRepayable: projection.totalRepayable,
              ...receiptContractualTotalsUpdate(projection),
              outstandingPrincipal: balances.outstandingPrincipal,
              arrearsAmount: balances.arrearsAmount,
              daysInArrears: balances.daysInArrears,
              nextPaymentDate: nextPaymentDueDate(postRows),
              lastPaymentDate: latestAllocated?.receivedAt ?? payment.receivedAt,
              lastPaymentAmount: latestAllocated?.amount ?? payment.amount,
              status: nextStatus,
              closedAt: nextClosedAt,
            },
          })

          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: guard.user.id,
              userEmail: guard.user.email,
              action: AuditAction.PAYMENT_ALLOCATED,
              entity: "Payment",
              entityId: id,
              oldValue: {
                allocationStatus: "UNAPPLIED",
                loanStatus: loan.status,
                loanTotalPaid: loan.totalPaid,
                reconciliationReason: payment.reconciliationReason,
              },
              newValue: {
                allocationStatus: "ALLOCATED",
                reason,
                bankReference: reference,
                reconciledAt: reconciledAt.toISOString(),
                amount: payment.amount,
                loanId: payment.loanId,
                loanStatus: nextStatus,
                loanTotalPaid: projection.newTotalPaid,
                // The date this was priced at, how far back that reached, and
                // who authorised it — the same evidence the other two writers
                // record, so an auditor sees one shape across all three.
                ...valueDateEvidence({
                  receivedAt: payment.receivedAt,
                  asOf: reconciledAt,
                  // NOT "STAFF_ASSERTED": the admin reconciling this receipt did
                  // not choose its date — whoever created it did, and Payment
                  // does not record whether that was a bank import or a person.
                  // Claiming otherwise would contradict the bank-sync audit row
                  // for the same receipt.
                  source: "UNKNOWN_INHERITED",
                  interestRebateCents:
                    backdating.rebateCents + chargesBackdating.rebateCents,
                  defaultChargesRebateCents: chargesBackdating.rebateCents,
                  override,
                }),
                ...settlementAuditEvidence(projection),
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
                oldValue: { status: loan.status },
                newValue: {
                  status: nextStatus,
                  reason: "settled_by_reconciled_receipt",
                  paymentId: id,
                },
              },
            })
          }

          // Last, so the audit trail reads in write order: the replay settles
          // how the receipt splits between charges and the schedule.
          const synced = chargesOn
            ? await syncLoanCharges(tx, chargesRef, reconciledAt, {
                source: "reconcile",
                userId: guard.user.id,
                userEmail: guard.user.email ?? null,
              })
            : null

          await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
          return {
            paymentId: id,
            loanId: payment.loanId,
            allocationStatus: "ALLOCATED" as const,
            loanStatus: synced?.status ?? nextStatus,
            loanTotalPaid: synced?.totalPaid ?? projection.newTotalPaid,
            amount: payment.amount,
          }
        })

        if (result.allocationStatus === "ALLOCATED") {
          // The webhook deliberately withheld the ordinary "account updated"
          // message while this money was unapplied. Emit it only after the
          // allocation and its mandatory audit evidence have committed.
          triggerNotification({
            tenantId: tenant.id,
            event: "payment_received",
            loanId: result.loanId,
            data: {
              amount: result.amount,
              paymentId: result.paymentId,
              allocationStatus: result.allocationStatus,
            },
          }).catch((error) => {
            console.error(
              "Reconciled payment notification failed:",
              error,
            )
          })
        }

        return NextResponse.json(result)
      } catch (error) {
        if (error instanceof ChargesSyncRefused) {
          return NextResponse.json({ error: error.message }, { status: 409 })
        }
        if (error instanceof ReceiptReconciliationConflict) {
          return NextResponse.json(
            { error: "Receipt has already been reconciled or is not eligible" },
            { status: 409 },
          )
        }
        if (error instanceof ReceiptNotAllocatable) {
          return NextResponse.json(
            { error: "Loan status does not allow receipt allocation" },
            { status: 409 },
          )
        }
        if (error instanceof ReceiptRebateNotAuthorised) {
          return NextResponse.json(
            { error: error.reason, requiresValueDateOverride: true },
            { status: 422 },
          )
        }
        if (error instanceof ReceiptOverSettlement) {
          return NextResponse.json(
            {
              error: "Receipt exceeds the current settlement amount",
              maxAmountCents: error.maxAmountCents,
            },
            { status: 422 },
          )
        }
        throw error
      }
    })
  } catch (error) {
    console.error("Failed to reconcile receipt:", error)
    return NextResponse.json(
      { error: "Failed to reconcile receipt" },
      { status: 500 },
    )
  }
}
