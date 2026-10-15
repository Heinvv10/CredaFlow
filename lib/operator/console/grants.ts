/**
 * Support grants as each side sees them.
 *
 *  - The operator user: the grants lenders gave *them* (my grants), to open
 *    a lender read-only (support-view.ts).
 *  - The lender (Settings → Support access): its grants, the operator users
 *    it may grant, and the support-access audit trail.
 *
 * Grants sit under row-level security, so each read runs in a frame: the
 * lender's own, or (my grants, which span lenders) the system frame with an
 * explicit filter on the operator user and their operator.
 */
import { prisma } from "@/lib/prisma"
import { runWithTenant, withoutTenantScope } from "@/lib/tenant-scope"
import { AuditAction } from "@/lib/audit"
import { OPERATOR_ROLES } from "../roles"

export type GrantState = "active" | "expired" | "revoked"

export function grantState(g: { expiresAt: Date; revokedAt: Date | null }, now: Date = new Date()): GrantState {
  if (g.revokedAt) return "revoked"
  return g.expiresAt > now ? "active" : "expired"
}

/** The grants held by one operator user, newest first, for lenders their operator runs. */
export function listMyGrants(operatorUserId: string, operatorId: string) {
  return withoutTenantScope(async () => await prisma.tenantSupportGrant.findMany({
    where: { operatorUserId, tenant: { operatorId } },
    select: {
      id: true, reason: true, expiresAt: true, revokedAt: true, createdAt: true,
      tenant: { select: { id: true, name: true, slug: true, status: true } },
      grantedBy: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  }))
}

/** A lender's grants, newest first. */
export function listTenantGrants(tenantId: string) {
  return runWithTenant(tenantId, async () => await prisma.tenantSupportGrant.findMany({
    where: { tenantId },
    select: {
      id: true, reason: true, expiresAt: true, revokedAt: true, createdAt: true,
      operatorUser: { select: { id: true, name: true, email: true, role: true } },
      grantedBy: { select: { name: true, email: true } },
      revokedBy: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  }))
}

/** The operator users a lender may grant: active staff of the operator that runs it. */
export async function listGrantableOperatorUsers(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { operatorId: true, operator: { select: { name: true } } } })
  if (!tenant?.operatorId) return { operatorName: null, users: [] }
  const users = await prisma.user.findMany({
    where: { operatorId: tenant.operatorId, active: true, role: { in: [...OPERATOR_ROLES] } },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { email: "asc" },
  })
  return { operatorName: tenant.operator?.name ?? null, users }
}

export const SUPPORT_AUDIT_ACTIONS = [
  AuditAction.SUPPORT_ACCESS_GRANTED,
  AuditAction.SUPPORT_ACCESS_REVOKED,
  AuditAction.SUPPORT_ACCESS_USED,
  AuditAction.SUPPORT_ACCESS_REFUSED,
  AuditAction.SUPPORT_ACCESS_GRANT_REFUSED,
] as const

/** The lender's support-access audit trail, newest first. */
export function listSupportAudit(tenantId: string, take = 200) {
  return prisma.auditLog.findMany({
    where: { tenantId, action: { in: [...SUPPORT_AUDIT_ACTIONS] } },
    select: { id: true, action: true, userEmail: true, entityId: true, newValue: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take,
  })
}
