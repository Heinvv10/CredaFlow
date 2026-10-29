import { NextRequest, NextResponse } from "next/server"
import { withTenantContext } from "@/lib/tenant"
import { recordedCallerIp } from "@/lib/rate-limit"
import { requireApiSettingsAdmin } from "@/lib/lender-api/settings-guard"
import { parseScopes } from "@/lib/lender-api/scopes"
import { isApiKeyLifetime } from "@/lib/lender-api/keys"
import { createApiKey } from "@/lib/lender-api/key-admin"
import { parseCredentialAllowlist } from "@/lib/lender-api/ip-restriction"

// Create an API key. The full key is in this response and nowhere else.
export async function POST(req: NextRequest) {
  const guard = await requireApiSettingsAdmin()
  if (guard.error) return guard.error
  const user = guard.user

  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { name?: unknown; scopes?: unknown; lifetimeDays?: unknown; ipAllowlist?: unknown } | null
    const name = typeof body?.name === "string" ? body.name.trim() : ""
    if (!name || name.length > 80) return NextResponse.json({ error: "Name the key (at most 80 characters)." }, { status: 400 })
    const scopes = parseScopes(body?.scopes)
    if (!scopes) return NextResponse.json({ error: "Choose at least one valid scope." }, { status: 400 })
    if (!isApiKeyLifetime(body?.lifetimeDays)) return NextResponse.json({ error: "Choose a lifetime of 30, 90, 180 or 365 days." }, { status: 400 })

    const allowlist = parseCredentialAllowlist(body?.ipAllowlist)
    if (!allowlist.ok) return NextResponse.json({ error: allowlist.error }, { status: 400 })

    const outcome = await createApiKey({
      tenantId: tenant.id,
      actor: { id: user.id, email: user.email, ipAddress: recordedCallerIp(req) ?? undefined },
      name,
      scopes,
      lifetimeDays: body.lifetimeDays,
      ipAllowlist: allowlist.entries,
    })
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
    return NextResponse.json(
      { key: outcome.key, apiKey: { ...outcome.apiKey, expiresAt: outcome.apiKey.expiresAt.toISOString() } },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    )
  })
}
