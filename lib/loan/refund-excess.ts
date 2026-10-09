import type { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { OVERPAYMENT_REASON } from "@/lib/loan/receipt-rules"
import { CASH_RECEIPTS, WAIVER_METHOD } from "@/lib/payments/waiver"

// Money a loan has received that nothing it owes any longer can absorb, turned
// into refund-due receipts. ALL money is CENTS.

type RefundTx = Pick<
  Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  "payment" | "auditLog"
>

/**
 * Retires waived cents first (a waiver is never refunded, audited), then
 * splits what remains of `excessCents` off the loan's most recent live cash receipts into
 * refund-due (UNAPPLIED, OVERPAYMENT_REASON) money — the same shape the
 * capture paths give an over-payment: the receipt keeps the part still applied
 * (and its bank-statement link) and a child row carries the part owed back.
 * A receipt wholly owed back is itself marked refund-due, as capture does for
 * a receipt that finds nothing to pay. Call under the loan lock. Audited per
 * receipt with the amount and the reason.
 */
export async function splitExcessToRefundDue(
  tx: RefundTx,
  ref: { tenantId: string; loanId: string },
  excessCents: number,
  reason: string,
  actor: { userId: string; userEmail: string | null },
): Promise<Array<{ paymentId: string; refundDueCents: number; refundPaymentId: string }>> {
  let remaining = excessCents
  // A waiver is never refunded: waived cents nothing now needs are retired
  // first, so only real excess cash becomes refund-due.
  const waivers = await tx.payment.findMany({
    where: { tenantId: ref.tenantId, loanId: ref.loanId, reversed: false, allocationStatus: "ALLOCATED", paymentMethod: WAIVER_METHOD },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  })
  for (const waiver of waivers) {
    if (remaining <= 0) break
    const retired = Math.min(remaining, waiver.amount)
    remaining -= retired
    await tx.payment.update({
      where: { id: waiver.id },
      data: retired === waiver.amount
        ? { reversed: true, reversedAt: new Date(), reversedById: actor.userId, reversalReason: reason, defaultInterestAllocated: 0, chargeFeesAllocated: 0 }
        : { amount: waiver.amount - retired },
    })
    await tx.auditLog.create({
      data: {
        tenantId: ref.tenantId, userId: actor.userId, userEmail: actor.userEmail,
        action: AuditAction.PAYMENT_WAIVER_RETIRED, entity: "Payment", entityId: waiver.id,
        oldValue: { amount: waiver.amount },
        newValue: { amount: waiver.amount - retired, retiredCents: retired, reason, loanId: ref.loanId },
      },
    })
  }
  const receipts = await tx.payment.findMany({
    where: { tenantId: ref.tenantId, loanId: ref.loanId, reversed: false, allocationStatus: "ALLOCATED", ...CASH_RECEIPTS },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  })
  const splits: Array<{ paymentId: string; refundDueCents: number; refundPaymentId: string }> = []
  for (const receipt of receipts) {
    if (remaining <= 0) break
    const refundDueCents = Math.min(remaining, receipt.amount)
    remaining -= refundDueCents
    let refundPaymentId = receipt.id
    if (refundDueCents === receipt.amount) {
      await tx.payment.update({
        where: { id: receipt.id },
        data: {
          allocationStatus: "UNAPPLIED", reconciliationReason: OVERPAYMENT_REASON,
          defaultInterestAllocated: 0, chargeFeesAllocated: 0,
        },
      })
    } else {
      await tx.payment.update({ where: { id: receipt.id }, data: { amount: receipt.amount - refundDueCents } })
      const child = await tx.payment.create({
        data: {
          tenantId: receipt.tenantId, loanId: receipt.loanId, amount: refundDueCents,
          paymentMethod: receipt.paymentMethod, reference: receipt.reference, notes: reason,
          receivedAt: receipt.receivedAt, capturedBy: receipt.capturedBy,
          allocationStatus: "UNAPPLIED", reconciliationReason: OVERPAYMENT_REASON, parentPaymentId: receipt.id,
        },
      })
      refundPaymentId = child.id
    }
    await tx.auditLog.create({
      data: {
        tenantId: ref.tenantId, userId: actor.userId, userEmail: actor.userEmail,
        action: AuditAction.PAYMENT_REFUND_DUE_SPLIT, entity: "Payment", entityId: receipt.id,
        oldValue: { amount: receipt.amount, allocationStatus: receipt.allocationStatus },
        newValue: {
          amount: receipt.amount - refundDueCents, refundDueCents, refundPaymentId, reason, loanId: ref.loanId,
        },
      },
    })
    splits.push({ paymentId: receipt.id, refundDueCents, refundPaymentId })
  }
  if (remaining > 0) {
    throw new Error(`Loan ${ref.loanId}: ${remaining} cents of excess exceed its live cash receipts`)
  }
  return splits
}
