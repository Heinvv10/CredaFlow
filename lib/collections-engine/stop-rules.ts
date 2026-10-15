/**
 * Applies the scheme stop rules (scheme-rules.ts suspensionReason) to one
 * mandate from what is stored: two consecutive NPFs, a hard-stop reason or a
 * dispute suspend it, which also cancels its unsubmitted instructions; the
 * provider-side withdrawal follows in cancelAtProvider.
 *
 * Derived, not event-driven: it is re-run for every ACTIVE mandate on every
 * results run and before planning, so a suspension that a failed run never
 * wrote is applied on the next one. An UNPAID reported after the instruction
 * was already PAID is a review item, not an NPF, and is not counted.
 */
import { prisma } from "@/lib/prisma"
import { onePerInstructionOutcome, suspensionReason } from "./scheme-rules"
import { transitionMandate, engineActor } from "./mandate-lifecycle"
import type { EngineContext } from "./context"

export async function applyStopRules(ctx: EngineContext, mandateId: string): Promise<string | null> {
  const mandate = await prisma.debitMandate.findFirst({
    where: { id: mandateId, tenantId: ctx.tenantId },
    select: {
      status: true,
      instructions: { select: { id: true, results: { select: { outcome: true, reasonCode: true, resolvedAt: true, reportedAfterPayment: true } } } },
    },
  })
  if (!mandate || mandate.status !== "ACTIVE") return null
  // One fact per debit and outcome: a repeated unpaid report is not a second NPF.
  const facts = onePerInstructionOutcome(mandate.instructions
    .flatMap((i) => i.results.map((r) => ({ ...r, instructionId: i.id })))
    .filter((r) => !(r.reportedAfterPayment && r.outcome === "UNPAID")))
  const reason = suspensionReason(facts)
  if (!reason) return null
  const moved = await transitionMandate({
    tenantId: ctx.tenantId, mandateId, from: "ACTIVE", to: "SUSPENDED", reason, actor: engineActor, now: ctx.now,
  })
  return moved ? reason : null
}

/** Re-apply the stop rules to every ACTIVE mandate of the tenant, whichever provider it was created with. */
export async function applyStopRulesToAll(ctx: EngineContext, errors: string[]): Promise<number> {
  const active = await prisma.debitMandate.findMany({
    where: { tenantId: ctx.tenantId, status: "ACTIVE" },
    select: { id: true },
  })
  let suspended = 0
  for (const { id } of active) {
    try {
      if (await applyStopRules(ctx, id)) suspended++
    } catch (error) {
      errors.push(`${id}: stop rules: ${error instanceof Error ? error.name : "Error"}`)
    }
  }
  return suspended
}
