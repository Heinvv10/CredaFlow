import type { PaymentMethod, Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { lockLoanForUpdate } from "@/lib/loan/lock"

// Money that has arrived is always recorded. When the default-charges replay
// refuses to book a receipt (lib/loan/charges-error.ts), a writer holding real
// money — the Stitch webhook, a bank-statement line, a bulk-upload row — keeps
// it as an UNAPPLIED receipt for staff to reconcile, audited with the reason,
// instead of rolling it back into a provider retry or dropping the line.

type HeldTx = Pick<Parameters<Parameters<typeof prisma.$transaction>[0]>[0], "payment" | "auditLog">

export const CHARGES_REFUSED_REASON = "charges_refused"

export async function recordHeldReceipt(tx: HeldTx, args: {
  tenantId: string
  loanId: string
  amount: number
  paymentMethod: PaymentMethod
  reference: string | null
  notes: string | null
  receivedAt: Date
  capturedBy?: string | null
  /** reconciliationReason; defaults to charges_refused */
  reason?: string
  /** why, kept on the audit row */
  error?: Error
  oldValue?: Record<string, unknown>
  source: string
  userId?: string | null
  userEmail?: string | null
}): Promise<{ id: string; allocationStatus: "UNAPPLIED" }> {
  const payment = await tx.payment.create({
    data: {
      tenantId: args.tenantId, loanId: args.loanId, amount: args.amount, paymentMethod: args.paymentMethod,
      reference: args.reference, notes: args.notes, receivedAt: args.receivedAt, capturedBy: args.capturedBy ?? null,
      allocationStatus: "UNAPPLIED", reconciliationReason: args.reason ?? CHARGES_REFUSED_REASON,
    },
  })
  await tx.auditLog.create({
    data: {
      tenantId: args.tenantId, userId: args.userId ?? null, userEmail: args.userEmail ?? null,
      action: AuditAction.PAYMENT_RECORDED, entity: "Loan", entityId: args.loanId,
      ...(args.oldValue ? { oldValue: args.oldValue as Prisma.InputJsonValue } : {}),
      newValue: {
        paymentId: payment.id, amount: args.amount, method: args.paymentMethod, reference: args.reference,
        source: args.source, allocated: false, reconciliationRequired: true,
        reason: args.reason ?? CHARGES_REFUSED_REASON,
        ...(args.error ? { detail: args.error.message } : {}),
      },
    },
  })
  return { id: payment.id, allocationStatus: "UNAPPLIED" }
}

/**
 * The Stitch webhook's hold: claims the payment request (so a replayed webhook
 * books nothing twice) and records the money held. null when already claimed.
 */
export async function holdStitchReceipt(
  db: Pick<typeof prisma, "$transaction">,
  stitchPayment: { id: string; loanId: string; amount: number; externalReference: string | null },
  stitchId: string,
  tenantId: string,
  error: Error,
) {
  return await db.$transaction(async (tx) => {
    await lockLoanForUpdate(tx, stitchPayment.loanId)
    const claimed = await tx.stitchPaymentRequest.updateMany({
      where: { id: stitchPayment.id, status: { not: "COMPLETED" } },
      data: { status: "COMPLETED" },
    })
    if (claimed.count === 0) return null
    return await recordHeldReceipt(tx, {
      tenantId, loanId: stitchPayment.loanId, amount: stitchPayment.amount, paymentMethod: "EFT",
      reference: stitchPayment.externalReference, notes: `Stitch instant EFT — id: ${stitchId}`,
      receivedAt: new Date(), error, source: "stitch_webhook",
    })
  })
}
