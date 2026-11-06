/**
 * Settles an STK push the borrower started (lib/mobile-money/stk-push.ts) from
 * its result callback. Only a PENDING push moves, and only once: the claim is
 * a conditional update inside the booking transaction, so a second delivery
 * finds nothing to claim and rolls back.
 *
 * A paid result for a push this lender never recorded is money that moved: it
 * is kept UNMATCHED for staff, never dropped. One for a push already settled
 * (cancelled, or booked under another transaction) is kept NEEDS_REVIEW on
 * that push's loan. Only a transaction this lender already stored is a replay.
 * An unknown cancellation moved nothing and is ignored.
 */
import { formatZAR } from "@/lib/utils"
import {
  auditSettled, bookReceipt, DuplicateDelivery, settleWithoutReceipt, valueDate,
  type IngestOutcome, type MobileMoneyDb, type Settle, type Settled,
} from "./book"
import type { MobileMoneyCallback } from "./types"

export interface IngestContext {
  tenantId: string
  providerId: string
  simulated: boolean
  /** Why a simulated callback may not book here, or null. */
  forbidden: string | null
  now: Date
}

type StkCallback = Extract<MobileMoneyCallback, { kind: "STK_PAID" | "STK_CANCELLED" }>

export async function ingestStkResult(db: MobileMoneyDb, ctx: IngestContext, cb: StkCallback): Promise<IngestOutcome> {
  const { tenantId, providerId } = ctx
  const push = await db.mobileMoneyTransaction.findFirst({
    where: { tenantId, provider: providerId, checkoutRequestId: cb.checkoutRequestId },
    select: { id: true, status: true, loanId: true, amount: true, transId: true },
  })
  if (!push) {
    if (cb.kind === "STK_CANCELLED") return { outcome: "UNKNOWN_REQUEST" }
    return keepPayment(db, ctx, cb, { status: "UNMATCHED" }, { loanId: null, checkoutRequestId: cb.checkoutRequestId })
  }
  if (push.status !== "PENDING") {
    if (cb.kind === "STK_CANCELLED" || push.transId === cb.transId) return { outcome: "DUPLICATE" }
    // A create: if this lender already stored the transaction, the unique key makes it DUPLICATE.
    return keepPayment(db, ctx, cb, {
      status: "NEEDS_REVIEW",
      reviewReason: `Paid after STK push ${push.id} was already recorded ${push.status}: not booked. Confirm it with the provider and allocate it.`,
    }, { loanId: push.loanId, checkoutRequestId: null })
  }
  const loanId = push.loanId
  if (!loanId) return { outcome: "DUPLICATE" }

  const settle: Settle = async (tx, settled) => {
    const claimed = await tx.mobileMoneyTransaction.updateMany({
      where: { id: push.id, tenantId, status: "PENDING" },
      data: {
        status: settled.status,
        ...(cb.kind === "STK_PAID" ? { transId: cb.transId, msisdnLast4: cb.msisdnLast4, transactedAt: cb.transactedAt } : {}),
        ...("paymentId" in settled ? { paymentId: settled.paymentId } : {}),
        ...("reviewReason" in settled ? { reviewReason: settled.reviewReason } : {}),
        ...("reportedAmount" in settled ? { reportedAmount: settled.reportedAmount } : {}),
      },
    })
    if (claimed.count !== 1) throw new DuplicateDelivery()
    await auditSettled(tx, {
      tenantId, transactionId: push.id, provider: providerId, transId: cb.kind === "STK_PAID" ? cb.transId : null,
      amount: push.amount, loanId, simulated: ctx.simulated, settled,
    })
    return push.id
  }

  if (cb.kind === "STK_CANCELLED") return settleWithoutReceipt(db, settle, { status: "CANCELLED", reason: cb.reason })
  if (ctx.forbidden) {
    // Whatever the reason it waits, a different reported amount is recorded: staff book that, never the push.
    return settleWithoutReceipt(db, settle, {
      status: "NEEDS_REVIEW", reviewReason: ctx.forbidden,
      ...(cb.amountCents !== push.amount ? { reportedAmount: cb.amountCents } : {}),
    })
  }
  if (cb.amountCents !== push.amount) {
    return settleWithoutReceipt(db, settle, {
      status: "NEEDS_REVIEW",
      // Kept beside the pushed amount: staff confirm and book what the provider reported, never the request.
      reportedAmount: cb.amountCents,
      reviewReason: `The provider reported ${formatZAR(cb.amountCents)} for a push of ${formatZAR(push.amount)}: not booked. Confirm the reported amount with the provider, then allocate it.`,
    })
  }
  return bookReceipt(db, {
    tenantId, loanId, amountCents: cb.amountCents, transId: cb.transId,
    receivedAt: valueDate(cb.transactedAt, ctx.now), simulated: ctx.simulated,
  }, settle)
}

/** Money an STK result reports that no PENDING push can take: stored for staff, booking nothing. */
async function keepPayment(
  db: MobileMoneyDb, ctx: IngestContext, cb: Extract<StkCallback, { kind: "STK_PAID" }>,
  settled: Extract<Settled, { status: "UNMATCHED" | "NEEDS_REVIEW" }>,
  link: { loanId: string | null; checkoutRequestId: string | null },
): Promise<IngestOutcome> {
  const settle: Settle = async (tx, final) => {
    const row = await tx.mobileMoneyTransaction.create({
      data: {
        tenantId: ctx.tenantId, provider: ctx.providerId, transId: cb.transId, checkoutRequestId: link.checkoutRequestId,
        msisdnLast4: cb.msisdnLast4, billRef: "", amount: cb.amountCents, transactedAt: cb.transactedAt,
        simulated: ctx.simulated, status: final.status, loanId: link.loanId,
        reviewReason: "reviewReason" in final ? final.reviewReason : null,
      },
      select: { id: true },
    })
    await auditSettled(tx, {
      tenantId: ctx.tenantId, transactionId: row.id, provider: ctx.providerId, transId: cb.transId,
      amount: cb.amountCents, loanId: link.loanId, simulated: ctx.simulated, settled: final,
    })
    return row.id
  }
  return settleWithoutReceipt(db, settle, settled)
}
