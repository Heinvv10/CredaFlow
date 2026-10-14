import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { refuseLockedStaffUserWrite, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { applyScreeningConfig, parseScreeningConfig } from "@/lib/screening/config-write"

/**
 * PUT /api/settings/screening — the lender's screening provider (null = off)
 * and the minimum role that decides matches. SUPER_ADMIN in a session whose
 * sign-in verified TOTP, as for the KYC override policy: switching screening
 * off removes the approval gate. The change and its audit row commit together.
 */
export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("SUPER_ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user
  if (actor.totpVerified !== true) {
    return NextResponse.json(
      { error: "Sign in with two-factor authentication to change screening settings." },
      { status: 403 },
    )
  }

  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { provider?: unknown; reviewMinRole?: unknown } | null
    if (!body || !Object.hasOwn(body, "provider") || !Object.hasOwn(body, "reviewMinRole")) {
      return NextResponse.json({ error: "Send provider (or null) and reviewMinRole." }, { status: 400 })
    }
    const parsed = parseScreeningConfig({ provider: body.provider, reviewMinRole: body.reviewMinRole })
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const result = await prisma.$transaction(async (tx) => {
      const locked = await refuseLockedStaffUserWrite(tx, actor, { tenantId: tenant.id, assignedRole: undefined })
      if (locked.refused) return { refused: locked.refused }
      if (locked.callerRole !== "SUPER_ADMIN") return { refused: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
      return {
        applied: await applyScreeningConfig(tx, {
          tenantId: tenant.id,
          actor: { id: actor.id, email: actor.email },
          value: parsed.value,
          ipAddress: callerIp(req),
        }),
      }
    })
    if ("refused" in result && result.refused) return result.refused
    return NextResponse.json({ ok: true, ...parsed.value, changed: result.applied?.changed ?? false })
  })
}
