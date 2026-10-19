import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { demoStaffWithoutTotp } from "@/lib/config/demo-mode"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"
import { applyAutomatedWhatsApp, isAutomatedWhatsAppEnabled } from "@/lib/automation/whatsapp-switch"

// The lender's opt-in for automated WhatsApp reminders
// (TenantConfig.automatedWhatsAppReminders, default off). Read by any staff
// member who can see the automation rules; changed only by an ADMIN or
// SUPER_ADMIN, re-checked on the locked caller row, audited in the same
// transaction (applyAutomatedWhatsApp).
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) =>
    NextResponse.json({ enabled: await isAutomatedWhatsAppEnabled(tenant.id) }))
}

export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user

  return withTenantContext(req, async (tenant) => {
    if (actor.tenantId !== tenant.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const body = await req.json().catch(() => null) as { enabled?: unknown } | null
    if (typeof body?.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be true or false." }, { status: 400 })
    }
    const enabled = body.enabled
    // Where the lender requires staff 2FA the change needs a session that verified TOTP.
    if (actor.totpVerified !== true && !demoStaffWithoutTotp() && await isStaffTotpRequired(tenant.id)) {
      return NextResponse.json({ error: "Sign in with two-factor authentication to change automated WhatsApp reminders." }, { status: 403 })
    }

    const result = await prisma.$transaction(async (tx) => {
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
        applied: await applyAutomatedWhatsApp(tx, {
          tenantId: tenant.id,
          actor: { id: actor.id, email: actor.email },
          enabled,
          ipAddress: callerIp(req),
        }),
      }
    })
    if (result.refused) return result.refused
    return NextResponse.json({ ok: true, changed: result.applied.changed, enabled: result.applied.enabled })
  })
}
