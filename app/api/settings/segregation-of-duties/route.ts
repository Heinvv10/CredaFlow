import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { Prisma } from "@prisma/client"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { demoStaffWithoutTotp } from "@/lib/config/demo-mode"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"
import { applySegregationOfDuties } from "@/lib/security/segregation-of-duties"

// The lender's segregation-of-duties setting
// (TenantConfig.requireSegregationOfDuties). Only an ADMIN or SUPER_ADMIN of
// the tenant changes it, re-checked on the locked caller row. Turning it off
// always needs a TOTP-verified session; turning it on, where the lender
// requires staff 2FA. The change and its audit row commit together
// (applySegregationOfDuties).
export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user

  return withTenantContext(req, async (tenant) => {
    if (actor.tenantId !== tenant.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const body = await req.json().catch(() => null) as { requireSegregationOfDuties?: unknown } | null
    if (typeof body?.requireSegregationOfDuties !== "boolean") {
      return NextResponse.json({ error: "requireSegregationOfDuties must be true or false." }, { status: 400 })
    }
    const required = body.requireSegregationOfDuties
    // Turning the control OFF always needs a session that verified TOTP,
    // whatever the lender's own 2FA policy; turning it on, as any other
    // setting. The TOTP-free demo stack (demoStaffWithoutTotp) is the exception.
    const totpNeeded = !demoStaffWithoutTotp() && (!required || await isStaffTotpRequired(tenant.id))
    if (actor.totpVerified !== true && totpNeeded) {
      return NextResponse.json(
        {
          error: required
            ? "Sign in with two-factor authentication to change segregation of duties."
            : "Turning segregation of duties off needs a session signed in with two-factor authentication.",
        },
        { status: 403 },
      )
    }

    const result = await prisma.$transaction(async (tx) => {
      // The session is stale by the time of the write: re-read the caller's
      // row, share-locked until the change commits, and its role as it is now.
      const [caller] = await tx.$queryRaw<Array<{ role: string; active: boolean; tokenVersion: number }>>(Prisma.sql`
        SELECT "role"::TEXT AS "role", "active", "tokenVersion" FROM "User"
        WHERE "id" = ${actor.id} AND "tenantId" = ${tenant.id}
        FOR SHARE
      `)
      if (
        !caller?.active
        || caller.tokenVersion !== actor.tokenVersion
        || (caller.role !== "ADMIN" && caller.role !== "SUPER_ADMIN")
      ) {
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
    })
    if (result.refused) return result.refused
    return NextResponse.json({ ok: true, changed: result.applied.changed, requireSegregationOfDuties: result.applied.required })
  })
}
