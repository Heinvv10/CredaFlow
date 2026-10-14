/**
 * Books a PAID collection result as a receipt through the EXISTING allocation
 * path, applyManualReceipt (lib/loan/apply-payment.ts): the same loan lock,
 * s125 settlement split, schedule update, charges replay and audit as a staff
 * capture. Nothing here allocates money itself.
 *
 * Exactly once: the receipt's idempotency key is the result id, so a crash
 * between booking and linking the result replays the same Payment instead of
 * booking a second one; and CollectionResult.paymentId is unique.
 *
 * Not booked, and put in front of a person instead: a settled amount that is
 * not the instructed amount, and a simulated result where simulation is not
 * permitted. Booked but flagged: a debit that settled after the instalment was
 * already paid another way (money is real; a refund may be due).
 */
import type { CollectionResult } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { applyManualReceipt, PaymentApplicationError } from "@/lib/loan/apply-payment"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { formatZAR } from "@/lib/utils"
import { ENGINE_ACTOR, redact, type EngineContext } from "./context"

export type AllocationOutcome = "ALLOCATED" | "NEEDS_REVIEW"

/** Record why a result needs a person. Shown on the loan page and the batch page. */
export async function markNeedsReview(ctx: EngineContext, result: Pick<CollectionResult, "id">, reason: string, paymentId?: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.collectionResult.update({
      where: { id: result.id, tenantId: ctx.tenantId },
      data: { processedAt: ctx.now, reviewReason: redact(reason), ...(paymentId ? { paymentId } : {}) },
    })
    await logAuditStrict({
      tenantId: ctx.tenantId, userEmail: ENGINE_ACTOR.userEmail,
      action: AuditAction.COLLECTION_RESULT_NEEDS_REVIEW, entity: "CollectionResult", entityId: result.id,
      newValue: { reason: redact(reason), paymentId: paymentId ?? null },
    }, tx)
  })
}

export async function allocatePaidResult(
  ctx: EngineContext,
  result: Pick<CollectionResult, "id" | "settledAmountCents" | "resolvedAt" | "simulated">,
  instruction: { loanId: string; instructionRef: string; amountCents: number; repaymentScheduleId: string },
): Promise<AllocationOutcome> {
  if (result.simulated && !isSimulationPermitted("simulated-collections")) {
    await markNeedsReview(ctx, result, "Simulated collection result on an environment that does not permit simulation: not booked")
    return "NEEDS_REVIEW"
  }
  const amount = result.settledAmountCents ?? 0
  if (amount !== instruction.amountCents) {
    await markNeedsReview(ctx, result,
      `The provider settled ${formatZAR(amount)} for a debit of ${formatZAR(instruction.amountCents)}: not booked. Confirm the amount with the provider and capture the receipt by hand.`)
    return "NEEDS_REVIEW"
  }
  const row = await prisma.repaymentSchedule.findFirst({
    where: { id: instruction.repaymentScheduleId, tenantId: ctx.tenantId },
    select: { status: true, totalDue: true, totalPaid: true },
  })
  const alreadyPaid = !!row && (row.status === "PAID" || row.totalPaid >= row.totalDue)
  // The provider's settlement date, never later than now (a provider clock ahead of ours).
  const receivedAt = result.resolvedAt > ctx.now ? ctx.now : result.resolvedAt
  let paymentId: string
  try {
    const receipt = await applyManualReceipt(prisma, {
      loanId: instruction.loanId,
      tenantId: ctx.tenantId,
      amount,
      paymentMethod: "DEBIT_ORDER",
      reference: instruction.instructionRef,
      notes: result.simulated ? "SIMULATED debit order collection: no money moved" : "Debit order collection",
      capturedById: ENGINE_ACTOR.capturedBy,
      capturedByEmail: ENGINE_ACTOR.userEmail,
      auditUserId: null,
      idempotencyKey: `collection-result:${result.id}`,
      receivedAt,
      valueDateSource: "SYSTEM_OBSERVED",
    })
    paymentId = receipt.payment.id
  } catch (error) {
    // A refusal the money path explains (loan closed, value date, key reuse):
    // the money arrived, so it waits for a person rather than vanishing.
    if (!(error instanceof PaymentApplicationError)) throw error
    await markNeedsReview(ctx, result, `Receipt not booked (${error.code}): ${error.message}`)
    return "NEEDS_REVIEW"
  }
  if (alreadyPaid) {
    await markNeedsReview(ctx, result,
      "The instalment was already paid when this debit settled. The receipt is booked; check whether a refund is due.", paymentId)
    return "NEEDS_REVIEW"
  }
  await prisma.collectionResult.update({
    where: { id: result.id, tenantId: ctx.tenantId },
    data: { paymentId, processedAt: ctx.now },
  })
  return "ALLOCATED"
}
