import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { refuseLockedStaffUserWrite, requireApiRole, staffUserWriteConflict } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { demoStaffWithoutTotp } from "@/lib/config/demo-mode"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"
import { applySegregationOfDuties } from "@/lib/security/segregation-of-duties"

// The lender's segregation-of-duties setting
// (TenantConfig.requireSegregationOfDuties). Only an ADMIN or SUPER_ADMIN of
// the tenant changes it, re-checked on the locked caller row; where the lender
// requires staff 2FA, from a session that verified TOTP. The change and its
// audit row commit together (applySegregationOfDuties).
export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user

  return withTenantContext(req, async (tenant) => {
    if (actor.tenantId !== tenant.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    if (actor.totpVerified !== true && !demoStaffWithoutTotp() && await isStaffTotpRequired(tenant.id)) {
      return NextResponse.json(
        { error: "Sign in with two-factor authentication to change segregation of duties." },
        { status: 403 },
      )
    }
    const body = await req.json().catch(() => null) as { requireSegregationOfDuties?: unknown } | null
    if (typeof body?.requireSegregationOfDuties !== "boolean") {
      return NextResponse.json({ error: "requireSegregationOfDuties must be true or false." }, { status: 400 })
    }
    const required = body.requireSegregationOfDuties

    const result = await prisma.$transaction(async (tx) => {
      const locked = await refuseLockedStaffUserWrite(tx, actor, { tenantId: tenant.id, assignedRole: undefined })
      if (locked.refused) return { refused: locked.refused }
      if (locked.callerRole !== "ADMIN" && locked.callerRole !== "SUPER_ADMIN") {
        return { refused: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
      }
      return {
        applied: await applySegregationOfDuties(tx, {
          tenantId: tenant.id,
          actor: { id: actor.id, email: actor.email },
          required,
          ipAddress: callerIp(req),
        }),
      }
    }).catch((err: unknown) => {
      const conflict = staffUserWriteConflict(err)
      if (conflict) return { refused: conflict }
      throw err
    })
    if (result.refused) return result.refused
    return NextResponse.json({ ok: true, changed: result.applied.changed, requireSegregationOfDuties: result.applied.required })
  })
}
