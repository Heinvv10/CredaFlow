import { NextRequest, NextResponse } from "next/server"
import { withTenantContext } from "@/lib/tenant"
import { recordedCallerIp } from "@/lib/rate-limit"
import { requireSsoAdmin } from "@/lib/sso/admin-guard"
import { revokeOauthClient } from "@/lib/lender-api/oauth/clients"

type Params = { params: Promise<{ id: string }> }

// Revoke an OAuth client. Its live access tokens stop on their next request.
export async function DELETE(req: NextRequest, { params }: Params) {
  const guard = await requireSsoAdmin("manage_oauth_clients")
  if (guard.error) return guard.error
  const user = guard.user
  const { id } = await params

  return withTenantContext(req, async (tenant) => {
    const result = await revokeOauthClient({
      tenantId: tenant.id,
      actor: { id: user.id, email: user.email, ipAddress: recordedCallerIp(req) ?? undefined },
      id,
    })
    if (result === "not_found") return NextResponse.json({ error: "OAuth client not found" }, { status: 404 })
    return NextResponse.json({ ok: true, alreadyRevoked: result === "already_revoked" })
  })
}
