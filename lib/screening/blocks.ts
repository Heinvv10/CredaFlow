import type { UserRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { REVIEW_REASON_MAX_LENGTH, REVIEW_REASON_MIN_LENGTH } from "./policy"
import { lockSubjectScreening } from "./store"
import { readSubjectScreening } from "./gate"
import { amlStatusFor, type ScreeningState } from "./state"
import { refOf } from "./subject"

export type LiftOutcome =
  | { ok: true; state: ScreeningState }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string }

/**
 * Lifts one sticky ScreeningBlock. SUPER_ADMIN only, in a session that
 * verified TOTP (the demo waiver aside), with a reason; once. Lifting ends the
 * stickiness only: the subject's latest run must still be clear on its own, so
 * a block whose sanctions match is still in the latest run keeps blocking.
 * The trigger guardScreeningBlock repeats the SUPER_ADMIN and once-only rules.
 */
export async function liftScreeningBlock(input: {
  tenantId: string
  blockId: string
  reason: string
  actor: { id: string; email: string; role: UserRole; totpVerified: boolean }
  totpWaived: boolean
  ipAddress?: string
}): Promise<LiftOutcome> {
  const { tenantId, blockId, actor } = input
  if (actor.role !== "SUPER_ADMIN") return { ok: false, status: 403, error: "Only a super admin lifts a screening block." }
  if (!actor.totpVerified && !input.totpWaived) {
    return { ok: false, status: 403, error: "Sign in with two-factor authentication to lift a screening block." }
  }
  const reason = input.reason.trim()
  const length = [...reason].length
  if (length < REVIEW_REASON_MIN_LENGTH || length > REVIEW_REASON_MAX_LENGTH) {
    return { ok: false, status: 400, error: `Give a reason of ${REVIEW_REASON_MIN_LENGTH} to ${REVIEW_REASON_MAX_LENGTH} characters.` }
  }
  const block = await prisma.screeningBlock.findFirst({
    where: { id: blockId, tenantId },
    select: { id: true, clientId: true, entityId: true, reason: true, sourceCheckId: true },
  })
  if (!block) return { ok: false, status: 404, error: "Screening block not found." }
  const ref = refOf(block)

  return prisma.$transaction(async (tx): Promise<LiftOutcome> => {
    await lockSubjectScreening(tx, tenantId, ref)
    const liftedAt = new Date()
    const written = await tx.screeningBlock.updateMany({
      where: { id: block.id, tenantId, liftedAt: null },
      data: { liftedById: actor.id, liftedAt, liftReason: reason },
    })
    if (written.count === 0) return { ok: false, status: 409, error: "This block has already been lifted." }
    const { state } = await readSubjectScreening(tenantId, ref, tx)
    const aml = amlStatusFor(state)
    if (aml && "clientId" in ref) {
      await tx.client.updateMany({ where: { id: ref.clientId, tenantId }, data: { amlScreeningStatus: aml } })
    }
    await logAuditStrict({
      tenantId,
      userId: actor.id,
      userEmail: actor.email,
      action: AuditAction.SCREENING_BLOCK_LIFTED,
      entity: "ScreeningBlock",
      entityId: block.id,
      oldValue: { liftedAt: null },
      newValue: {
        ...ref,
        blockReason: block.reason,
        sourceCheckId: block.sourceCheckId,
        liftReason: reason,
        liftedAt: liftedAt.toISOString(),
        subjectState: state.state,
        ...(input.totpWaived && !actor.totpVerified ? { twoFactor: "waived: demo stack without TOTP" } : {}),
      },
      ipAddress: input.ipAddress,
    }, tx)
    return { ok: true, state }
  })
}
