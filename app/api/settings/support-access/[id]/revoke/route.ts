import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { revokeSupportAccess } from "@/lib/operator/support-grants"
import { supportGrantRefusalResponse } from "@/lib/operator/support-grant-http"

// POST: revoke one of this lender's support grants, once (ADMIN / SUPER_ADMIN,
// TOTP-verified, audited in lib/operator/support-grants.ts).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const { id } = await params
  return withTenantContext(req, async (tenant) => {
    try {
      const grant = await revokeSupportAccess({ tenantId: tenant.id, actor: guard.user, grantId: id, ipAddress: callerIp(req) })
      return NextResponse.json({ id: grant.id, revokedAt: grant.revokedAt })
    } catch (err) {
      const refused = supportGrantRefusalResponse(err)
      if (refused) return refused
      throw err
    }
  })
}
