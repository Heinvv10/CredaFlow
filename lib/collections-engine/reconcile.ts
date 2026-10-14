/**
 * Brings submitted work to a known state.
 *
 * - pollLoadReports: batches a file-based rail received (UPLOADED) are read
 *   back through getBatchLoadReport. No report within LOAD_REPORT_TIMEOUT_HOURS,
 *   or a rail without that method, puts the instructions in front of a person.
 * - reconcileStuckInstructions: an instruction claimed SUBMITTING whose answer
 *   never came (a timeout, a crash mid-call) is looked up by our reference
 *   where the provider supports it. NOT_FOUND (never received) releases it;
 *   ACCEPTED / REJECTED settle it; anything uncertain is NEEDS_REVIEW. It is
 *   never re-sent automatically: it may have reached the bank.
 */
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { LOAD_REPORT_TIMEOUT_HOURS, STUCK_SUBMISSION_HOURS } from "./scheme-rules"
import { applyLoadReport, audit } from "./submit"
import { errorSummary, redact, type EngineContext } from "./context"

export interface ReconcileSummary {
  loaded: number
  released: number
  settled: number
  needsReview: number
  errors: string[]
}

export const emptyReconcile = (): ReconcileSummary => ({ loaded: 0, released: 0, settled: 0, needsReview: 0, errors: [] })

async function toReview(ctx: EngineContext, where: { batchId?: string; id?: string }, from: "SUBMITTING" | "UPLOADED", reason: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.collectionInstruction.findMany({ where: { tenantId: ctx.tenantId, status: from, ...where }, select: { id: true, batchId: true } })
    for (const r of rows) {
      await tx.collectionInstruction.update({ where: { id: r.id, tenantId: ctx.tenantId }, data: { status: "NEEDS_REVIEW", statusReason: reason } })
      await audit(ctx, AuditAction.COLLECTION_INSTRUCTION_NEEDS_REVIEW, "CollectionInstruction", r.id, { from, reason }, tx)
    }
    const batchIds = [...new Set(rows.map((r) => r.batchId).filter((b): b is string => b !== null))]
    if (batchIds.length > 0) {
      await tx.collectionBatch.updateMany({
        where: { tenantId: ctx.tenantId, id: { in: batchIds }, status: { in: ["SUBMITTING", "UPLOADED", "FAILED"] } },
        data: { status: "NEEDS_REVIEW", error: reason },
      })
    }
    return rows.length
  })
}

export async function pollLoadReports(ctx: EngineContext, summary: ReconcileSummary): Promise<void> {
  const timeoutBefore = new Date(ctx.now.getTime() - LOAD_REPORT_TIMEOUT_HOURS * 3_600_000)
  const batches = await prisma.collectionBatch.findMany({
    where: { tenantId: ctx.tenantId, provider: ctx.provider.id, status: "UPLOADED" },
    select: { id: true, providerBatchRef: true, submittedAt: true, instructions: { where: { status: "UPLOADED" }, select: { instructionRef: true } } },
  })
  for (const b of batches) {
    try {
      const refs = b.instructions.map((i) => i.instructionRef)
      if (!ctx.provider.getBatchLoadReport) {
        summary.needsReview += await toReview(ctx, { batchId: b.id }, "UPLOADED", `${ctx.provider.id} gives no load report: confirm with the provider`)
        continue
      }
      const report = await ctx.provider.getBatchLoadReport({ batchRef: b.providerBatchRef ?? "", instructionRefs: refs }, ctx.creds)
      if (report.state === "LOADED") {
        const done = await applyLoadReport(ctx, b.id, "UPLOADED", refs, { ...report, batchRef: b.providerBatchRef ?? "" })
        summary.loaded += done.accepted + done.rejected
      }
      // Still pending, or instructions the report did not mention, past the timeout: a person decides.
      if (b.submittedAt && b.submittedAt < timeoutBefore) {
        summary.needsReview += await toReview(ctx, { batchId: b.id }, "UPLOADED", `No load report from ${ctx.provider.id} after ${LOAD_REPORT_TIMEOUT_HOURS} hours`)
      }
    } catch (error) {
      summary.errors.push(`batch ${b.id}: ${errorSummary(error)}`)
    }
  }
}

export async function reconcileStuckInstructions(ctx: EngineContext, summary: ReconcileSummary): Promise<void> {
  const stuck = await prisma.collectionInstruction.findMany({
    where: {
      tenantId: ctx.tenantId, status: "SUBMITTING", mandate: { provider: ctx.provider.id },
      submittedAt: { lt: new Date(ctx.now.getTime() - STUCK_SUBMISSION_HOURS * 3_600_000) },
    },
    select: { id: true, instructionRef: true },
  })
  for (const i of stuck) {
    try {
      const found = ctx.provider.findInstruction ? await ctx.provider.findInstruction(i.instructionRef, ctx.creds) : null
      const where = { id: i.id, tenantId: ctx.tenantId, status: "SUBMITTING" as const }
      if (found?.state === "ACCEPTED" || found?.state === "REJECTED" || found?.state === "NOT_FOUND") {
        const data = found.state === "ACCEPTED" ? { status: "SUBMITTED" as const, submittedAt: ctx.now }
          : found.state === "REJECTED" ? { status: "REJECTED" as const, statusReason: redact(found.error ?? "Rejected by the provider") }
            : { status: "PENDING" as const, batchId: null, statusReason: "Provider never received it: released" }
        await prisma.$transaction(async (tx) => {
          const done = await tx.collectionInstruction.updateMany({ where, data })
          if (done.count > 0) {
            await audit(ctx, AuditAction.COLLECTION_INSTRUCTION_RECONCILED, "CollectionInstruction", i.id, { reconciled: found.state }, tx)
          }
        })
        summary[found.state === "NOT_FOUND" ? "released" : "settled"]++
        continue
      }
      summary.needsReview += await toReview(ctx, { id: i.id }, "SUBMITTING",
        `Submission outcome unknown after ${STUCK_SUBMISSION_HOURS} hours: confirm with ${ctx.provider.id}, then mark it submitted or release it`)
    } catch (error) {
      summary.errors.push(`${i.id}: ${errorSummary(error)}`)
    }
  }
}
