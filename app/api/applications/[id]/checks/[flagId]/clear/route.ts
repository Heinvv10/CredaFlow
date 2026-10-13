import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { CLEAR_REASON_MIN_LENGTH } from "@/lib/credit-checks/policy"
import { RECOMPUTE_STATUSES } from "@/lib/credit-checks/recompute"

/**
 * POST /api/applications/[id]/checks/[flagId]/clear — a LOAN_ADMIN, signed in
 * with two-factor authentication, clears one OPEN flag with a written reason.
 * The clearance and its audit row commit together; the database CHECK
 * (ApplicationCheckFlag_clearance_complete) holds the same reason floor.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; flagId: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  if (guard.user.totpVerified !== true) {
    return NextResponse.json(
      { error: "Sign in with two-factor authentication to clear a credit check." },
      { status: 403 },
    )
  }

  return withTenantContext(req, async (tenant) => {
    const { id, flagId } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown }
    const reason = typeof body.reason === "string" ? body.reason.trim() : ""
    if (reason.length < CLEAR_REASON_MIN_LENGTH) {
      return NextResponse.json(
        { error: `Give a reason of at least ${CLEAR_REASON_MIN_LENGTH} characters.`, reason: "too_short" },
        { status: 400 },
      )
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const flag = await tx.applicationCheckFlag.findFirst({
        where: { id: flagId, tenantId: tenant.id, applicationId: id },
        include: { application: { select: { status: true } } },
      })
      if (!flag) return { status: 404 as const, error: "Check not found" }
      if (!RECOMPUTE_STATUSES.includes(flag.application.status)) {
        return { status: 409 as const, error: "The application has been decided; its checks can no longer change." }
      }
      const clearedAt = new Date()
      const cleared = await tx.applicationCheckFlag.updateMany({
        where: { id: flag.id, tenantId: tenant.id, status: "OPEN" },
        data: { status: "CLEARED", clearedById: guard.user.id, clearedAt, clearReason: reason },
      })
      if (cleared.count === 0) return { status: 409 as const, error: "This check is not open." }
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.CREDIT_CHECK_FLAG_CLEARED,
        entity: "ApplicationCheckFlag",
        entityId: flag.id,
        oldValue: { status: "OPEN" },
        newValue: { status: "CLEARED", applicationId: id, check: flag.check, code: flag.code, reason, clearedAt: clearedAt.toISOString() },
      }, tx)
      return { status: 200 as const }
    })

    if (outcome.status !== 200) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
    return NextResponse.json({ ok: true })
  })
}
