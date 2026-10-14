/**
 * What an unpaid or disputed collection sets in motion.
 *
 * - A LoanNote on the loan, so collections staff see it in the contact history.
 *   Arrears and DPD come from the schedule, which an unpaid debit does not
 *   change; the existing reminder and escalation crons act on them. The
 *   collections stage stays staff-advanced (lib/collections/.claude.md): the
 *   engine never moves it, and it sends no borrower message itself.
 * - The scheme stop rules (scheme-rules.ts suspensionReason) over every result
 *   on the mandate: two consecutive NPFs, a hard-stop reason or a dispute
 *   suspend it, which also cancels its unsubmitted instructions.
 */
import { prisma } from "@/lib/prisma"
import { formatZAR } from "@/lib/utils"
import { suspensionReason } from "./scheme-rules"
import { transitionMandate, engineActor } from "./mandate-lifecycle"
import type { EngineContext } from "./context"

export const UNPAID_NOTE_TYPE = "debit_order_unpaid"

export async function noteUnpaidCollection(ctx: EngineContext, args: {
  loanId: string
  instalmentNo: number
  presentmentNo: number
  amountCents: number
  outcome: "UNPAID" | "DISPUTED"
  reasonCode: string | null
}): Promise<void> {
  const what = args.outcome === "DISPUTED" ? "was disputed by the debtor" : `came back unpaid (${args.reasonCode ?? "no reason given"})`
  await prisma.loanNote.create({
    data: {
      tenantId: ctx.tenantId,
      loanId: args.loanId,
      type: UNPAID_NOTE_TYPE,
      note: `Debit order of ${formatZAR(args.amountCents)} for instalment ${args.instalmentNo} (presentment ${args.presentmentNo}) ${what}.`,
      createdBy: "system",
    },
  })
}

/** Suspend the mandate if the scheme stop rules say so. Returns the reason, or null. */
export async function applyStopRules(ctx: EngineContext, mandateId: string): Promise<string | null> {
  const mandate = await prisma.debitMandate.findFirst({
    where: { id: mandateId, tenantId: ctx.tenantId },
    select: { status: true, instructions: { select: { results: { select: { outcome: true, reasonCode: true, resolvedAt: true } } } } },
  })
  if (!mandate || mandate.status !== "ACTIVE") return null
  const reason = suspensionReason(mandate.instructions.flatMap((i) => i.results))
  if (!reason) return null
  await transitionMandate({
    tenantId: ctx.tenantId, mandateId, from: "ACTIVE", to: "SUSPENDED", reason, actor: engineActor, now: ctx.now,
  })
  return reason
}
