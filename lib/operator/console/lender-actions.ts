/**
 * OPERATOR_ADMIN actions on a lender the operator runs: suspend, reactivate,
 * and send one of its admins a password reset link. Each is audited under the
 * lender's tenantId, so the lender's own audit log shows what its platform
 * operator did.
 *
 * Suspension stops the lender's staff signing in and ends their open sessions
 * on the next request (lib/auth.ts); host resolution already refuses a
 * non-ACTIVE tenant (lib/tenant.ts).
 */
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { OperatorPrincipal } from "../console-auth"
import { issueAccountToken, lenderPasswordUrl, RESET_LINK_HOURS, sendAccountLink } from "./account-links"

export type LenderActionResult<T = object> = ({ ok: true } & T) | { ok: false; status: 400 | 404 | 409; error: string }

const MAX_REASON = 500

export async function setLenderStatus(input: {
  principal: OperatorPrincipal
  tenantId: string
  status: unknown
  reason: unknown
  ipAddress?: string
}): Promise<LenderActionResult<{ status: "ACTIVE" | "SUSPENDED" }>> {
  const { principal, tenantId, ipAddress } = input
  if (input.status !== "SUSPENDED" && input.status !== "ACTIVE") {
    return { ok: false, status: 400, error: "status must be SUSPENDED or ACTIVE" }
  }
  const next = input.status
  const reason = typeof input.reason === "string" ? input.reason.trim() : ""
  if (!reason || reason.length > MAX_REASON) return { ok: false, status: 400, error: "A reason (up to 500 characters) is required" }

  return prisma.$transaction(async (tx) => {
    const from = next === "SUSPENDED" ? "ACTIVE" : "SUSPENDED"
    const { count } = await tx.tenant.updateMany({
      where: { id: tenantId, operatorId: principal.operatorId, status: from },
      data: { status: next },
    })
    if (count !== 1) {
      const exists = await tx.tenant.findFirst({ where: { id: tenantId, operatorId: principal.operatorId }, select: { status: true } })
      return exists
        ? { ok: false as const, status: 409 as const, error: `The lender is ${exists.status}, not ${from}` }
        : { ok: false as const, status: 404 as const, error: "Lender not found" }
    }
    await logAuditStrict({
      tenantId, userId: principal.id, userEmail: principal.email,
      action: next === "SUSPENDED" ? AuditAction.TENANT_SUSPENDED : AuditAction.TENANT_REACTIVATED,
      entity: "Tenant", entityId: tenantId,
      oldValue: { status: from }, newValue: { status: next, reason }, ipAddress,
    }, tx)
    return { ok: true as const, status: next }
  })
}

/** A reset link to one of the lender's ADMIN / SUPER_ADMIN users. */
export async function sendLenderAdminReset(input: {
  principal: OperatorPrincipal
  tenantId: string
  userId: unknown
  ipAddress?: string
}): Promise<LenderActionResult<{ emailSent: boolean }>> {
  const { principal, tenantId, ipAddress } = input
  if (typeof input.userId !== "string" || !input.userId) return { ok: false, status: 400, error: "userId is required" }
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, operatorId: principal.operatorId },
    select: { id: true, name: true, domain: true, config: { select: { brandName: true } } },
  })
  if (!tenant) return { ok: false, status: 404, error: "Lender not found" }
  const target = await prisma.user.findFirst({
    where: { id: input.userId, tenantId, role: { in: ["ADMIN", "SUPER_ADMIN"] }, active: true },
    select: { id: true, email: true, name: true, role: true },
  })
  if (!target) return { ok: false, status: 404, error: "No active admin of this lender with that id" }

  // The link and its audit row exist together, before anything is sent.
  const token = await prisma.$transaction(async (tx) => {
    const issued = await issueAccountToken(tx, target.id, RESET_LINK_HOURS)
    await logAuditStrict({
      tenantId, userId: principal.id, userEmail: principal.email,
      action: AuditAction.LENDER_ADMIN_RESET_LINK_SENT, entity: "User", entityId: target.id,
      newValue: { targetEmail: target.email, targetRole: target.role, expiresInHours: RESET_LINK_HOURS }, ipAddress,
    }, tx)
    return issued
  })
  const emailSent = await sendAccountLink({
    to: target.email, name: target.name, kind: "reset",
    organisation: tenant.config?.brandName ?? tenant.name,
    url: () => lenderPasswordUrl(tenant, token), hours: RESET_LINK_HOURS,
  })
  return { ok: true, emailSent }
}
