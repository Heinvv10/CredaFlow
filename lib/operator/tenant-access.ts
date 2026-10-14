/**
 * The one decision on whether an operator user may act inside a lender.
 *
 * Operator staff hold no tenant, so every tenant gate refuses them by default.
 * They get in only with an active TenantSupportGrant from that lender (not
 * revoked, not expired), only into a lender their own operator runs, only on
 * a session whose sign-in verified a TOTP code, and only as READONLY. Every
 * allowed use is audited strictly (no audit row, no access) and every refusal
 * is audited, under the lender's tenantId.
 */
import type { UserRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAudit, logAuditStrict } from "@/lib/audit"
import { hasMinRole } from "@/lib/permissions"
import { isOperatorRole, SUPPORT_ACCESS_ROLE } from "./roles"
import { findActiveSupportGrant } from "./support-grants"

export type OperatorSession = {
  id: string
  email: string
  totpVerified?: boolean
}

export type OperatorAccessRefusal =
  | "not_operator"
  | "totp_required"
  | "role_insufficient"
  | "wrong_operator"
  | "no_active_grant"

export type OperatorTenantAccess =
  | {
      allowed: true
      grantId: string
      principal: {
        id: string
        email: string
        name: string | null
        role: typeof SUPPORT_ACCESS_ROLE
        tenantId: string
        totpVerified: true
      }
    }
  | { allowed: false; reason: OperatorAccessRefusal }

export async function resolveOperatorTenantAccess(input: {
  session: OperatorSession
  tenantId: string
  /** The minimum staff role the route requires; support access is READONLY. */
  requiredRole?: UserRole
  /** What was asked for (route path or guard), recorded on the audit row. */
  resource?: string
  ipAddress?: string
  now?: Date
}): Promise<OperatorTenantAccess> {
  const { session, tenantId, resource, ipAddress } = input
  const now = input.now ?? new Date()

  // The session's claims are not trusted for authority: the row is read.
  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: { id: true, email: true, name: true, active: true, role: true, operatorId: true },
  })
  const audit = { tenantId, userId: session.id, userEmail: user?.email ?? session.email, entity: "TenantSupportGrant", ipAddress }

  const refuse = async (reason: OperatorAccessRefusal): Promise<OperatorTenantAccess> => {
    await logAudit({ ...audit, action: AuditAction.SUPPORT_ACCESS_REFUSED, newValue: { reason, resource: resource ?? null } })
    return { allowed: false, reason }
  }

  if (!user || !user.active || !isOperatorRole(user.role) || !user.operatorId) return refuse("not_operator")
  if (session.totpVerified !== true) return refuse("totp_required")
  if (input.requiredRole && !hasMinRole(SUPPORT_ACCESS_ROLE, input.requiredRole)) return refuse("role_insufficient")

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { operatorId: true } })
  if (!tenant || tenant.operatorId !== user.operatorId) return refuse("wrong_operator")

  const grant = await findActiveSupportGrant(tenantId, user.id, now)
  if (!grant) return refuse("no_active_grant")

  await logAuditStrict({
    ...audit,
    action: AuditAction.SUPPORT_ACCESS_USED,
    entityId: grant.id,
    newValue: { resource: resource ?? null, grantId: grant.id, grantExpiresAt: grant.expiresAt.toISOString() },
  })
  return {
    allowed: true,
    grantId: grant.id,
    principal: {
      id: user.id, email: user.email, name: user.name,
      role: SUPPORT_ACCESS_ROLE, tenantId, totpVerified: true,
    },
  }
}
