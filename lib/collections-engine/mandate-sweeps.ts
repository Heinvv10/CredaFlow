/**
 * Sweeps that keep mandates in step with the loan and with the bank.
 *
 * - closeMandatesOfClosedLoans: a loan that is no longer ACTIVE or DEFAULTED
 *   (settled, written off, pending write-off, cancelled, restructured) is not
 *   collected; its mandate is cancelled. Checked here, by the planner and again
 *   at submission, rather than hooked into every writer of Loan.status.
 * - cancelAtProvider: a mandate suspended or cancelled here is withdrawn at the
 *   provider too, or the bank still holds a live mandate. Failures are retried
 *   on every run (providerCancelledAt stays null until it succeeds).
 */
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { COLLECTIBLE_LOAN_STATUSES } from "./scheme-rules"
import { transitionMandate, engineActor } from "./mandate-lifecycle"
import { ENGINE_ACTOR, errorSummary, type EngineContext } from "./context"

export interface SweepSummary {
  closed: number
  providerCancelled: number
  errors: string[]
}

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

export async function cancelAtProvider(ctx: EngineContext, summary: SweepSummary): Promise<void> {
  const owed = await prisma.debitMandate.findMany({
    where: {
      tenantId: ctx.tenantId, provider: ctx.provider.id, status: { in: ["SUSPENDED", "CANCELLED"] },
      providerMandateRef: { not: null }, providerCancelledAt: null,
    },
    select: { id: true, providerMandateRef: true, status: true },
  })
  for (const m of owed) {
    try {
      await ctx.provider.cancelMandate(m.providerMandateRef!, ctx.creds)
      await prisma.$transaction(async (tx) => {
        await tx.debitMandate.updateMany({ where: { id: m.id, tenantId: ctx.tenantId, providerCancelledAt: null }, data: { providerCancelledAt: ctx.now } })
        await logAuditStrict({
          tenantId: ctx.tenantId, userEmail: ENGINE_ACTOR.userEmail,
          action: AuditAction.COLLECTION_MANDATE_PROVIDER_CANCELLED, entity: "DebitMandate", entityId: m.id,
          newValue: { provider: ctx.provider.id, status: m.status },
        }, tx)
      })
      summary.providerCancelled++
    } catch (error) {
      summary.errors.push(`${m.id}: provider cancel failed: ${errorSummary(error)}`)
    }
  }
}
