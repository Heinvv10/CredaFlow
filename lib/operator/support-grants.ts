/**
 * Lender-granted support access for operator staff.
 *
 * A lender's ADMIN or SUPER_ADMIN grants one operator user read-only access
 * to the lender for at most 7 days, and may revoke it. Every grant, refusal
 * and revocation is audited under the lender's tenantId. The database holds
 * the same rules (migration 20261014120000_operator_and_support_grants):
 * the 7-day window, the granter's tenant and role, the operator user's
 * operator, revoke-once and no deletes.
 *
 * The console that calls these is a later workstream (W1).
 */
import type { TenantSupportGrant, UserRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAudit, logAuditStrict } from "@/lib/audit"
import { isOperatorRole, SUPPORT_GRANTER_ROLES } from "./roles"

export const MAX_SUPPORT_GRANT_MS = 7 * 24 * 60 * 60 * 1000
const MAX_REASON_LENGTH = 500

/** The lender staff member granting or revoking (a requireApiRole principal). */
export type GrantActor = {
  id: string
  email: string
  role: UserRole
  tenantId: string
  totpVerified?: boolean
}

export type SupportGrantRefusalReason =
  | "not_lender_admin"
  | "totp_required"
  | "bad_window"
  | "reason_required"
  | "operator_user_invalid"
  | "grant_not_found"

export class SupportGrantRefusal extends Error {
  constructor(readonly reason: SupportGrantRefusalReason) {
    super(`Support grant refused: ${reason}`)
    this.name = "SupportGrantRefusal"
  }
}

function actorRefusal(actor: GrantActor, tenantId: string): SupportGrantRefusalReason | null {
  if (actor.tenantId !== tenantId || !(SUPPORT_GRANTER_ROLES as readonly string[]).includes(actor.role)) {
    return "not_lender_admin"
  }
  // Opening the lender's borrower data to an outsider is at least as
  // sensitive as editing the lender's identity, which needs the same claim.
  if (actor.totpVerified !== true) return "totp_required"
  return null
}

async function refuse(
  action: string,
  actor: GrantActor,
  tenantId: string,
  reason: SupportGrantRefusalReason,
  detail: Record<string, unknown>,
  ipAddress?: string,
): Promise<never> {
  await logAudit({
    tenantId, userId: actor.id, userEmail: actor.email, action,
    entity: "TenantSupportGrant", newValue: { reason, ...detail }, ipAddress,
  })
  throw new SupportGrantRefusal(reason)
}

export async function grantSupportAccess(input: {
  tenantId: string
  actor: GrantActor
  operatorUserId: string
  expiresAt: Date
  reason: string
  ipAddress?: string
  now?: Date
}): Promise<TenantSupportGrant> {
  const { tenantId, actor, operatorUserId, expiresAt, ipAddress } = input
  const now = input.now ?? new Date()
  const reason = input.reason.trim()
  const detail = { operatorUserId, expiresAt: expiresAt.toISOString() }
  const R = AuditAction.SUPPORT_ACCESS_GRANT_REFUSED

  const actorReason = actorRefusal(actor, tenantId)
  if (actorReason) return refuse(R, actor, tenantId, actorReason, detail, ipAddress)
  const window = expiresAt.getTime() - now.getTime()
  if (!(window > 0 && window <= MAX_SUPPORT_GRANT_MS)) return refuse(R, actor, tenantId, "bad_window", detail, ipAddress)
  if (!reason || reason.length > MAX_REASON_LENGTH) return refuse(R, actor, tenantId, "reason_required", detail, ipAddress)

  const [operatorUser, tenant] = await Promise.all([
    prisma.user.findUnique({ where: { id: operatorUserId }, select: { active: true, role: true, operatorId: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { operatorId: true } }),
  ])
  if (
    !operatorUser || !operatorUser.active || !isOperatorRole(operatorUser.role) ||
    !operatorUser.operatorId || operatorUser.operatorId !== tenant?.operatorId
  ) {
    return refuse(R, actor, tenantId, "operator_user_invalid", detail, ipAddress)
  }

  return prisma.$transaction(async (tx) => {
    const grant = await tx.tenantSupportGrant.create({
      data: { tenantId, operatorUserId, grantedById: actor.id, reason, expiresAt },
    })
    await logAuditStrict({
      tenantId, userId: actor.id, userEmail: actor.email, action: AuditAction.SUPPORT_ACCESS_GRANTED,
      entity: "TenantSupportGrant", entityId: grant.id, newValue: { ...detail, reason }, ipAddress,
    }, tx)
    return grant
  })
}

export async function revokeSupportAccess(input: {
  tenantId: string
  actor: GrantActor
  grantId: string
  ipAddress?: string
  now?: Date
}): Promise<TenantSupportGrant> {
  const { tenantId, actor, grantId, ipAddress } = input
  const R = AuditAction.SUPPORT_ACCESS_GRANT_REFUSED
  const actorReason = actorRefusal(actor, tenantId)
  if (actorReason) return refuse(R, actor, tenantId, actorReason, { grantId, revoke: true }, ipAddress)

  const revokedAt = input.now ?? new Date()
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.tenantSupportGrant.updateMany({
      where: { id: grantId, tenantId, revokedAt: null },
      data: { revokedAt, revokedById: actor.id },
    })
    if (count !== 1) throw new SupportGrantRefusal("grant_not_found")
    await logAuditStrict({
      tenantId, userId: actor.id, userEmail: actor.email, action: AuditAction.SUPPORT_ACCESS_REVOKED,
      entity: "TenantSupportGrant", entityId: grantId, newValue: { revokedAt: revokedAt.toISOString() }, ipAddress,
    }, tx)
    return tx.tenantSupportGrant.findUniqueOrThrow({ where: { id: grantId, tenantId } })
  })
}

/** The grant that lets `operatorUserId` into `tenantId` at `now`, if any. */
export function findActiveSupportGrant(tenantId: string, operatorUserId: string, now: Date = new Date()) {
  return prisma.tenantSupportGrant.findFirst({
    where: { tenantId, operatorUserId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { expiresAt: "desc" },
    select: { id: true, expiresAt: true },
  })
}
