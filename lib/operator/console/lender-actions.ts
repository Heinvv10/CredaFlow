/**
 * OPERATOR_ADMIN actions on a lender the operator runs: suspend and
 * reactivate (the admin reset link is lender-admin-reset.ts). Each is audited
 * under the lender's tenantId, so the lender's own audit log shows what its
 * platform operator did.
 *
 * Suspension stops the lender's staff signing in and ends their open sessions
 * on the next request (lib/auth.ts); host resolution already refuses a
 * non-ACTIVE tenant (lib/tenant.ts).
 */
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { OperatorPrincipal } from "../console-auth"

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
