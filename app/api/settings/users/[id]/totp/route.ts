import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { refuseLockedStaffUserWrite, refuseStaffUserWrite, requireApiRole, staffUserWriteConflict } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"

interface RouteParams { params: Promise<{ id: string }> }

// An admin clears ANOTHER user's two-factor enrolment (a lost phone). ADMIN or
// above, outranking the target (the staff-user write gate), in a TOTP-verified
// session. The target is signed out and, while the lender requires 2FA, must
// enrol again at their next sign-in. Your own is turned off with your current
// code at DELETE /api/settings/totp, so it is refused here.
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    if (id === actor.id) {
      return NextResponse.json({ error: "Turn off your own two-factor authentication under Settings → Security" }, { status: 400 })
    }

    const target = await prisma.user.findFirst({
      where: { id, tenantId: tenant.id },
      select: { role: true, totpEnabled: true, isSystem: true },
    })
    if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 })

    const refused = await refuseStaffUserWrite(actor, { tenantId: tenant.id, targetId: id, targetRole: target.role, assignedRole: undefined, targetIsSystem: target.isSystem })
    if (refused) return refused

    const result = await prisma.$transaction(async (tx) => {
      // Re-checked on the rows as they are now, locked until this commits.
      const locked = await refuseLockedStaffUserWrite(tx, actor, { tenantId: tenant.id, targetId: id, assignedRole: undefined })
      if (locked.refused) return locked.refused

      await tx.user.update({
        where: { id },
        data: { totpSecret: null, totpEnabled: false, lastTotpCounter: null, tokenVersion: { increment: 1 } },
        select: { id: true },
      })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: actor.id,
        userEmail: actor.email,
        action: AuditAction.TOTP_RESET_BY_ADMIN,
        entity: "User",
        entityId: id,
        oldValue: { totpEnabled: target.totpEnabled },
        newValue: { totpEnabled: false },
        ipAddress: callerIp(req),
      }, tx)
      return null
    }).catch((err: unknown) => {
      const conflict = staffUserWriteConflict(err)
      if (conflict) return conflict
      throw err
    })
    if (result) return result

    return NextResponse.json({ ok: true })
  })
}
