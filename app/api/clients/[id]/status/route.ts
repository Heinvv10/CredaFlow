import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"

/**
 * Set the ASSERTED half of a client's status.
 *
 * Only two of the four contractual statuses are stored: DECEASED and
 * BLACKLISTED are decisions somebody makes, so somebody has to record them.
 * ACTIVE and PAID_UP are derived from the client's loans (lib/clients/status.ts)
 * and are deliberately not settable — writing them would create a second,
 * staler answer to a question the loans already answer.
 *
 * Senior to CREDIT_OFFICER on purpose. A credit officer can create a client and
 * open an application; deciding that a person may no longer borrow at all, or
 * recording their death, sits a step above that.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return await withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const body = await req.json().catch(() => ({}))

    const setsDeceased = typeof body.deceased === "boolean"
    const setsBlacklist = typeof body.blacklisted === "boolean"
    if (!setsDeceased && !setsBlacklist) {
      return NextResponse.json(
        { error: "Specify deceased or blacklisted" },
        { status: 422 },
      )
    }

    // The reason is the audit trail's only account of WHY someone's access to
    // credit changed, including when the change is a reversal.
    const reason = typeof body.reason === "string" ? body.reason.trim() : ""
    if (!reason) {
      return NextResponse.json(
        { error: "A reason is required" },
        { status: 422 },
      )
    }

    const client = await prisma.client.findFirst({
      where: { id, tenantId: tenant.id },
      select: { id: true, firstName: true, lastName: true, blacklisted: true, deceasedAt: true },
    })
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 })
    }

    const data: Record<string, unknown> = {}
    if (setsDeceased) {
      data.deceasedAt = body.deceased ? new Date() : null
      data.deceasedReason = body.deceased ? reason : null
    }
    if (setsBlacklist) {
      data.blacklisted = body.blacklisted
      data.blacklistReason = body.blacklisted ? reason : null
    }

    // The write happens BEFORE the audit call, and the audit is awaited. An
    // audit row describing a status change that never landed is worse than no
    // row: it is a false statement in the record auditors read. So a failed
    // update returns here and never reaches logAudit.
    let updated
    try {
      updated = await prisma.client.update({ where: { id: client.id }, data })
    } catch (error) {
      console.error("Failed to update client status:", error)
      return NextResponse.json({ error: "Failed to update client status" }, { status: 500 })
    }

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: setsDeceased ? AuditAction.CLIENT_DECEASED_RECORDED : AuditAction.CLIENT_BLACKLISTED,
      entity: "Client",
      entityId: client.id,
      oldValue: { blacklisted: client.blacklisted, deceasedAt: client.deceasedAt },
      newValue: { ...data, reason },
    })

    return NextResponse.json({
      id: updated.id,
      blacklisted: updated.blacklisted,
      deceasedAt: updated.deceasedAt,
    })
  })
}
