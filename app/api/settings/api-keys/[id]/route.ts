import { NextRequest, NextResponse } from "next/server"
import { withTenantContext } from "@/lib/tenant"
import { recordedCallerIp } from "@/lib/rate-limit"
import { requireApiSettingsAdmin } from "@/lib/lender-api/settings-guard"
import { revokeApiKey } from "@/lib/lender-api/key-admin"

type Params = { params: Promise<{ id: string }> }

// Revoke an API key. Effective on the key's next request.
export async function DELETE(req: NextRequest, { params }: Params) {
  const guard = await requireApiSettingsAdmin()
  if (guard.error) return guard.error
  const user = guard.user
  const { id } = await params

  return withTenantContext(req, async (tenant) => {
    const result = await revokeApiKey({
      tenantId: tenant.id,
      actor: { id: user.id, email: user.email, ipAddress: recordedCallerIp(req) ?? undefined },
      keyId: id,
    })
    if (result === "not_found") return NextResponse.json({ error: "API key not found" }, { status: 404 })
    return NextResponse.json({ ok: true, alreadyRevoked: result === "already_revoked" })
  })
}
