import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { refuseLockedStaffUserWrite, requireApiRole, staffUserWriteConflict } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import {
  RETENTION_MONTHS_MAX, RETENTION_MONTHS_MIN, applyDecisionRecordRetention, isRetentionMonths,
} from "@/lib/learning-loop/retention/policy"

// The lender's credit decision log retention period
// (TenantConfig.decisionRecordRetentionMonths; null = off). Only a SUPER_ADMIN
// of the tenant changes it, in a session whose sign-in verified a TOTP code,
// as for the staff 2FA policy. The change and its audit row commit together.
export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("SUPER_ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user

  if (actor.totpVerified !== true) {
    return NextResponse.json(
      { error: "Sign in with two-factor authentication to change the decision record retention period. Enable it under Settings → Security, then sign out and back in." },
      { status: 403 },
    )
  }

  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { months?: unknown } | null
    if (body === null || typeof body !== "object" || !Object.hasOwn(body, "months") || (body.months !== null && !isRetentionMonths(body.months))) {
      return NextResponse.json(
        { error: `months must be a whole number from ${RETENTION_MONTHS_MIN} to ${RETENTION_MONTHS_MAX}, or null to switch retention off.` },
        { status: 400 },
      )
    }
    const months = body.months as number | null

    const result = await prisma.$transaction(async (tx) => {
      // The session is stale by the time of the write: re-check the caller's row, locked, and its role as it is now.
      const locked = await refuseLockedStaffUserWrite(tx, actor, { tenantId: tenant.id, assignedRole: undefined })
      if (locked.refused) return { refused: locked.refused }
      if (locked.callerRole !== "SUPER_ADMIN") return { refused: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
      return {
        applied: await applyDecisionRecordRetention(tx, {
          tenantId: tenant.id, actor: { id: actor.id, email: actor.email }, months, ipAddress: callerIp(req),
        }),
      }
    }).catch((err: unknown) => {
      const conflict = staffUserWriteConflict(err)
      if (conflict) return { refused: conflict }
      throw err
    })
    if (result.refused) return result.refused
    return NextResponse.json({ ok: true, changed: result.applied.changed, decisionRecordRetentionMonths: result.applied.months })
  })
}
