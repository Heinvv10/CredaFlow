/**
 * Submits due instructions to the provider, one batch per action date.
 *
 * Never double-debits: instructions are claimed PENDING → SUBMITTING inside a
 * transaction before the provider is called, so a concurrent run cannot send
 * them again. If the call fails in a way that proves nothing was sent they go
 * back to PENDING; any other failure leaves them SUBMITTING for a person to
 * reconcile with the provider, because they may have reached the bank.
 */
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import type { CollectionInstructionInput } from "@/lib/integrations/collections/types"
import { earliestActionDate } from "./schedule"
import { ENGINE_ACTOR, dateOnly, dayOf, definitelyNotSent, errorSummary, type EngineContext, type EngineTx } from "./context"

export interface SubmitSummary {
  stale: number
  settled: number
  batches: number
  submitted: number
  rejected: number
  failedBatches: string[]
}

const audit = (ctx: EngineContext, action: string, entity: string, entityId: string, newValue: Record<string, unknown>, tx: EngineTx) =>
  logAuditStrict({ tenantId: ctx.tenantId, userEmail: ENGINE_ACTOR.userEmail, action, entity, entityId, newValue }, tx)

async function cancelInstruction(ctx: EngineContext, id: string, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const done = await tx.collectionInstruction.updateMany({
      where: { id, tenantId: ctx.tenantId, status: "PENDING" },
      data: { status: "CANCELLED", statusReason: reason },
    })
    if (done.count > 0) await audit(ctx, AuditAction.COLLECTION_INSTRUCTION_CANCELLED, "CollectionInstruction", id, { reason }, tx)
  })
}

export async function submitDueInstructions(ctx: EngineContext): Promise<SubmitSummary> {
  const earliest = earliestActionDate(sastCalendarDate(ctx.now))
  const summary: SubmitSummary = { stale: 0, settled: 0, batches: 0, submitted: 0, rejected: 0, failedBatches: [] }
  const pending = await prisma.collectionInstruction.findMany({
    where: { tenantId: ctx.tenantId, status: "PENDING", actionDate: { lte: dateOnly(earliest) }, mandate: { provider: ctx.provider.id } },
    include: {
      mandate: { select: { providerMandateRef: true, status: true } },
      repaymentSchedule: { select: { totalDue: true, totalPaid: true, status: true } },
    },
    orderBy: [{ actionDate: "asc" }, { createdAt: "asc" }],
  })

  const due: typeof pending = []
  for (const i of pending) {
    const outstanding = i.repaymentSchedule.totalDue - i.repaymentSchedule.totalPaid
    if (dayOf(i.actionDate) < earliest) {
      // Too late to submit for this date: the planner re-plans it for the next debit day.
      await cancelInstruction(ctx, i.id, "Action date passed before submission")
      summary.stale++
    } else if (outstanding <= 0 || i.repaymentSchedule.status === "PAID" || i.repaymentSchedule.status === "WRITTEN_OFF") {
      await cancelInstruction(ctx, i.id, "Instalment settled before submission")
      summary.settled++
    } else if (i.mandate.status !== "ACTIVE" || !i.mandate.providerMandateRef) {
      await cancelInstruction(ctx, i.id, `Mandate is ${i.mandate.status}`)
    } else {
      if (outstanding < i.amountCents) {
        await prisma.collectionInstruction.updateMany({ where: { id: i.id, tenantId: ctx.tenantId, status: "PENDING" }, data: { amountCents: outstanding } })
        i.amountCents = outstanding
      }
      due.push(i)
    }
  }

  const byDate = new Map<string, typeof due>()
  for (const i of due) byDate.set(dayOf(i.actionDate), [...(byDate.get(dayOf(i.actionDate)) ?? []), i])

  for (const [actionDate, group] of byDate) {
    const { batchId, claimed } = await prisma.$transaction(async (tx) => {
      const batch = await tx.collectionBatch.create({
        data: {
          tenantId: ctx.tenantId, provider: ctx.provider.id, actionDate: dateOnly(actionDate),
          instructionCount: group.length, totalCents: group.reduce((s, i) => s + i.amountCents, 0),
        },
      })
      await tx.collectionInstruction.updateMany({
        where: { tenantId: ctx.tenantId, id: { in: group.map((i) => i.id) }, status: "PENDING" },
        data: { status: "SUBMITTING", batchId: batch.id },
      })
      const mine = await tx.collectionInstruction.findMany({ where: { tenantId: ctx.tenantId, batchId: batch.id }, select: { id: true } })
      const ids = new Set(mine.map((r) => r.id))
      const claimed = group.filter((i) => ids.has(i.id))
      await tx.collectionBatch.update({
        where: { id: batch.id, tenantId: ctx.tenantId },
        data: { instructionCount: claimed.length, totalCents: claimed.reduce((s, i) => s + i.amountCents, 0) },
      })
      return { batchId: batch.id, claimed }
    })
    if (claimed.length === 0) {
      await prisma.collectionBatch.update({ where: { id: batchId, tenantId: ctx.tenantId }, data: { status: "FAILED", error: "Nothing left to submit" } })
      continue
    }
    summary.batches++
    const inputs: CollectionInstructionInput[] = claimed.map((i) => ({
      instructionRef: i.instructionRef, mandateRef: i.mandate.providerMandateRef!, amountCents: i.amountCents,
      actionDate: i.actionDate, trackingDays: i.trackingDays,
    }))
    try {
      const result = await ctx.provider.collect(inputs, ctx.creds)
      const rejected = new Map(result.rejected.map((r) => [r.instructionRef, r.error]))
      const accepted = new Set(result.accepted)
      await prisma.$transaction(async (tx) => {
        for (const i of claimed) {
          if (accepted.has(i.instructionRef)) {
            await tx.collectionInstruction.update({ where: { id: i.id, tenantId: ctx.tenantId }, data: { status: "SUBMITTED", submittedAt: ctx.now } })
          } else if (rejected.has(i.instructionRef)) {
            await tx.collectionInstruction.update({ where: { id: i.id, tenantId: ctx.tenantId }, data: { status: "REJECTED", statusReason: rejected.get(i.instructionRef) } })
          }
          // Neither accepted nor rejected: stays SUBMITTING for a person to reconcile.
        }
        await tx.collectionBatch.update({
          where: { id: batchId, tenantId: ctx.tenantId },
          data: {
            status: "SUBMITTED", providerBatchRef: result.batchRef, submittedAt: ctx.now, simulated: result.simulated === true,
            acceptedCount: claimed.filter((i) => accepted.has(i.instructionRef)).length,
            rejectedCount: claimed.filter((i) => rejected.has(i.instructionRef)).length,
          },
        })
        await audit(ctx, AuditAction.COLLECTION_BATCH_SUBMITTED, "CollectionBatch", batchId, {
          provider: ctx.provider.id, actionDate, batchRef: result.batchRef, accepted: result.accepted.length,
          rejected: result.rejected.length, simulated: result.simulated === true,
        }, tx)
      })
      summary.submitted += result.accepted.length
      summary.rejected += result.rejected.length
    } catch (error) {
      const safe = definitelyNotSent(error)
      await prisma.$transaction(async (tx) => {
        if (safe) {
          await tx.collectionInstruction.updateMany({
            where: { tenantId: ctx.tenantId, batchId, status: "SUBMITTING" },
            data: { status: "PENDING", batchId: null },
          })
        }
        await tx.collectionBatch.update({ where: { id: batchId, tenantId: ctx.tenantId }, data: { status: "FAILED", error: errorSummary(error) } })
        await audit(ctx, AuditAction.COLLECTION_BATCH_FAILED, "CollectionBatch", batchId, {
          provider: ctx.provider.id, actionDate, error: errorSummary(error), instructionsReleased: safe,
        }, tx)
      })
      summary.failedBatches.push(`${batchId}: ${errorSummary(error)}`)
    }
  }
  return summary
}
