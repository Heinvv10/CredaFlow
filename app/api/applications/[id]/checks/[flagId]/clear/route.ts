import { NextRequest, NextResponse } from "next/server"
import type { AppStatus } from "@prisma/client"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { demoStaffWithoutTotp } from "@/lib/config/demo-mode"
import { CLEAR_REASON_MAX_LENGTH, CLEAR_REASON_MIN_LENGTH } from "@/lib/credit-checks/policy"
import { RECOMPUTE_STATUSES } from "@/lib/credit-checks/recompute"
import { recordDecisions } from "@/lib/learning-loop/decision-log"
import { CREDIT_CHECK_POLICY_VERSION, creditCheckClearRecord } from "@/lib/learning-loop/records"

/**
 * POST /api/applications/[id]/checks/[flagId]/clear — a LOAN_ADMIN, signed in
 * with two-factor authentication, clears one OPEN flag with a written reason.
 * The one exception is a TOTP-free demo stack (demoStaffWithoutTotp), where a
 * password-only session may clear; its audit row says the 2FA was waived.
 * The clearance and its audit row commit together; the database CHECK
 * (ApplicationCheckFlag_clearance_complete) holds the same reason floor.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; flagId: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const totpWaived = guard.user.totpVerified !== true && demoStaffWithoutTotp()
  if (guard.user.totpVerified !== true && !totpWaived) {
    return NextResponse.json(
      { error: "Sign in with two-factor authentication to clear a credit check." },
      { status: 403 },
    )
  }

  return withTenantContext(req, async (tenant) => {
    const { id, flagId } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown }
    const reason = typeof body.reason === "string" ? body.reason.trim() : ""
    // A NUL is refused by Postgres text; control characters have no place in a reason.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
      return NextResponse.json({ error: "The reason contains control characters.", reason: "invalid" }, { status: 400 })
    }
    // Code points, as the database's char_length counts them: an emoji is one, not two.
    const length = [...reason].length
    if (length < CLEAR_REASON_MIN_LENGTH) {
      return NextResponse.json(
        { error: `Give a reason of at least ${CLEAR_REASON_MIN_LENGTH} characters.`, reason: "too_short" },
        { status: 400 },
      )
    }
    if (length > CLEAR_REASON_MAX_LENGTH) {
      return NextResponse.json(
        { error: `Keep the reason under ${CLEAR_REASON_MAX_LENGTH} characters.`, reason: "too_long" },
        { status: 400 },
      )
    }

    const outcome = await prisma.$transaction(async (tx) => {
      // The application row lock a recompute and the approval also take: a
      // clearance cannot interleave with either, nor land after a decision.
      const locked = await tx.$queryRaw<Array<{ status: AppStatus; clientId: string | null }>>`
        SELECT status, "clientId" FROM "LoanApplication" WHERE id = ${id} AND "tenantId" = ${tenant.id} FOR NO KEY UPDATE`
      const flag = await tx.applicationCheckFlag.findFirst({
        where: { id: flagId, tenantId: tenant.id, applicationId: id },
        select: { id: true, check: true, code: true },
      })
      if (!flag || !locked[0]) return { status: 404 as const, error: "Check not found" }
      if (!RECOMPUTE_STATUSES.includes(locked[0].status)) {
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
        newValue: {
          status: "CLEARED", applicationId: id, check: flag.check, code: flag.code, reason, clearedAt: clearedAt.toISOString(),
          ...(totpWaived ? { twoFactor: "waived: demo stack without TOTP" } : {}),
        },
      }, tx)
      await recordDecisions(tx, [creditCheckClearRecord({
        tenantId: tenant.id,
        applicationId: id,
        clientId: locked[0].clientId,
        actor: { userId: guard.user.id, role: guard.user.role },
        decidedAt: clearedAt,
        flagId: flag.id,
        check: flag.check,
        code: flag.code,
        reason,
        policyVersion: CREDIT_CHECK_POLICY_VERSION,
      })])
      return { status: 200 as const }
    })

    if (outcome.status !== 200) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
    return NextResponse.json({ ok: true })
  })
}
