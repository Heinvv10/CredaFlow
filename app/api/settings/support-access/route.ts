import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { grantSupportAccess, MAX_SUPPORT_GRANT_MS } from "@/lib/operator/support-grants"
import { supportGrantRefusalResponse } from "@/lib/operator/support-grant-http"

const HOUR_MS = 3_600_000

// POST { operatorUserId, durationHours, reason }: the lender's ADMIN or
// SUPER_ADMIN grants one operator user read-only support access for at most
// 7 days. The rules (TOTP-verified session, window, operator user of this
// lender's operator) and their audit rows are lib/operator/support-grants.ts.
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { operatorUserId?: unknown; durationHours?: unknown; reason?: unknown } | null
    const hours = Number(body?.durationHours)
    if (typeof body?.operatorUserId !== "string" || !Number.isInteger(hours) || hours < 1 || hours * HOUR_MS > MAX_SUPPORT_GRANT_MS) {
      return NextResponse.json({ error: "operatorUserId and a whole number of hours from 1 to 168 are required" }, { status: 400 })
    }
    try {
      const grant = await grantSupportAccess({
        tenantId: tenant.id, actor: guard.user, operatorUserId: body.operatorUserId,
        expiresAt: new Date(Date.now() + hours * HOUR_MS),
        reason: typeof body.reason === "string" ? body.reason : "",
        ipAddress: callerIp(req),
      })
      return NextResponse.json({ id: grant.id, expiresAt: grant.expiresAt }, { status: 201 })
    } catch (err) {
      const refused = supportGrantRefusalResponse(err)
      if (refused) return refused
      throw err
    }
  })
}
