/**
 * Submits due instructions to the provider, one batch per action date.
 *
 * Due = an action date inside this run's submission window, so a missed run
 * does not push a debit a month. Before anything is sent, an instruction is
 * cancelled if its action date has passed, its instalment is settled, its
 * mandate is not ACTIVE, or its loan is no longer collectible.
 *
 * Never double-debits: instructions are claimed PENDING → SUBMITTING inside a
 * transaction before the provider is called. A failure that proves nothing
 * was sent releases them to PENDING; any other failure leaves them SUBMITTING
 * for reconcileStuckInstructions (reconcile.ts), which never re-sends on its
 * own. A file-based rail answers awaitingLoadReport: the batch and its
 * instructions wait UPLOADED for the load report.
 */
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import type { CollectionInstructionInput, SubmitResult } from "@/lib/integrations/collections/types"
import { COLLECTIBLE_LOAN_STATUSES } from "./scheme-rules"
import { submissionWindow } from "./schedule"
import { ENGINE_ACTOR, dateOnly, dayOf, definitelyNotSent, errorSummary, redact, type EngineContext, type EngineTx } from "./context"

export interface SubmitSummary {
  stale: number
  settled: number
  notCollectible: number
  batches: number
  submitted: number
  uploaded: number
  rejected: number
  failedBatches: string[]
  /** Instructions that failed while being vetted; the rest of the run went on. */
  errors: string[]
}

export const audit = (ctx: EngineContext, action: string, entity: string, entityId: string, newValue: Record<string, unknown>, tx: EngineTx) =>
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

const OMITTED_FROM_REPORT = "Not in the provider's load report: confirm with the provider, then mark it submitted or release it"

/** Write a provider's per-instruction answer (sync submit or a load report) onto the batch. */
export async function applyLoadReport(ctx: EngineContext, batchId: string, from: "SUBMITTING" | "UPLOADED", refs: string[], report: Pick<SubmitResult, "accepted" | "rejected" | "batchRef" | "simulated">): Promise<{ accepted: number; rejected: number }> {
  const rejected = new Map(report.rejected.map((r) => [r.instructionRef, redact(r.error)]))
  const accepted = new Set(report.accepted)
  await prisma.$transaction(async (tx) => {
    for (const ref of refs) {
      const where = { tenantId: ctx.tenantId, batchId, instructionRef: ref, status: from }
      if (accepted.has(ref)) await tx.collectionInstruction.updateMany({ where, data: { status: "SUBMITTED", submittedAt: ctx.now } })
      else if (rejected.has(ref)) await tx.collectionInstruction.updateMany({ where, data: { status: "REJECTED", statusReason: rejected.get(ref) } })
      else {
        // The report does not mention it: its fate is unknown, so a person decides (never re-sent on its own).
        const done = await tx.collectionInstruction.updateMany({ where, data: { status: "NEEDS_REVIEW", statusReason: OMITTED_FROM_REPORT } })
        if (done.count > 0) await audit(ctx, AuditAction.COLLECTION_INSTRUCTION_NEEDS_REVIEW, "CollectionBatch", batchId, { instructionRef: ref, reason: OMITTED_FROM_REPORT }, tx)
      }
    }
    const omitted = refs.filter((r) => !accepted.has(r) && !rejected.has(r)).length
    await tx.collectionBatch.update({
      where: { id: batchId, tenantId: ctx.tenantId },
      data: {
        status: omitted > 0 ? "NEEDS_REVIEW" : "SUBMITTED", ...(omitted > 0 ? { error: `${omitted} instruction(s) not in the load report` } : {}),
        providerBatchRef: report.batchRef, submittedAt: ctx.now, ...(report.simulated ? { simulated: true } : {}),
        acceptedCount: refs.filter((r) => accepted.has(r)).length, rejectedCount: refs.filter((r) => rejected.has(r)).length,
      },
    })
    await audit(ctx, AuditAction.COLLECTION_BATCH_LOADED, "CollectionBatch", batchId, {
      provider: ctx.provider.id, batchRef: report.batchRef, accepted: accepted.size, rejected: rejected.size,
    }, tx)
  })
  return { accepted: refs.filter((r) => accepted.has(r)).length, rejected: refs.filter((r) => rejected.has(r)).length }
}

async function dueInstructions(ctx: EngineContext, summary: SubmitSummary) {
  const window = submissionWindow(sastCalendarDate(ctx.now))
  const pending = await prisma.collectionInstruction.findMany({
    where: { tenantId: ctx.tenantId, status: "PENDING", actionDate: { lte: dateOnly(window.to) }, mandate: { provider: ctx.provider.id } },
    include: {
      mandate: { select: { providerMandateRef: true, status: true } },
      loan: { select: { status: true } },
      repaymentSchedule: { select: { totalDue: true, totalPaid: true, status: true } },
    },
    orderBy: [{ actionDate: "asc" }, { createdAt: "asc" }],
  })
  const due: typeof pending = []
  for (const i of pending) {
    try {
      if (await vet(ctx, i, window.from, summary)) due.push(i)
    } catch (error) {
      summary.errors.push(`${i.id}: ${errorSummary(error)}`)
    }
  }
  return due
}

type Pending = {
  id: string
  amountCents: number
  actionDate: Date
  mandate: { providerMandateRef: string | null; status: string }
  loan: { status: string }
  repaymentSchedule: { totalDue: number; totalPaid: number; status: string }
}

/** Cancel an instruction that must not go out, clamp its amount; true when it is due. */
async function vet(ctx: EngineContext, i: Pending, earliest: string, summary: SubmitSummary): Promise<boolean> {
  const outstanding = i.repaymentSchedule.totalDue - i.repaymentSchedule.totalPaid
  if (!(COLLECTIBLE_LOAN_STATUSES as readonly string[]).includes(i.loan.status)) {
    await cancelInstruction(ctx, i.id, `Loan is ${i.loan.status}`)
    summary.notCollectible++
    return false
  }
  if (dayOf(i.actionDate) < earliest) {
    // Too late for this date: the planner re-plans it for the next debit day.
    await cancelInstruction(ctx, i.id, "Action date passed before submission")
    summary.stale++
    return false
  }
  if (outstanding <= 0 || i.repaymentSchedule.status === "PAID" || i.repaymentSchedule.status === "WRITTEN_OFF") {
    await cancelInstruction(ctx, i.id, "Instalment settled before submission")
    summary.settled++
    return false
  }
  if (i.mandate.status !== "ACTIVE" || !i.mandate.providerMandateRef) {
    await cancelInstruction(ctx, i.id, `Mandate is ${i.mandate.status}`)
    return false
  }
  if (outstanding < i.amountCents) {
    await prisma.collectionInstruction.updateMany({ where: { id: i.id, tenantId: ctx.tenantId, status: "PENDING" }, data: { amountCents: outstanding } })
    i.amountCents = outstanding
  }
  return true
}

export async function submitDueInstructions(ctx: EngineContext): Promise<SubmitSummary> {
  const summary: SubmitSummary = { stale: 0, settled: 0, notCollectible: 0, batches: 0, submitted: 0, uploaded: 0, rejected: 0, failedBatches: [], errors: [] }
  const due = await dueInstructions(ctx, summary)
  const byDate = new Map<string, typeof due>()
  for (const i of due) byDate.set(dayOf(i.actionDate), [...(byDate.get(dayOf(i.actionDate)) ?? []), i])

  for (const [actionDate, group] of byDate) {
    const { batchId, claimed } = await prisma.$transaction(async (tx) => {
      const batch = await tx.collectionBatch.create({
        data: { tenantId: ctx.tenantId, provider: ctx.provider.id, actionDate: dateOnly(actionDate), instructionCount: 0, totalCents: 0 },
      })
      await tx.collectionInstruction.updateMany({
        where: { tenantId: ctx.tenantId, id: { in: group.map((i) => i.id) }, status: "PENDING" },
        // submittedAt = when the submission was attempted; the stuck sweep measures from it.
        data: { status: "SUBMITTING", batchId: batch.id, submittedAt: ctx.now },
      })
      const ids = new Set((await tx.collectionInstruction.findMany({ where: { tenantId: ctx.tenantId, batchId: batch.id }, select: { id: true } })).map((r) => r.id))
      const claimed = group.filter((i) => ids.has(i.id))
      await tx.collectionBatch.update({
        where: { id: batch.id, tenantId: ctx.tenantId },
        data: { instructionCount: claimed.length, totalCents: claimed.reduce((s, i) => s + i.amountCents, 0), ...(claimed.length === 0 ? { status: "FAILED", error: "Nothing left to submit" } : {}) },
      })
      return { batchId: batch.id, claimed }
    })
    if (claimed.length === 0) continue
    summary.batches++
    const refs = claimed.map((i) => i.instructionRef)
    const inputs: CollectionInstructionInput[] = claimed.map((i) => ({
      instructionRef: i.instructionRef, mandateRef: i.mandate.providerMandateRef!, amountCents: i.amountCents,
      actionDate: i.actionDate, trackingDays: i.trackingDays,
    }))
    try {
      const result = await ctx.provider.collect(inputs, ctx.creds)
      if (result.awaitingLoadReport) {
        await prisma.$transaction(async (tx) => {
          await tx.collectionInstruction.updateMany({ where: { tenantId: ctx.tenantId, batchId, status: "SUBMITTING" }, data: { status: "UPLOADED", submittedAt: ctx.now } })
          await tx.collectionBatch.update({
            where: { id: batchId, tenantId: ctx.tenantId },
            data: { status: "UPLOADED", providerBatchRef: result.batchRef, submittedAt: ctx.now, simulated: result.simulated === true },
          })
          await audit(ctx, AuditAction.COLLECTION_BATCH_SUBMITTED, "CollectionBatch", batchId, {
            provider: ctx.provider.id, actionDate, batchRef: result.batchRef, uploaded: refs.length, simulated: result.simulated === true,
          }, tx)
        })
        summary.uploaded += refs.length
        continue
      }
      const loaded = await applyLoadReport(ctx, batchId, "SUBMITTING", refs, result)
      summary.submitted += loaded.accepted
      summary.rejected += loaded.rejected
    } catch (error) {
      const safe = definitelyNotSent(error)
      await prisma.$transaction(async (tx) => {
        if (safe) {
          await tx.collectionInstruction.updateMany({ where: { tenantId: ctx.tenantId, batchId, status: "SUBMITTING" }, data: { status: "PENDING", batchId: null } })
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
