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
import { dayOf, loadEngineContext, providerFor } from "./context"

export type ReviewAction =
  | { kind: "INSTRUCTION"; id: string; action: "MARK_SUBMITTED" | "RELEASE" | "ACKNOWLEDGE"; confirmedNotSent?: boolean }
  /** An unbooked PAID result needs paymentId (the receipt captured by hand) or noMoneyReceived. */
  | { kind: "RESULT"; id: string; action: "ACKNOWLEDGE"; paymentId?: string; noMoneyReceived?: boolean; amountOverrideReason?: string }
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
    // Without a provider answer that it never arrived, a release needs the staff member's word.
    if (found?.state !== "NOT_FOUND" && !item.confirmedNotSent) {
      throw new MandateError("INVALID_STATE", "Confirm with the provider that it was not received, and say so, before releasing it")
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
        : { status: "PENDING", batchId: null, statusReason: `Released: ${reason}`, releasedAt: now }
      changed = (await tx.collectionInstruction.updateMany({ where: { id: item.id, tenantId, status: "NEEDS_REVIEW" }, data })).count
    } else if (item.kind === "RESULT") {
      const result = await tx.collectionResult.findFirst({
        where: { id: item.id, tenantId },
        select: { outcome: true, paymentId: true, settledAmountCents: true, instruction: { select: { loanId: true, amountCents: true, actionDate: true } } },
      })
      const unbooked = result?.outcome === "PAID" && !result.paymentId
      if (unbooked && !!item.paymentId === (item.noMoneyReceived === true)) {
        throw new MandateError("INVALID_STATE", "This payment was not booked: name the receipt you captured for it, or confirm no money was received")
      }
      if (unbooked && item.paymentId) {
        const receipt = await tx.payment.findFirst({
          where: { id: item.paymentId, tenantId, loanId: result!.instruction.loanId, reversed: false, collectionResults: { none: {} } },
          select: { id: true, amount: true, receivedAt: true, excessPayments: { select: { amount: true } } },
        })
        if (!receipt) throw new MandateError("INVALID_STATE", "That receipt is not a live receipt on this loan, or it is already linked to a collection")
        // The receipt must be this money: the settled amount, or the debit amount with a stated reason, received on or after the debit.
        const total = receipt.amount + receipt.excessPayments.reduce((sum, p) => sum + p.amount, 0)
        const override = item.amountOverrideReason?.trim()
        if (total !== result!.settledAmountCents && !(total === result!.instruction.amountCents && override)) {
          throw new MandateError("INVALID_STATE", total === result!.instruction.amountCents
            ? "The receipt is for the debit amount, not the settled amount: give the reason to link it"
            : "The receipt's amount matches neither the settled amount nor the debit amount")
        }
        if (dayOf(receipt.receivedAt) < dayOf(result!.instruction.actionDate)) {
          throw new MandateError("INVALID_STATE", "The receipt is dated before the debit's action date")
        }
      }
      changed = (await tx.collectionResult.updateMany({
        where: { id: item.id, tenantId, reviewReason: { not: null }, reviewResolvedAt: null },
        data: { reviewResolvedAt: now, reviewResolvedById: actor.userId, reviewNote: reason, ...(unbooked && item.paymentId ? { paymentId: item.paymentId } : {}) },
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
      newValue: {
        action: item.action, reason,
        ...(item.kind === "INSTRUCTION" && item.action === "RELEASE" ? { confirmedNotSent: item.confirmedNotSent === true } : {}),
        ...(item.kind === "RESULT" ? {
          paymentId: item.paymentId ?? null, noMoneyReceived: item.noMoneyReceived === true, amountOverrideReason: item.amountOverrideReason?.trim() || null,
        } : {}),
      },
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
