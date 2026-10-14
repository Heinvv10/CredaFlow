/**
 * Staff resolution of the engine's review items. Every action names a reason,
 * is audited (COLLECTION_REVIEW_RESOLVED) and is refused while the tenant's
 * engine is off.
 *
 * - INSTRUCTION (NEEDS_REVIEW, fate unknown): MARK_SUBMITTED once the provider
 *   confirms it has it, or RELEASE to PENDING once it confirms it does not.
 *   The engine never makes this call itself: a wrong guess is a double debit
 *   or a missed one. A REJECTED instruction: ACKNOWLEDGE (it is not presented
 *   again; collect the instalment another way).
 * - RESULT (reviewReason set): ACKNOWLEDGE after acting on it elsewhere (a
 *   reversal, a manual receipt, a refund).
 * - MANDATE: RETRY (CREATED, submission retries exhausted) resets the retry
 *   budget; ACKNOWLEDGE clears any other review flag. It is not evidence of a
 *   withdrawal: providerCancelledAt is written only by a real provider cancel
 *   or a confirmed not-found (mandate-sweeps.ts), so the sweep keeps trying.
 * - INSTRUCTION RELEASE asks the provider again where the rail can be
 *   queried, and is refused if the provider has it.
 */
import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { MandateError } from "./mandates"
import { loadEngineContext, providerFor } from "./context"

export type ReviewAction =
  | { kind: "INSTRUCTION"; id: string; action: "MARK_SUBMITTED" | "RELEASE" | "ACKNOWLEDGE" }
  | { kind: "RESULT"; id: string; action: "ACKNOWLEDGE" }
  | { kind: "MANDATE"; id: string; action: "RETRY" | "ACKNOWLEDGE" }

export async function resolveReviewItem(
  tenantId: string,
  actor: { userId: string; userEmail: string | null },
  item: ReviewAction,
  reason: string,
  now = new Date(),
): Promise<void> {
  const ctx = await loadEngineContext(tenantId, now)
  if (!ctx) throw new MandateError("FLAG_OFF", "The collections engine is off for this lender")
  if (item.kind === "INSTRUCTION" && item.action === "RELEASE") {
    const i = await prisma.collectionInstruction.findFirst({
      where: { id: item.id, tenantId }, select: { instructionRef: true, mandate: { select: { provider: true } } },
    })
    const provider = i ? providerFor(ctx, i.mandate.provider) : null
    const found = i && provider?.findInstruction ? await provider.findInstruction(i.instructionRef, ctx.creds) : null
    if (found?.state === "ACCEPTED" || found?.state === "REJECTED") {
      throw new MandateError("INVALID_STATE", `Not released: the provider has it (${found.state}). Mark it submitted instead.`)
    }
  }
  await prisma.$transaction(async (tx) => {
    let changed = 0
    if (item.kind === "INSTRUCTION" && item.action === "ACKNOWLEDGE") {
      changed = (await tx.collectionInstruction.updateMany({
        where: { id: item.id, tenantId, status: "REJECTED", reviewResolvedAt: null },
        data: { reviewResolvedAt: now },
      })).count
    } else if (item.kind === "INSTRUCTION") {
      const data: Prisma.CollectionInstructionUncheckedUpdateManyInput = item.action === "MARK_SUBMITTED"
        ? { status: "SUBMITTED", submittedAt: now, statusReason: `Confirmed submitted: ${reason}` }
        : { status: "PENDING", batchId: null, statusReason: `Released: ${reason}` }
      changed = (await tx.collectionInstruction.updateMany({ where: { id: item.id, tenantId, status: "NEEDS_REVIEW" }, data })).count
    } else if (item.kind === "RESULT") {
      changed = (await tx.collectionResult.updateMany({
        where: { id: item.id, tenantId, reviewReason: { not: null }, reviewResolvedAt: null },
        data: { reviewResolvedAt: now, reviewResolvedById: actor.userId, reviewNote: reason },
      })).count
    } else if (item.action === "RETRY") {
      changed = (await tx.debitMandate.updateMany({
        where: { id: item.id, tenantId, status: "CREATED", reviewReason: { not: null } },
        data: { reviewReason: null, submitAttempts: 0, nextAttemptAt: null },
      })).count
    } else {
      changed = (await tx.debitMandate.updateMany({
        where: { id: item.id, tenantId, status: { not: "CREATED" }, reviewReason: { not: null } },
        data: { reviewReason: null },
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
  instructions: Array<{ id: string; loanId: string; status: string; instructionRef: string; amountCents: number; actionDate: Date; statusReason: string | null }>
  results: Array<{ id: string; loanId: string; outcome: string; reviewReason: string | null; resolvedAt: Date; paymentId: string | null }>
  mandates: Array<{ id: string; loanId: string; status: string; reviewReason: string | null }>
}

/** Everything waiting for a person, tenant-wide or for one loan. */
export async function loadReviewQueue(tenantId: string, loanId?: string): Promise<ReviewQueue> {
  const loan = loanId ? { loanId } : {}
  const [instructions, results, mandates] = await Promise.all([
    prisma.collectionInstruction.findMany({
      where: { tenantId, OR: [{ status: "NEEDS_REVIEW" }, { status: "REJECTED", reviewResolvedAt: null }], ...loan },
      select: { id: true, loanId: true, status: true, instructionRef: true, amountCents: true, actionDate: true, statusReason: true },
      orderBy: { actionDate: "asc" },
    }),
    prisma.collectionResult.findMany({
      where: { tenantId, reviewReason: { not: null }, reviewResolvedAt: null, ...(loanId ? { instruction: { loanId } } : {}) },
      select: { id: true, outcome: true, reviewReason: true, resolvedAt: true, paymentId: true, instruction: { select: { loanId: true } } },
      orderBy: { resolvedAt: "asc" },
    }),
    prisma.debitMandate.findMany({
      where: { tenantId, reviewReason: { not: null }, ...loan },
      select: { id: true, loanId: true, status: true, reviewReason: true },
    }),
  ])
  return {
    instructions,
    results: results.map(({ instruction, ...r }) => ({ ...r, loanId: instruction.loanId })),
    mandates,
  }
}
