import type { RecoveryStatus } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import type { RecoveryActor } from "./recovery-create"
import { isNcaRoute } from "./recovery-input"
import { advance, RecoveryRefusal, refusable, type NotFound, type NotReady } from "./recovery-result"

export type OutcomeSettled = { kind: "done"; id: string; status: Extract<RecoveryStatus, "SHORTFALL_OPEN" | "SURPLUS_HELD" | "CLOSED"> }

// Opens the outcome of a recovery once its charge freeze is fixed: an NCA
// recovery after its final notice (which sets the freeze end, 10 business days
// on), a NON_NCA one after its proceeds (which set it at the demand period).
// The freeze dates are write-once and already on the recovery by then; what is
// decided here is only the status they lead to:
//   owed > 0     -> SHORTFALL_OPEN (charges stay frozen until the deadline,
//                    then the deadline sweep hands the loan on to collections)
//   surplus  > 0 -> SURPLUS_HELD (a RecoveryRefund pays it out, two people)
//   neither      -> CLOSED
// A written-off loan is never the result: write-off stays a human decision.
// The shortfall/surplus handling is signed off (see DESIGN.md sign-off record 2026-10-17).

export async function settleOutcome(actor: RecoveryActor, recoveryId: string): Promise<NotFound | NotReady | OutcomeSettled> {
  return refusable(() => prisma.$transaction(async (tx): Promise<NotFound | OutcomeSettled> => {
    const recovery = await tx.recovery.findFirst({
      where: { id: recoveryId, tenantId: actor.tenantId },
      select: { id: true, route: true, status: true, shortfallCents: true, surplusCents: true, unrecoverableCostsCents: true, chargesFrozenFrom: true, chargesFrozenUntil: true },
    })
    if (!recovery) return { kind: "not_found" }
    const nca = isNcaRoute(recovery.route)
    const from: RecoveryStatus = nca ? "FINAL_NOTICE_ISSUED" : "PROCEEDS_APPLIED"
    if (recovery.status !== from) {
      throw new RecoveryRefusal(nca ? "An NCA recovery opens its outcome after its final notice" : "A recovery opens its outcome after its proceeds are applied")
    }
    if (!recovery.chargesFrozenFrom || !recovery.chargesFrozenUntil) throw new RecoveryRefusal("The charge freeze has no end date yet")
    const shortfall = recovery.shortfallCents ?? 0
    const surplus = recovery.surplusCents ?? 0
    // Owed on the account: the shortfall less the charged costs the account could not carry (they stay recorded on the recovery).
    const owed = shortfall - (recovery.unrecoverableCostsCents ?? 0)
    const status: OutcomeSettled["status"] = owed > 0 ? "SHORTFALL_OPEN" : surplus > 0 ? "SURPLUS_HELD" : "CLOSED"
    await advance(tx, actor, recovery.id, from, { status, ...(status === "CLOSED" ? { closedAt: new Date() } : {}) })
    const audit = { tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined }
    await logAuditStrict({
      ...audit, action: AuditAction.ASSET_RECOVERY_OUTCOME_SETTLED, entity: "Recovery", entityId: recovery.id,
      newValue: { status, shortfallCents: shortfall, surplusCents: surplus, unrecoverableCostsCents: recovery.unrecoverableCostsCents ?? 0, owedCents: owed },
    }, tx)
    if (status === "CLOSED") {
      await logAuditStrict({ ...audit, action: AuditAction.ASSET_RECOVERY_CLOSED, entity: "Recovery", entityId: recovery.id, newValue: { reason: "nothing owed either way" } }, tx)
    }
    return { kind: "done", id: recovery.id, status }
  }))
}
