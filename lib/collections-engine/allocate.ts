/**
 * Books a PAID collection result as a receipt through the EXISTING allocation
 * path, applyManualReceipt (lib/loan/apply-payment.ts): the same loan lock,
 * s125 settlement split, schedule update, charges replay and audit as a staff
 * capture. Nothing here allocates money itself.
 *
 * Exactly once: the receipt's idempotency key is the result id, so a crash
 * between booking and linking the result replays the same Payment instead of
 * booking a second one; and CollectionResult.paymentId is unique.
 */
import type { CollectionResult } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { applyManualReceipt, PaymentApplicationError } from "@/lib/loan/apply-payment"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { ENGINE_ACTOR, type EngineContext } from "./context"

export type AllocationOutcome = "ALLOCATED" | "NEEDS_REVIEW"

/** Record why a result could not be acted on automatically. Shown on the loan page. */
export async function markNeedsReview(ctx: EngineContext, result: Pick<CollectionResult, "id">, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.collectionResult.update({
      where: { id: result.id, tenantId: ctx.tenantId },
      data: { processedAt: ctx.now, allocationError: reason },
    })
    await logAuditStrict({
      tenantId: ctx.tenantId, userEmail: ENGINE_ACTOR.userEmail,
      action: AuditAction.COLLECTION_RESULT_NEEDS_REVIEW, entity: "CollectionResult", entityId: result.id,
      newValue: { reason },
    }, tx)
  })
}

export async function allocatePaidResult(
  ctx: EngineContext,
  result: Pick<CollectionResult, "id" | "settledAmountCents" | "resolvedAt" | "simulated">,
  instruction: { loanId: string; instructionRef: string },
): Promise<AllocationOutcome> {
  if (result.simulated && !isSimulationPermitted("simulated-collections")) {
    await markNeedsReview(ctx, result, "Simulated collection result on an environment that does not permit simulation: not booked")
    return "NEEDS_REVIEW"
  }
  const amount = result.settledAmountCents ?? 0
  // The provider's settlement date, never later than now (a provider clock ahead of ours).
  const receivedAt = result.resolvedAt > ctx.now ? ctx.now : result.resolvedAt
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
    await prisma.collectionResult.update({
      where: { id: result.id, tenantId: ctx.tenantId },
      data: { paymentId: receipt.payment.id, processedAt: ctx.now, allocationError: null },
    })
    return "ALLOCATED"
  } catch (error) {
    // A refusal the money path explains (loan closed, value date, key reuse):
    // the money arrived, so it waits for a person rather than vanishing.
    if (!(error instanceof PaymentApplicationError)) throw error
    await markNeedsReview(ctx, result, `Receipt not booked (${error.code}): ${error.message}`)
    return "NEEDS_REVIEW"
  }
}
