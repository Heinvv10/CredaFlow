import { NextRequest, NextResponse } from "next/server"
import { withTenantContext } from "@/lib/tenant"
import { recordedCallerIp } from "@/lib/rate-limit"
import { requireSsoAdmin } from "@/lib/sso/admin-guard"
import { parseScopes } from "@/lib/lender-api/scopes"
import { isApiKeyLifetime } from "@/lib/lender-api/keys"
import { createOauthClient, parseMtlsPin } from "@/lib/lender-api/oauth/clients"

// Register an OAuth client. The secret is in this response and nowhere else.
export async function POST(req: NextRequest) {
  const guard = await requireSsoAdmin("manage_oauth_clients")
  if (guard.error) return guard.error
  const user = guard.user

  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as {
      name?: unknown; scopes?: unknown; lifetimeDays?: unknown; requireMtls?: unknown; mtlsSubjectDn?: unknown; mtlsCertSha256?: unknown
    } | null
    const name = typeof body?.name === "string" ? body.name.trim() : ""
    if (!name || name.length > 80) return NextResponse.json({ error: "Name the client (at most 80 characters)." }, { status: 400 })
    const scopes = parseScopes(body?.scopes)
    if (!scopes) return NextResponse.json({ error: "Choose at least one valid scope." }, { status: 400 })
    if (!isApiKeyLifetime(body?.lifetimeDays)) return NextResponse.json({ error: "Choose a lifetime of 30, 90, 180 or 365 days." }, { status: 400 })
    let mtls = null
    if (body?.requireMtls === true) {
      mtls = parseMtlsPin({ subjectDn: body.mtlsSubjectDn, certSha256: body.mtlsCertSha256 })
      if (!mtls) return NextResponse.json({ error: "Mutual TLS needs the certificate's SHA-256 fingerprint (64 hex characters). A subject DN is optional and must be in RFC 4514 form (CN=…,O=…), exactly as your gateway forwards it." }, { status: 400 })
    }

    const outcome = await createOauthClient({
      tenantId: tenant.id,
      actor: { id: user.id, email: user.email, ipAddress: recordedCallerIp(req) ?? undefined },
      name, scopes, lifetimeDays: body.lifetimeDays, mtls,
    })
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
    return NextResponse.json(
      { clientId: outcome.clientId, clientSecret: outcome.secret, client: { ...outcome.client, expiresAt: outcome.client.expiresAt.toISOString() } },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    )
  })
}
