import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { triggerNotification } from "@/lib/notifications"
import { AuditAction } from "@/lib/audit"
import { recomputeLoanBalances, nextPaymentDueDate } from "@/lib/loan/balances"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { CHARGES_FLAG_INCLUDE } from "@/lib/loan/charges-replay"
import { loadReceiptReplay, projectReceiptWithReplay } from "@/lib/loan/charge-aware-receipt"
import { resyncChargesIfLive } from "@/lib/loan/receipt-charges"
import { issueLeaseInvoicesOnReceipt } from "@/lib/asset-finance/lease-invoices"
import { sastCalendarDate } from "@/lib/date/sast"
import { ChargesError } from "@/lib/loan/charges-error"
import { holdStitchReceipt, recordHeldReceipt } from "@/lib/payments/held-receipt"
import {
  backdatingInterestRebate,
  receiptContractualTotalsUpdate,
  settlementAuditEvidence,
} from "@/lib/loan/settlement"
import { rejectUnauthorisedBackdating } from "@/lib/loan/value-date"
import { writeReceiptSchedule } from "@/lib/loan/write-schedule"

import type { Prisma } from "@prisma/client"

export type StitchPaymentWithLoan = Prisma.StitchPaymentRequestGetPayload<{
  include: { loan: { select: { tenantId: true } } }
}>

/** How long after the payment request opened its webhook may still date the receipt by it. */
export const STITCH_VALUE_DATE_WINDOW_MS = 60 * 60 * 1000
/** reconciliationReason of a Stitch receipt held because its value date is not known. */
export const STITCH_VALUE_DATE_UNCONFIRMED = "stitch_value_date_unconfirmed"

class AlreadyCompletedError extends Error {
  constructor() {
    super("StitchPaymentRequest already completed")
  }
}

export async function settleReceipt(
  stitchPayment: StitchPaymentWithLoan,
  stitchId: string,
  tenantId: string,
) {
  let payment: {
    id: string
    allocationStatus: "ALLOCATED" | "UNAPPLIED" | "REFUNDED"
  }
  try {
    payment = await prisma.$transaction(async (tx) => {
      // Serialise against concurrent receipts on this loan before reading its
      // balances for allocation.
      await lockLoanForUpdate(tx, stitchPayment.loanId)

      const result = await tx.stitchPaymentRequest.updateMany({
        where: { id: stitchPayment.id, status: { not: "COMPLETED" } },
        data: { status: "COMPLETED" },
      })
      if (result.count === 0) throw new AlreadyCompletedError()

      // The value date is when the client paid. The event names no paid-at
      // time we read (GATED: Stitch's own timestamp, once its event schema is
      // confirmed), so it is when they opened the payment request, provided
      // the webhook lands within STITCH_VALUE_DATE_WINDOW_MS of it: a payment
      // just before midnight is still priced on its day, and the s125 figure
      // the client was shown settles the loan. A later webhook could date the
      // money long before it moved, so it is held for staff to value-date,
      // settling or not. `asOf` stays now for arrears and charges.
      const asOf = new Date()
      const opened = stitchPayment.createdAt
      const openedRecently = asOf.getTime() - opened.getTime() <= STITCH_VALUE_DATE_WINDOW_MS
      const receivedAt = openedRecently && opened < asOf ? opened : asOf
      const createReceipt = (
        allocationStatus: "ALLOCATED" | "UNAPPLIED",
        reconciliationReason?: string,
      ) => tx.payment.create({
        data: {
          tenantId,
          loanId: stitchPayment.loanId,
          amount: stitchPayment.amount,
          paymentMethod: "EFT",
          reference: stitchPayment.externalReference,
          notes: `Stitch instant EFT — id: ${stitchId}`,
          receivedAt,
          allocationStatus,
          reconciliationReason,
        },
      })

      const loan = await tx.loan.findUnique({
        where: { id: stitchPayment.loanId },
        include: {
          // ALL rows (incl. PAID), earliest due first — balances are recomputed
          // from the full schedule (mirrors app/api/payments/route.ts).
          repaymentSchedule: {
            orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }],
          },
          tenant: CHARGES_FLAG_INCLUDE,
        },
      })

      // Stitch has already moved real money, so every terminal branch persists
      // a receipt. Only allocate against the schedule when the
      // loan is in a state that still owes on that schedule (policy:
      // ACTIVE+DEFAULTED allocate; PENDING_WRITE_OFF/WRITTEN_OFF/COMPLETED/etc
      // need manual reconciliation instead).
      if (loan && ["ACTIVE", "DEFAULTED"].includes(loan.status) && !openedRecently) {
        return await recordHeldReceipt(tx, {
          tenantId, loanId: stitchPayment.loanId, amount: stitchPayment.amount, paymentMethod: "EFT",
          reference: stitchPayment.externalReference,
          notes: `Stitch instant EFT — id: ${stitchId}; request opened ${opened.toISOString()}`,
          receivedAt, reason: STITCH_VALUE_DATE_UNCONFIRMED, oldValue: { status: loan.status, totalPaid: loan.totalPaid },
          source: "stitch_webhook",
        })
      }
      if (loan && ["ACTIVE", "DEFAULTED"].includes(loan.status)) {
        // Loaded outside the try: its catch reads every failure as over-settlement.
        const replay = await loadReceiptReplay(tx, loan, asOf)
        let projection
        let chargesBackdating
        try {
          ;({ projection, chargesBackdating } = projectReceiptWithReplay(replay, {
            loan, schedule: loan.repaymentSchedule, amount: stitchPayment.amount, receivedAt, asOf,
          }))
        } catch (error) {
          const newPayment = await createReceipt(
            "UNAPPLIED",
            "amount_exceeds_current_settlement",
          )
          // Real money has already arrived, so retain the receipt but do not
          // corrupt the contractual balance. This should only be reachable if
          // another receipt landed after initiation; staff must reconcile the
          // unapplied excess/refund explicitly.
          console.error(
            `[webhook] received amount exceeds current settlement; retained for manual reconciliation. loanId=${loan.id} paymentId=${newPayment.id} error=${error instanceof Error ? error.message : String(error)}`,
          )
          await tx.auditLog.create({
            data: {
              tenantId,
              userId: null,
              userEmail: null,
              action: AuditAction.PAYMENT_RECORDED,
              entity: "Loan",
              entityId: stitchPayment.loanId,
              oldValue: {
                status: loan.status,
                totalPaid: loan.totalPaid,
              },
              newValue: {
                paymentId: newPayment.id,
                amount: stitchPayment.amount,
                method: "EFT",
                reference: stitchPayment.externalReference,
                source: "stitch_webhook",
                allocated: false,
                reconciliationRequired: true,
                reason: "amount_exceeds_current_settlement",
              },
            },
          })
          return newPayment
        }
        // The value date is bounded as for every receipt: one that waives more
        // than may stand unreviewed (an instalment that fell due in between,
        // say) is held for staff, who allocate it with a reason or not at all.
        const backdating = rejectUnauthorisedBackdating({
          interest: backdatingInterestRebate({
            loan, schedule: loan.repaymentSchedule, asOf, receivedAt, settles: projection.isCompleted,
          }),
          charges: chargesBackdating,
        })
        if (backdating) {
          return await recordHeldReceipt(tx, {
            tenantId, loanId: stitchPayment.loanId, amount: stitchPayment.amount, paymentMethod: "EFT",
            reference: stitchPayment.externalReference, notes: `Stitch instant EFT — id: ${stitchId}`,
            receivedAt, reason: backdating, oldValue: { status: loan.status, totalPaid: loan.totalPaid },
            source: "stitch_webhook",
          })
        }
        const newPayment = await createReceipt("ALLOCATED")
        const postRows = projection.rows

        await writeReceiptSchedule(tx, loan.repaymentSchedule, postRows, { tenantId, paidAt: receivedAt })

        // Recompute outstanding principal + arrears + DPD from the full
        // post-payment schedule.
        const balances = recomputeLoanBalances(loan.principal, postRows, asOf)
        const newTotalPaid = projection.newTotalPaid
        const isCompleted = projection.isCompleted

        await tx.loan.update({
          where: { id: stitchPayment.loanId },
          data: {
            totalPaid: newTotalPaid,
            totalInterest: projection.totalInterest,
            totalRepayable: projection.totalRepayable,
            ...receiptContractualTotalsUpdate(projection),
            outstandingPrincipal: balances.outstandingPrincipal,
            lastPaymentDate: loan.lastPaymentDate && loan.lastPaymentDate > receivedAt ? loan.lastPaymentDate : receivedAt,
            lastPaymentAmount: stitchPayment.amount,
            nextPaymentDate: nextPaymentDueDate(postRows),
            status: isCompleted ? "COMPLETED" : loan.status,
            closedAt: isCompleted ? receivedAt : loan.closedAt,
            daysInArrears: balances.daysInArrears,
            arrearsAmount: balances.arrearsAmount,
          },
        })
        await tx.auditLog.create({
          data: {
            tenantId,
            userId: null,
            userEmail: null,
            action: AuditAction.PAYMENT_RECORDED,
            entity: "Loan",
            entityId: stitchPayment.loanId,
            oldValue: {
              status: loan.status,
              totalPaid: loan.totalPaid,
              totalInterest: loan.totalInterest,
              totalRepayable: loan.totalRepayable,
            },
            newValue: {
              paymentId: newPayment.id,
              amount: stitchPayment.amount,
              method: "EFT",
              reference: stitchPayment.externalReference,
              source: "stitch_webhook",
              allocated: true,
              status: isCompleted ? "COMPLETED" : loan.status,
              totalPaid: newTotalPaid,
              ...settlementAuditEvidence(projection),
            },
          },
        })
        // Last, so the audit trail reads in write order.
        await resyncChargesIfLive(tx, loan, { tenantId: loan.tenantId, loanId: loan.id }, asOf, { source: "stitch_webhook" })
        // A lease rental this payment reached before its due date is invoiced now.
        await issueLeaseInvoicesOnReceipt(tx, {
          tenantId: loan.tenantId, loanId: loan.id, contractType: loan.contractType,
          today: sastCalendarDate(new Date()), createdById: null,
        })
        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
        return newPayment
      } else {
        const newPayment = await recordHeldReceipt(tx, {
          tenantId, loanId: stitchPayment.loanId, amount: stitchPayment.amount, paymentMethod: "EFT",
          reference: stitchPayment.externalReference, notes: `Stitch instant EFT — id: ${stitchId}`,
          receivedAt: new Date(), reason: "loan_not_allocatable", oldValue: { status: loan?.status ?? null },
          source: "stitch_webhook",
        })
        console.error(
          `[webhook] payment received on non-allocatable loan status=${loan?.status ?? "UNKNOWN"}, needs manual reconciliation. loanId=${stitchPayment.loanId} paymentId=${newPayment.id}`
        )
        return newPayment
      }
    })
  } catch (err) {
    if (err instanceof AlreadyCompletedError) {
      return NextResponse.json({ ok: true, replayed: true })
    }
    if (!(err instanceof ChargesError)) throw err
    // The money has arrived: hold it for reconciliation, never roll it back
    // into a provider retry loop.
    const held = await holdStitchReceipt(prisma, stitchPayment, stitchId, tenantId, err)
    if (!held) return NextResponse.json({ ok: true, replayed: true })
    payment = held
  }

  if (payment.allocationStatus === "ALLOCATED") {
    triggerNotification({
      tenantId,
      event: "payment_received",
      loanId: stitchPayment.loanId,
      clientId: stitchPayment.clientId,
      data: {
        amount: stitchPayment.amount,
        paymentId: payment.id,
        allocationStatus: payment.allocationStatus,
      },
    }).catch((err) => {
      console.error("[webhook] payment_received notification failed:", err)
    })
  } else {
    // The existing payment_received templates say the account is updated and
    // display a balance. That would be false while this receipt is held, so do
    // not emit them. The durable receipt, audit row and portal status remain
    // visible while staff reconcile it.
    console.error(
      `[webhook] customer payment_received notification withheld because receipt is ${payment.allocationStatus}. paymentId=${payment.id}`,
    )
  }

  return NextResponse.json({ ok: true })
}
