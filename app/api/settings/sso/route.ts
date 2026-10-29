import { NextRequest, NextResponse } from "next/server"
import { withTenantContext } from "@/lib/tenant"
import { recordedCallerIp } from "@/lib/rate-limit"
import { requireSsoAdmin } from "@/lib/sso/admin-guard"
import { connectionView, getConnection, saveConnection } from "@/lib/sso/connection"

// The lender's SSO connection. Read and written by a Super Admin in a TOTP-verified
// session; the secret and the certificate body never come back (connectionView).
export async function GET(req: NextRequest) {
  const guard = await requireSsoAdmin("manage_sso")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) =>
    NextResponse.json({ connection: connectionView(await getConnection(tenant.id)) }, { headers: { "Cache-Control": "no-store" } }))
}

export async function PUT(req: NextRequest) {
  const guard = await requireSsoAdmin("manage_sso")
  if (guard.error) return guard.error
  const user = guard.user
  return withTenantContext(req, async (tenant) => {
    const body: unknown = await req.json().catch(() => null)
    const outcome = await saveConnection({
      tenantId: tenant.id,
      actor: { id: user.id, email: user.email, ipAddress: recordedCallerIp(req) ?? undefined },
      body,
    })
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
    return NextResponse.json({ connection: outcome.connection }, { headers: { "Cache-Control": "no-store" } })
  })
}
