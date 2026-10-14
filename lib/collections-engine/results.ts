/**
 * Result ingestion: provider outcomes → CollectionResult rows → receipts,
 * unpaid notes and the scheme stop rules.
 *
 * Idempotent by the database, not by a lookup: each outcome is INSERTed under
 * the unique (tenantId, provider, resultKey). A repeat collides and does
 * nothing, so overlapping fetch windows and re-runs are harmless. A PAID result
 * the engine recorded but did not finish booking (a crash between the two) is
 * picked up by the sweep at the start of every run.
 */
import type { CollectionReasonCode, Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { CollectionOutcome } from "@/lib/integrations/collections/types"
import { RESULT_LOOKBACK_DAYS } from "./scheme-rules"
import { allocatePaidResult, markNeedsReview } from "./allocate"
import { applyStopRules, noteUnpaidCollection } from "./unpaid"
import { ENGINE_ACTOR, errorSummary, isUniqueViolation, type EngineContext } from "./context"

export interface IngestSummary {
  fetched: number
  recorded: number
  duplicates: number
  unmatched: number
  allocated: number
  needsReview: number
  suspended: number
  errors: string[]
}

export const resultKey = (o: Pick<CollectionOutcome, "instructionRef" | "status">) => `${o.instructionRef}:${o.status}`

const emptySummary = (): IngestSummary => ({
  fetched: 0, recorded: 0, duplicates: 0, unmatched: 0, allocated: 0, needsReview: 0, suspended: 0, errors: [],
})

/** Book PAID results that were recorded but never finished. */
async function sweepUnbooked(ctx: EngineContext, summary: IngestSummary): Promise<void> {
  const open = await prisma.collectionResult.findMany({
    where: { tenantId: ctx.tenantId, provider: ctx.provider.id, outcome: "PAID", processedAt: null },
    include: { instruction: { select: { loanId: true, instructionRef: true } } },
  })
  for (const r of open) {
    const outcome = await allocatePaidResult(ctx, r, r.instruction)
    summary[outcome === "ALLOCATED" ? "allocated" : "needsReview"]++
  }
}

export async function recordOutcome(ctx: EngineContext, o: CollectionOutcome, summary: IngestSummary): Promise<void> {
  if (o.status === "PENDING") return
  const instruction = await prisma.collectionInstruction.findFirst({
    where: { tenantId: ctx.tenantId, instructionRef: o.instructionRef, mandate: { provider: ctx.provider.id } },
  })
  if (!instruction) {
    summary.unmatched++
    return
  }
  let recorded
  try {
    recorded = await prisma.$transaction(async (tx) => {
      const row = await tx.collectionResult.create({
        data: {
          tenantId: ctx.tenantId, provider: ctx.provider.id, instructionId: instruction.id, resultKey: resultKey(o),
          outcome: o.status as "PAID" | "UNPAID" | "DISPUTED",
          reasonCode: (o.reason ?? null) as CollectionReasonCode | null,
          rawCode: o.rawCode, rawPayload: (o.raw ?? o) as Prisma.InputJsonValue,
          settledAmountCents: o.status === "PAID" ? o.settledAmountCents : null,
          resolvedAt: o.resolvedAt, simulated: o.simulated === true,
          ...(o.status === "PAID" ? {} : { processedAt: ctx.now }),
        },
      })
      await tx.collectionInstruction.update({
        where: { id: instruction.id, tenantId: ctx.tenantId },
        data: { status: o.status as "PAID" | "UNPAID" | "DISPUTED", statusReason: o.reason ?? null },
      })
      await logAuditStrict({
        tenantId: ctx.tenantId, userEmail: ENGINE_ACTOR.userEmail,
        action: AuditAction.COLLECTION_RESULT_RECORDED, entity: "CollectionResult", entityId: row.id,
        newValue: {
          instructionId: instruction.id, loanId: instruction.loanId, outcome: o.status, reason: o.reason,
          rawCode: o.rawCode, settledAmountCents: o.settledAmountCents, simulated: o.simulated === true,
        },
      }, tx)
      return row
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    summary.duplicates++
    return
  }
  summary.recorded++

  if (recorded.outcome === "PAID") {
    const outcome = await allocatePaidResult(ctx, recorded, instruction)
    summary[outcome === "ALLOCATED" ? "allocated" : "needsReview"]++
    return
  }
  await noteUnpaidCollection(ctx, {
    loanId: instruction.loanId, instalmentNo: instruction.installmentNo, presentmentNo: instruction.presentmentNo,
    amountCents: instruction.amountCents, outcome: recorded.outcome, reasonCode: recorded.reasonCode,
  })
  if (recorded.outcome === "DISPUTED") {
    // Reversing a booked receipt is a staff decision on the payments screen.
    await markNeedsReview(ctx, recorded, "Debtor disputed the collection: reverse its receipt through the payment reversal flow")
    summary.needsReview++
  }
  if (await applyStopRules(ctx, instruction.mandateId)) summary.suspended++
}

export async function ingestResults(ctx: EngineContext): Promise<IngestSummary> {
  const summary = emptySummary()
  await sweepUnbooked(ctx, summary)
  const from = new Date(ctx.now.getTime() - RESULT_LOOKBACK_DAYS * 86_400_000)
  // Nothing submitted in the window means nothing to hear back about: the
  // provider is not called (a tenant using the flag for AVS only stays quiet).
  const recent = await prisma.collectionInstruction.count({
    where: { tenantId: ctx.tenantId, submittedAt: { gte: from }, mandate: { provider: ctx.provider.id } },
  })
  if (recent === 0) return summary
  const awaiting = await prisma.collectionInstruction.findMany({
    where: { tenantId: ctx.tenantId, status: "SUBMITTED", mandate: { provider: ctx.provider.id } },
    select: {
      instructionRef: true, amountCents: true, actionDate: true,
      mandate: { select: { providerMandateRef: true } }, batch: { select: { providerBatchRef: true } },
    },
  })
  const outcomes = await ctx.provider.fetchResults({
    from,
    awaiting: awaiting.map((i) => ({
      instructionRef: i.instructionRef, mandateRef: i.mandate.providerMandateRef ?? "", batchRef: i.batch?.providerBatchRef ?? null,
      amountCents: i.amountCents, actionDate: i.actionDate,
    })),
  }, ctx.creds)
  summary.fetched = outcomes.length
  for (const o of outcomes) {
    try {
      await recordOutcome(ctx, o, summary)
    } catch (error) {
      summary.errors.push(`${o.instructionRef}: ${errorSummary(error)}`)
    }
  }
  return summary
}
