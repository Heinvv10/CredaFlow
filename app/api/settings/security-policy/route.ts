import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { refuseLockedStaffUserWrite, requireApiRole, staffUserWriteConflict } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { applyStaffTotpRequired } from "@/lib/security/staff-totp-policy"

// The lender's staff two-factor policy (TenantConfig.requireStaffTotp). Only a
// SUPER_ADMIN of the tenant changes it, in a session whose sign-in verified a
// TOTP code, switching on or off alike. The change and its audit row commit
// together (applyStaffTotpRequired).
export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("SUPER_ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user

  if (actor.totpVerified !== true) {
    return NextResponse.json(
      { error: "Sign in with two-factor authentication to change the security policy. Enable it under Settings → Security, then sign out and back in." },
      { status: 403 },
    )
  }

  return withTenantContext(req, async (tenant) => {
    const body: unknown = await req.json().catch(() => null)
    const required = (body as { requireStaffTotp?: unknown } | null)?.requireStaffTotp
    if (typeof required !== "boolean") {
      return NextResponse.json({ error: "requireStaffTotp must be true or false." }, { status: 400 })
    }

    const result = await prisma.$transaction(async (tx) => {
      // The session is stale by the time of the write: re-check the caller's
      // row, locked, and its role as it is now.
      const locked = await refuseLockedStaffUserWrite(tx, actor, { tenantId: tenant.id, assignedRole: undefined })
      if (locked.refused) return { refused: locked.refused }
      if (locked.callerRole !== "SUPER_ADMIN") return { refused: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
      return { applied: await applyStaffTotpRequired(tx, { tenantId: tenant.id, actor: { id: actor.id, email: actor.email }, required, ipAddress: callerIp(req) }) }
    }).catch((err: unknown) => {
      const conflict = staffUserWriteConflict(err)
      if (conflict) return { refused: conflict }
      throw err
    })
    if (result.refused) return result.refused

    const { changed, required: now, signedOut } = result.applied
    return NextResponse.json({ ok: true, changed, requireStaffTotp: now, signedOutUsers: signedOut })
  })
}
