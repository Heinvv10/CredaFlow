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
import { isReadMethod } from "@/lib/proxy/operator-read-only"
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
  | "write_refused"
  | "role_insufficient"
  | "wrong_operator"
  | "no_active_grant"
  | "tenant_inactive"

export type OperatorTenantAccess =
  | {
      allowed: true
      grantId: string
      /** When the grant this use rides on ends (the console's read-only banner). */
      grantExpiresAt: Date
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

// Requests whose use is already on the audit log. requireApiRole and
// withTenantContext both check one request; the first allowed check records
// it. Bounded: a request completes long before 1 000 later ones evict it.
const USES_RECORDED = new Set<string>()
function rememberUse(requestId: string): void {
  USES_RECORDED.add(requestId)
  if (USES_RECORDED.size > 1_000) USES_RECORDED.delete(USES_RECORDED.values().next().value as string)
}

export async function resolveOperatorTenantAccess(input: {
  session: OperatorSession
  tenantId: string
  /** The minimum staff role the route requires; support access is READONLY. */
  requiredRole?: UserRole
  /** What was asked for (route path or guard), recorded on the audit row. */
  resource?: string
  /** The HTTP method. Anything but GET/HEAD — or no method at all — is refused. */
  method: string | null
  /** One id per request (proxy.ts): the use is recorded once however often it is checked. */
  requestId?: string | null
  ipAddress?: string
  now?: Date
}): Promise<OperatorTenantAccess> {
  const { session, tenantId, resource, ipAddress, requestId } = input
  const now = input.now ?? new Date()

  // The session's claims are not trusted for authority: the row is read.
  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: { id: true, email: true, name: true, active: true, role: true, operatorId: true },
  })
  const audit = { tenantId, userId: session.id, userEmail: user?.email ?? session.email, entity: "TenantSupportGrant", ipAddress }

  const refuse = async (reason: OperatorAccessRefusal): Promise<OperatorTenantAccess> => {
    await logAudit({
      ...audit, action: AuditAction.SUPPORT_ACCESS_REFUSED,
      newValue: { reason, resource: resource ?? null, method: input.method },
    })
    return { allowed: false, reason }
  }

  if (!user || !user.active || !isOperatorRole(user.role) || !user.operatorId) return refuse("not_operator")
  if (session.totpVerified !== true) return refuse("totp_required")
  // Read-only whatever the route's role floor: some routes that write admit
  // READONLY by product decision (POST /api/clients/[id]/messages).
  if (!isReadMethod(input.method)) return refuse("write_refused")
  if (input.requiredRole && !hasMinRole(SUPPORT_ACCESS_ROLE, input.requiredRole)) return refuse("role_insufficient")

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { operatorId: true, status: true } })
  if (!tenant || tenant.operatorId !== user.operatorId) return refuse("wrong_operator")
  // A suspended (or not yet active) lender is closed to its own staff, so to
  // support access too; the console still shows its status and counts.
  if (tenant.status !== "ACTIVE") return refuse("tenant_inactive")

  const grant = await findActiveSupportGrant(tenantId, user.id, now)
  if (!grant) return refuse("no_active_grant")

  if (!requestId || !USES_RECORDED.has(requestId)) {
    await logAuditStrict({
      ...audit,
      action: AuditAction.SUPPORT_ACCESS_USED,
      entityId: grant.id,
      newValue: { resource: resource ?? null, grantId: grant.id, grantExpiresAt: grant.expiresAt.toISOString() },
    })
    if (requestId) rememberUse(requestId)
  }
  return {
    allowed: true,
    grantId: grant.id,
    grantExpiresAt: grant.expiresAt,
    principal: {
      id: user.id, email: user.email, name: user.name,
      role: SUPPORT_ACCESS_ROLE, tenantId, totpVerified: true,
    },
  }
}
