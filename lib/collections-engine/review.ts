/**
 * Staff resolution of the engine's review items. Every action names a reason,
 * is audited (COLLECTION_REVIEW_RESOLVED) and is refused while the tenant's
 * engine is off.
 *
 * - INSTRUCTION (NEEDS_REVIEW, fate unknown): MARK_SUBMITTED once the provider
 *   confirms it has it, or RELEASE to PENDING once it confirms it does not.
 *   The engine never makes this call itself: a wrong guess is a double debit
 *   or a missed one.
 * - RESULT (reviewReason set): ACKNOWLEDGE after acting on it elsewhere (a
 *   reversal, a manual receipt, a refund).
 * - MANDATE (submission retries exhausted): RETRY resets the retry budget.
 */
import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { MandateError } from "./mandates"
import { loadEngineContext } from "./context"

export type ReviewAction =
  | { kind: "INSTRUCTION"; id: string; action: "MARK_SUBMITTED" | "RELEASE" }
  | { kind: "RESULT"; id: string; action: "ACKNOWLEDGE" }
  | { kind: "MANDATE"; id: string; action: "RETRY" }

export async function resolveReviewItem(
  tenantId: string,
  actor: { userId: string; userEmail: string | null },
  item: ReviewAction,
  reason: string,
  now = new Date(),
): Promise<void> {
  if (!(await loadEngineContext(tenantId, now))) throw new MandateError("FLAG_OFF", "The collections engine is off for this lender")
  await prisma.$transaction(async (tx) => {
    let changed = 0
    if (item.kind === "INSTRUCTION") {
      const data: Prisma.CollectionInstructionUncheckedUpdateManyInput = item.action === "MARK_SUBMITTED"
        ? { status: "SUBMITTED", submittedAt: now, statusReason: `Confirmed submitted: ${reason}` }
        : { status: "PENDING", batchId: null, statusReason: `Released: ${reason}` }
      changed = (await tx.collectionInstruction.updateMany({ where: { id: item.id, tenantId, status: "NEEDS_REVIEW" }, data })).count
    } else if (item.kind === "RESULT") {
      changed = (await tx.collectionResult.updateMany({
        where: { id: item.id, tenantId, reviewReason: { not: null }, reviewResolvedAt: null },
        data: { reviewResolvedAt: now, reviewResolvedById: actor.userId, reviewNote: reason },
      })).count
    } else {
      changed = (await tx.debitMandate.updateMany({
        where: { id: item.id, tenantId, status: "CREATED", reviewReason: { not: null } },
        data: { reviewReason: null, submitAttempts: 0, nextAttemptAt: null },
      })).count
    }
    if (changed === 0) throw new MandateError("INVALID_STATE", "Nothing to resolve: the item is not waiting for review")
    await logAuditStrict({
      tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.COLLECTION_REVIEW_RESOLVED,
      entity: item.kind === "INSTRUCTION" ? "CollectionInstruction" : item.kind === "RESULT" ? "CollectionResult" : "DebitMandate",
      entityId: item.id,
      newValue: { action: item.action, reason },
    }, tx)
  })
}

export interface ReviewQueue {
  instructions: Array<{ id: string; loanId: string; instructionRef: string; amountCents: number; actionDate: Date; statusReason: string | null }>
  results: Array<{ id: string; loanId: string; outcome: string; reviewReason: string | null; resolvedAt: Date; paymentId: string | null }>
  mandates: Array<{ id: string; loanId: string; reviewReason: string | null }>
}

/** Everything waiting for a person, tenant-wide or for one loan. */
export async function loadReviewQueue(tenantId: string, loanId?: string): Promise<ReviewQueue> {
  const loan = loanId ? { loanId } : {}
  const [instructions, results, mandates] = await Promise.all([
    prisma.collectionInstruction.findMany({
      where: { tenantId, status: "NEEDS_REVIEW", ...loan },
      select: { id: true, loanId: true, instructionRef: true, amountCents: true, actionDate: true, statusReason: true },
      orderBy: { actionDate: "asc" },
    }),
    prisma.collectionResult.findMany({
      where: { tenantId, reviewReason: { not: null }, reviewResolvedAt: null, ...(loanId ? { instruction: { loanId } } : {}) },
      select: { id: true, outcome: true, reviewReason: true, resolvedAt: true, paymentId: true, instruction: { select: { loanId: true } } },
      orderBy: { resolvedAt: "asc" },
    }),
    prisma.debitMandate.findMany({
      where: { tenantId, status: "CREATED", reviewReason: { not: null }, ...loan },
      select: { id: true, loanId: true, reviewReason: true },
    }),
  ])
  return {
    instructions,
    results: results.map(({ instruction, ...r }) => ({ ...r, loanId: instruction.loanId })),
    mandates,
  }
}
