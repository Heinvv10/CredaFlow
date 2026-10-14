/**
 * Sweeps that keep mandates in step with the loan and with the bank.
 *
 * - closeMandatesOfClosedLoans: a loan that is no longer ACTIVE or DEFAULTED
 *   (settled, written off, pending write-off, cancelled, restructured) is not
 *   collected; its mandate is cancelled. Checked here, by the planner and again
 *   at submission, rather than hooked into every writer of Loan.status.
 * - cancelAtProvider: a mandate suspended or cancelled here is withdrawn at the
 *   provider too, or the bank still holds a live mandate. A mandate the
 *   provider was contacted about but never gave a reference for (cancelled
 *   mid-call, or before a file-based rail registered it) is looked up by our
 *   reference and cancelled there; a provider that still has no record of it
 *   after the registration timeout has confirmed there is nothing to withdraw.
 *   Only a rail that cannot be queried makes it a review item, and only that
 *   review (raised here) pauses the sweep; any other review flag does not.
 *   providerCancelledAt is written only after a real cancel or that confirmed
 *   not-found, never by staff acknowledgement. Failures are retried each run.
 *
 * Both act on every mandate of the tenant, whichever provider it was created
 * with, not only the tenant's current provider.
 */
import type { DebitMandateStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { COLLECTIBLE_LOAN_STATUSES, LOAD_REPORT_TIMEOUT_HOURS } from "./scheme-rules"
import { flagMandateForReview, keepProviderReference, transitionMandate, engineActor } from "./mandate-lifecycle"
import { ENGINE_ACTOR, errorSummary, providerFor, type EngineContext } from "./context"

export interface SweepSummary {
  closed: number
  providerCancelled: number
  errors: string[]
}

/** Prefix of the review this sweep raises itself; only that one pauses it. */
export const WITHDRAWAL_REVIEW = "Withdrawal unconfirmed: "

export const emptySweep = (): SweepSummary => ({ closed: 0, providerCancelled: 0, errors: [] })

export async function closeMandatesOfClosedLoans(ctx: EngineContext, summary: SweepSummary): Promise<void> {
  const stranded = await prisma.debitMandate.findMany({
    where: {
      tenantId: ctx.tenantId,
      status: { in: ["CREATED", "SUBMITTING", "PENDING_REGISTRATION", "PENDING_AUTH", "ACTIVE", "SUSPENDED"] },
      loan: { status: { notIn: [...COLLECTIBLE_LOAN_STATUSES] } },
    },
    select: { id: true, status: true, loan: { select: { status: true } } },
  })
  for (const m of stranded) {
    try {
      const moved = await transitionMandate({
        tenantId: ctx.tenantId, mandateId: m.id, from: m.status, to: "CANCELLED",
        reason: `Loan is ${m.loan.status}`, actor: engineActor, now: ctx.now,
      })
      if (moved) summary.closed++
    } catch (error) {
      summary.errors.push(`${m.id}: ${errorSummary(error)}`)
    }
  }
}

async function markCancelledAtProvider(ctx: EngineContext, m: { id: string; provider: string; status: DebitMandateStatus }, note: Record<string, unknown>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.debitMandate.updateMany({ where: { id: m.id, tenantId: ctx.tenantId, providerCancelledAt: null }, data: { providerCancelledAt: ctx.now } })
    await logAuditStrict({
      tenantId: ctx.tenantId, userEmail: ENGINE_ACTOR.userEmail,
      action: AuditAction.COLLECTION_MANDATE_PROVIDER_CANCELLED, entity: "DebitMandate", entityId: m.id,
      newValue: { provider: m.provider, status: m.status, ...note },
    }, tx)
  })
}

export async function cancelAtProvider(ctx: EngineContext, summary: SweepSummary): Promise<void> {
  const owed = await prisma.debitMandate.findMany({
    where: {
      tenantId: ctx.tenantId, status: { in: ["SUSPENDED", "CANCELLED"] }, providerCancelledAt: null,
      OR: [{ providerMandateRef: { not: null } }, { providerContactedAt: { not: null } }],
    },
    select: { id: true, provider: true, providerMandateRef: true, status: true, statusChangedAt: true, reviewReason: true },
  })
  const timeout = new Date(ctx.now.getTime() - LOAD_REPORT_TIMEOUT_HOURS * 3_600_000)
  for (const m of owed) {
    try {
      const provider = providerFor(ctx, m.provider)
      let ref = m.providerMandateRef
      if (!ref) {
        if (m.reviewReason?.startsWith(WITHDRAWAL_REVIEW)) continue
        if (!provider.findMandate) {
          await flagMandateForReview(ctx, m.id,
            `${WITHDRAWAL_REVIEW}${m.provider} cannot be looked up by our reference: confirm with the provider that it holds no mandate, cancel it there if it does, then acknowledge`)
          continue
        }
        const found = await provider.findMandate(m.id, ctx.creds)
        ref = found?.providerMandateRef ?? null
        if (!ref) {
          if (!found && m.statusChangedAt < timeout) {
            // Past the registration window and still unknown to the provider: nothing to withdraw.
            await markCancelledAtProvider(ctx, m, { notFoundAtProvider: true })
            summary.providerCancelled++
          }
          continue
        }
        await keepProviderReference(ctx, m.id, ref, found?.simulated === true)
      }
      await provider.cancelMandate(ref, ctx.creds)
      await markCancelledAtProvider(ctx, m, { providerMandateRef: ref, foundByReference: !m.providerMandateRef })
      summary.providerCancelled++
    } catch (error) {
      summary.errors.push(`${m.id}: provider cancel failed: ${errorSummary(error)}`)
    }
  }
}
