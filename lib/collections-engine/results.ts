/**
 * Result ingestion: provider outcomes → CollectionResult rows → receipts,
 * notes, review items and the scheme stop rules.
 *
 * Idempotent by the database, not by a lookup: each outcome is INSERTed under
 * the unique (tenantId, provider, resultKey). A repeat collides and does
 * nothing. The result, the instruction's new status and the loan note are one
 * transaction, under a lock on the instruction row, and it decides from the
 * results already recorded, not from a status read before it:
 * - an UNPAID/DISPUTED for an instruction with a PAID result never moves it;
 *   it is recorded for review (reportedAfterPayment) and is not an NPF;
 * - a PAID dated before a return already recorded is not booked: it is
 *   recorded for review, so a returned debit cannot leave a silent receipt.
 * A fetch's outcomes are applied in resolvedAt order. Booking a receipt and the stop rules are re-derived from what is
 * stored on every run (sweepUnbooked, applyStopRulesToAll), so a failure after
 * the recording transaction is repaired by the next run.
 */
import type { CollectionReasonCode, Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { CollectionOutcome } from "@/lib/integrations/collections/types"
import { RESULT_LOOKBACK_DAYS } from "./scheme-rules"
import { allocatePaidResult } from "./allocate"
import { noteCollectionOutcome } from "./unpaid"
import { applyStopRules, applyStopRulesToAll } from "./stop-rules"
import { ENGINE_ACTOR, errorSummary, isUniqueViolation, isUniqueViolationOn, type EngineContext } from "./context"

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

/**
 * One provider outcome: the instruction, the status, and the provider's own id
 * for it (else the resolved date). A repeat report collides on this key; a
 * second, distinct debit under the same reference does not.
 */
export const resultKey = (o: Pick<CollectionOutcome, "instructionRef" | "status" | "providerResultId" | "resolvedAt">) =>
  `${o.instructionRef}:${o.status}:${o.providerResultId ?? o.resolvedAt.toISOString().slice(0, 10)}`

const DOUBLE_DEBIT =
  "Possible double debit: a second payment was reported for a debit already booked as paid. Not booked: confirm with the provider, then refund or capture it by hand."
const NOT_APPLIED =
  "This outcome could not be applied to its instruction (it conflicts with a later presentment of the same instalment). Not booked: confirm with the provider and act by hand."

export const emptyIngest = (): IngestSummary => ({
  fetched: 0, recorded: 0, duplicates: 0, unmatched: 0, allocated: 0, needsReview: 0, suspended: 0, errors: [],
})

/** Book PAID results that were recorded but never finished (a crash between recording and booking). */
export async function sweepUnbooked(ctx: EngineContext, summary: IngestSummary): Promise<void> {
  const open = await prisma.collectionResult.findMany({
    where: { tenantId: ctx.tenantId, provider: ctx.provider.id, outcome: "PAID", processedAt: null },
    include: { instruction: { select: { loanId: true, instructionRef: true, amountCents: true, repaymentScheduleId: true } } },
  })
  for (const r of open) {
    try {
      const outcome = await allocatePaidResult(ctx, r, r.instruction)
      summary[outcome === "ALLOCATED" ? "allocated" : "needsReview"]++
    } catch (error) {
      summary.errors.push(`result ${r.id}: ${errorSummary(error)}`)
    }
  }
}

const RETURNED_BEFORE_REPORT =
  "A return dated after this payment is already recorded: not booked. Confirm with the provider whether the money stayed, then capture the receipt by hand if it did."

function reviewReasonFor(o: CollectionOutcome, afterPayment: boolean): string | null {
  if (afterPayment) {
    return `Reported ${o.status}${o.reason ? ` (${o.reason})` : ""} after the debit was booked as paid: the receipt stands; reverse it through the payment reversal flow if the money went back.`
  }
  if (o.status === "DISPUTED") return "The debtor disputed the collection; the mandate is suspended."
  return null
}

/** Record an outcome that could not be applied, without touching its instruction. False if it was already recorded. */
async function recordUnapplied(ctx: EngineContext, instructionId: string, o: CollectionOutcome, reason = NOT_APPLIED, keySuffix = ""): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.collectionResult.create({
        data: {
          tenantId: ctx.tenantId, provider: ctx.provider.id, instructionId, resultKey: `${resultKey(o)}${keySuffix}`,
          outcome: o.status as "PAID" | "UNPAID" | "DISPUTED", reasonCode: (o.reason ?? null) as CollectionReasonCode | null,
          rawCode: o.rawCode, rawPayload: (o.raw ?? o) as Prisma.InputJsonValue,
          settledAmountCents: o.status === "PAID" ? o.settledAmountCents : null, resolvedAt: o.resolvedAt,
          simulated: o.simulated === true, reviewReason: reason, processedAt: ctx.now, createdAt: ctx.now,
        },
      })
      await logAuditStrict({
        tenantId: ctx.tenantId, userEmail: ENGINE_ACTOR.userEmail,
        action: AuditAction.COLLECTION_RESULT_NEEDS_REVIEW, entity: "CollectionResult", entityId: row.id,
        newValue: { instructionId, outcome: o.status, reason },
      }, tx)
    })
    return true
  } catch (error) {
    if (isUniqueViolationOn(error, "resultKey")) return false
    throw error
  }
}

export async function recordOutcome(ctx: EngineContext, o: CollectionOutcome, summary: IngestSummary): Promise<void> {
  if (o.status === "PENDING") return
  const status = o.status
  const instruction = await prisma.collectionInstruction.findFirst({
    where: { tenantId: ctx.tenantId, instructionRef: o.instructionRef, mandate: { provider: ctx.provider.id } },
  })
  if (!instruction) {
    summary.unmatched++
    return
  }
  let afterPayment = false
  let reviewReason: string | null = null
  let recorded
  try {
    recorded = await prisma.$transaction(async (tx) => {
      // Serialise outcomes for one instruction, then decide from what is recorded.
      await tx.$queryRaw`SELECT id FROM "CollectionInstruction" WHERE id = ${instruction.id} AND "tenantId" = ${ctx.tenantId} FOR UPDATE`
      const prior = await tx.collectionResult.findMany({
        where: { tenantId: ctx.tenantId, instructionId: instruction.id },
        select: { outcome: true, reasonCode: true, resolvedAt: true, reportedAfterPayment: true },
      })
      const current = await tx.collectionInstruction.findFirstOrThrow({ where: { id: instruction.id, tenantId: ctx.tenantId }, select: { status: true } })
      afterPayment = status !== "PAID" && (current.status === "PAID" || prior.some((r) => r.outcome === "PAID"))
      const returnedLater = status === "PAID"
        // >=: a return with the same timestamp as the payment came after it.
        && prior.some((r) => r.outcome !== "PAID" && !r.reportedAfterPayment && r.resolvedAt >= o.resolvedAt)
      const secondPayment = status === "PAID" && prior.some((r) => r.outcome === "PAID")
      // The provider repeating an unpaid or dispute it already reported: keep the row, act once.
      // Only an identical repeat is silent; a different reason is a review item (and the
      // stop rules weigh the most severe reason, stop-rules.ts).
      const earlier = status !== "PAID" && !afterPayment ? prior.filter((r) => r.outcome === status && !r.reportedAfterPayment) : []
      const repeat = earlier.length > 0
      const newReason = repeat && !earlier.some((r) => r.reasonCode === (o.reason ?? null))
      reviewReason = secondPayment ? DOUBLE_DEBIT : returnedLater ? RETURNED_BEFORE_REPORT
        : newReason ? `Reported ${status} again with a different reason (${o.reason ?? "none"} after ${earlier.map((r) => r.reasonCode ?? "none").join(", ")}): check the debit with the provider`
          : repeat ? null : reviewReasonFor(o, afterPayment)
      const held = returnedLater || secondPayment
      const moveInstruction = !afterPayment && !held && !repeat
      const row = await tx.collectionResult.create({
        data: {
          tenantId: ctx.tenantId, provider: ctx.provider.id, instructionId: instruction.id, resultKey: resultKey(o),
          outcome: status, reasonCode: (o.reason ?? null) as CollectionReasonCode | null,
          rawCode: o.rawCode, rawPayload: (o.raw ?? o) as Prisma.InputJsonValue,
          settledAmountCents: status === "PAID" ? o.settledAmountCents : null,
          resolvedAt: o.resolvedAt, simulated: o.simulated === true,
          reportedAfterPayment: afterPayment, reviewReason, createdAt: ctx.now,
          ...(status === "PAID" && !held ? {} : { processedAt: ctx.now }),
        },
      })
      if (moveInstruction) {
        await tx.collectionInstruction.update({
          where: { id: instruction.id, tenantId: ctx.tenantId },
          data: { status, statusReason: o.reason ?? null },
        })
      }
      if (status !== "PAID" && !repeat) {
        await noteCollectionOutcome(tx, {
          tenantId: ctx.tenantId, loanId: instruction.loanId, instalmentNo: instruction.installmentNo,
          presentmentNo: instruction.presentmentNo, amountCents: instruction.amountCents, outcome: status,
          reasonCode: o.reason ?? null, afterPayment,
        })
      }
      await logAuditStrict({
        tenantId: ctx.tenantId, userEmail: ENGINE_ACTOR.userEmail,
        action: AuditAction.COLLECTION_RESULT_RECORDED, entity: "CollectionResult", entityId: row.id,
        newValue: {
          instructionId: instruction.id, loanId: instruction.loanId, outcome: status, reason: o.reason,
          rawCode: o.rawCode, settledAmountCents: o.settledAmountCents, simulated: o.simulated === true,
          reportedAfterPayment: afterPayment, reviewReason,
        },
      }, tx)
      return row
    })
  } catch (error) {
    if (isUniqueViolationOn(error, "resultKey")) {
      // Without a provider result id, a second real debit of a released and
      // resent instruction has the same key as the first: never swallow it.
      if (o.status === "PAID" && !o.providerResultId && instruction.releasedAt
        && await recordUnapplied(ctx, instruction.id, o, DOUBLE_DEBIT, ":after-release")) {
        summary.recorded++
        summary.needsReview++
        return
      }
      summary.duplicates++
      return
    }
    if (!isUniqueViolation(error)) throw error
    // Another unique key refused the instruction update (e.g. a later
    // presentment of the instalment exists): keep the outcome, for a person.
    if (await recordUnapplied(ctx, instruction.id, o)) {
      summary.recorded++
      summary.needsReview++
    } else {
      summary.duplicates++
    }
    return
  }
  summary.recorded++
  if (reviewReason) summary.needsReview++

  if (recorded.outcome === "PAID") {
    if (recorded.processedAt) return
    const outcome = await allocatePaidResult(ctx, recorded, instruction)
    summary[outcome === "ALLOCATED" ? "allocated" : "needsReview"]++
    return
  }
  if (await applyStopRules(ctx, instruction.mandateId)) summary.suspended++
}

export async function ingestResults(ctx: EngineContext): Promise<IngestSummary> {
  const summary = emptyIngest()
  await sweepUnbooked(ctx, summary)
  const from = new Date(ctx.now.getTime() - RESULT_LOOKBACK_DAYS * 86_400_000)
  // Nothing submitted in the window means nothing to hear back about: the
  // provider is not called (a tenant using the flag for AVS only stays quiet).
  const recent = await prisma.collectionInstruction.count({
    where: { tenantId: ctx.tenantId, submittedAt: { gte: from }, mandate: { provider: ctx.provider.id } },
  })
  if (recent > 0) {
    const awaiting = await prisma.collectionInstruction.findMany({
      where: { tenantId: ctx.tenantId, status: "SUBMITTED", mandate: { provider: ctx.provider.id } },
      select: {
        instructionRef: true, amountCents: true, actionDate: true,
        mandate: { select: { providerMandateRef: true } }, batch: { select: { providerBatchRef: true } },
      },
    })
    const outcomes = await ctx.provider.fetchResults({
      from,
      to: ctx.now,
      awaiting: awaiting.map((i) => ({
        instructionRef: i.instructionRef, mandateRef: i.mandate.providerMandateRef ?? "", batchRef: i.batch?.providerBatchRef ?? null,
        amountCents: i.amountCents, actionDate: i.actionDate,
      })),
    }, ctx.creds)
    summary.fetched = outcomes.length
    // Chronological, PAID first on a tie: a payment is recorded before the return that reverses it.
    const byTime = (a: CollectionOutcome, b: CollectionOutcome) =>
      a.resolvedAt.getTime() - b.resolvedAt.getTime() || Number(b.status === "PAID") - Number(a.status === "PAID")
    for (const o of [...outcomes].sort(byTime)) {
      try {
        await recordOutcome(ctx, o, summary)
      } catch (error) {
        summary.errors.push(`${o.instructionRef}: ${errorSummary(error)}`)
      }
    }
  }
  summary.suspended += await applyStopRulesToAll(ctx, summary.errors)
  return summary
}
