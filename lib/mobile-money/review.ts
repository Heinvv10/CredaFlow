/**
 * Staff review of M-Pesa money the ingest could not book: UNMATCHED (no loan
 * carries the account reference) and NEEDS_REVIEW (refused by the money path,
 * an amount mismatch, a late STK payment, a simulated callback where
 * simulation is forbidden). Mirrors client-notified payments
 * (lib/payments/payment-notifications.ts): allocate captures the receipt on the
 * loan staff name, through the same receipt path and idempotency key as the
 * ingest (`mpesa-c2b:<TransID>`), so one transaction can never become two
 * receipts; reject records who and why. Both lock the row, so two staff
 * clicking at once resolve it once. Where the provider reported another amount
 * than an STK push asked for, what is booked is the REPORTED amount, and only
 * once staff confirm that figure (`confirmedAmount`); the audit keeps both.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { applyManualReceiptInTx, type PaymentTx } from "@/lib/loan/apply-payment"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { mobileMoneyReceipt, valueDate, type MobileMoneyDb } from "./book"
import { matchLoanByReference } from "./c2b-ingest"

export const REVIEWABLE_STATUSES = ["UNMATCHED", "NEEDS_REVIEW"] as const
export const REJECT_REASON_MIN = 5
export const REJECT_REASON_MAX = 500

export type MobileMoneyReviewErrorCode = "NOT_FOUND" | "ALREADY_RESOLVED" | "LOAN_NOT_FOUND" | "SIMULATION_FORBIDDEN" | "AMOUNT_UNCONFIRMED"

export class MobileMoneyReviewError extends Error {
  constructor(readonly code: MobileMoneyReviewErrorCode, message: string) {
    super(message)
    this.name = "MobileMoneyReviewError"
  }
}

type Actor = { id: string; email: string | null }

/** Every M-Pesa transaction waiting for a person, oldest first. */
export function listMobileMoneyForReview(tenantId: string) {
  return prisma.mobileMoneyTransaction.findMany({
    where: { tenantId, status: { in: [...REVIEWABLE_STATUSES] } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, status: true, transId: true, billRef: true, amount: true, reportedAmount: true, reviewReason: true,
      transactedAt: true, createdAt: true, simulated: true, msisdnLast4: true,
      loan: { select: { id: true, reference: true } },
    },
  })
}

async function lockOpen(tx: PaymentTx, tenantId: string, id: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "MobileMoneyTransaction" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE
  `)
  const row = await tx.mobileMoneyTransaction.findFirst({ where: { id, tenantId } })
  if (!row) throw new MobileMoneyReviewError("NOT_FOUND", "M-Pesa transaction not found")
  if (!(REVIEWABLE_STATUSES as readonly string[]).includes(row.status) || !row.transId) {
    throw new MobileMoneyReviewError("ALREADY_RESOLVED", `This M-Pesa transaction is already ${row.status.toLowerCase()}`)
  }
  return { ...row, transId: row.transId }
}

/** Books the transaction as a receipt on the loan staff named, and marks it BOOKED, atomically. */
export async function allocateMobileMoney(db: MobileMoneyDb, input: {
  tenantId: string; id: string; loanReference: string; actor: Actor
  /** cents; required, and must equal the reported amount, on a row whose reported amount differs from its push */
  confirmedAmount?: number
}) {
  const { tenantId, actor } = input
  return db.$transaction(async (tx) => {
    const row = await lockOpen(tx, tenantId, input.id)
    // A simulated callback is not money: where simulation is forbidden it is only ever rejected.
    if (row.simulated && !isSimulationPermitted("simulated-mpesa")) {
      throw new MobileMoneyReviewError("SIMULATION_FORBIDDEN", "A simulated M-Pesa payment cannot be booked here: reject it")
    }
    // What the provider says arrived. On a mismatch row staff must confirm that very figure.
    const amount = row.reportedAmount ?? row.amount
    if (row.reportedAmount !== null && input.confirmedAmount !== row.reportedAmount) {
      throw new MobileMoneyReviewError("AMOUNT_UNCONFIRMED",
        "The provider reported a different amount than was requested: confirm the reported amount before booking it")
    }
    const loanId = await matchLoanByReference(tx, tenantId, input.loanReference)
    if (!loanId) throw new MobileMoneyReviewError("LOAN_NOT_FOUND", `No loan has the reference ${input.loanReference.trim()}`)
    const receipt = await applyManualReceiptInTx(tx, mobileMoneyReceipt({
      tenantId, loanId, amountCents: amount, transId: row.transId,
      receivedAt: valueDate(row.transactedAt ?? row.createdAt, new Date()), simulated: row.simulated,
    }, { capturedById: actor.id, capturedByEmail: actor.email, auditUserId: actor.id }))
    await tx.mobileMoneyTransaction.update({
      where: { id: row.id, tenantId },
      data: { status: "BOOKED", loanId, paymentId: receipt.payment.id, resolvedById: actor.id, resolvedAt: new Date() },
    })
    await logAuditStrict({
      tenantId, userId: actor.id, userEmail: actor.email ?? undefined,
      action: AuditAction.MOBILE_MONEY_ALLOCATED, entity: "MobileMoneyTransaction", entityId: row.id,
      oldValue: { status: row.status, loanId: row.loanId },
      newValue: {
        status: "BOOKED", loanId, paymentId: receipt.payment.id, amount, transId: row.transId,
        ...(row.reportedAmount !== null ? { requestedAmount: row.amount, reportedAmount: row.reportedAmount, amountConfirmedById: actor.id } : {}),
      },
    }, tx)
    return { transactionId: row.id, loanId, payment: receipt.payment, idempotentReplay: receipt.idempotentReplay }
  })
}

/** Records that it is not this lender's money to book, with the reason, and who decided. */
export async function rejectMobileMoney(db: MobileMoneyDb, input: { tenantId: string; id: string; reason: string; actor: Actor }) {
  const { tenantId, actor } = input
  return db.$transaction(async (tx) => {
    const row = await lockOpen(tx, tenantId, input.id)
    await tx.mobileMoneyTransaction.update({
      where: { id: row.id, tenantId },
      data: { status: "REJECTED", rejectReason: input.reason, resolvedById: actor.id, resolvedAt: new Date() },
    })
    await logAuditStrict({
      tenantId, userId: actor.id, userEmail: actor.email ?? undefined,
      action: AuditAction.MOBILE_MONEY_REJECTED, entity: "MobileMoneyTransaction", entityId: row.id,
      oldValue: { status: row.status }, newValue: { status: "REJECTED", reason: input.reason, transId: row.transId },
    }, tx)
    return { transactionId: row.id, status: "REJECTED" as const }
  })
}
