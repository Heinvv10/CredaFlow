import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { createRateLimiter, recordedCallerIp } from "@/lib/rate-limit"
import { apiKeyMatches, keyIssuerStillAuthorised } from "@/lib/lender-api/keys"
import { logApiRequest } from "@/lib/lender-api/handler"
import { sourceAddressAllowed } from "@/lib/lender-api/ip-restriction"
import { isApiScope } from "@/lib/lender-api/scopes"
import { mintAccessToken } from "./access-token"
import { isClientId, oauthClientState } from "./clients"
import { checkClientCertificate } from "./mtls"

/**
 * POST /api/auth/oauth/token: the OAuth 2.0 client-credentials grant (RFC 6749 §4.4)
 * for /api/v1. The client authenticates with HTTP Basic or by form fields
 * (never both); the answer is a fifteen-minute bearer access token, narrowed to
 * the scopes asked for. Errors are RFC 6749 §5.2 bodies. Rate limits follow the
 * rest of /api/v1: per client for real client ids, and a failed-authentication
 * bucket per caller address that a valid client never touches.
 */

export const TOKEN_CLIENT_RATE_LIMIT = { limit: 60, windowMs: 60_000 }
export const TOKEN_FAILED_IP_LIMIT = { limit: 30, windowMs: 60_000 }
export const TOKEN_FAILED_GLOBAL_LIMIT = { limit: 300, windowMs: 60_000 }
const MAX_BODY_BYTES = 8 * 1024

// Namespaces are in the shared store's keys (lib/rate-limit.ts): never rename one.
const clientLimiter = createRateLimiter(10_000, "oauth-token:client")
const failedByAddress = createRateLimiter(10_000, "oauth-token:failed:address")
const failedGlobal = createRateLimiter(1, "oauth-token:failed:global")
const LAST_USED_RESOLUTION_MS = 60_000

type OAuthError = "invalid_request" | "invalid_client" | "unsupported_grant_type" | "invalid_scope"

function oauthError(error: OAuthError, description: string, viaBasic = false): NextResponse {
  const status = error === "invalid_client" ? 401 : 400
  return NextResponse.json({ error, error_description: description }, {
    status,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache", ...(status === 401 && viaBasic ? { "WWW-Authenticate": 'Basic realm="credaflow"' } : {}) },
  })
}

/** RFC 6749 §2.3.1: Basic credentials are form-urlencoded before base64. */
function basicCredentials(header: string | null): { id: string; secret: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header ?? "")
  if (!match) return null
  const decoded = Buffer.from(match[1], "base64").toString("utf8")
  const colon = decoded.indexOf(":")
  if (colon < 0) return null
  try {
    return { id: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " ")), secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " ")) }
  } catch {
    return null
  }
}

export async function handleTokenRequest(req: Request, now: Date = new Date()): Promise<Response> {
  const startedAt = Date.now()
  let tenantId: string | null = null
  let clientRowId: string | null = null
  let viaBasic = false
  const finish = async (res: NextResponse) => {
    await logApiRequest(req, { tenantId, keyId: clientRowId, kind: "oauth_client", status: res.status, startedAt })
    return res
  }
  // Counted only for refusals that name no real, secret-proven client.
  const failed = async (error: OAuthError, description: string) => {
    const ip = recordedCallerIp(req)
    const gate = ip ? await failedByAddress(ip, TOKEN_FAILED_IP_LIMIT) : await failedGlobal("unknown-address", TOKEN_FAILED_GLOBAL_LIMIT)
    if (!gate.allowed) {
      return finish(NextResponse.json({ error: "invalid_request", error_description: "Too many failed requests." }, {
        status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds), "Cache-Control": "no-store" },
      }))
    }
    return finish(oauthError(error, description, viaBasic))
  }

  try {
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return failed("invalid_request", "Send application/x-www-form-urlencoded.")
    }
    const text = await req.text()
    if (text.length > MAX_BODY_BYTES) return failed("invalid_request", "The request is too large.")
    const form = new URLSearchParams(text)
    if (form.getAll("grant_type").length !== 1) return failed("invalid_request", "Send exactly one grant_type.")
    if (form.get("grant_type") !== "client_credentials") return failed("unsupported_grant_type", "Only client_credentials is supported.")

    const basic = basicCredentials(req.headers.get("authorization"))
    const bodyId = form.get("client_id"), bodySecret = form.get("client_secret")
    const hasBody = bodyId !== null || bodySecret !== null
    if (basic && hasBody) return failed("invalid_request", "Use one client authentication method.")
    viaBasic = basic !== null
    const clientId = basic?.id ?? bodyId ?? ""
    const secret = basic?.secret ?? bodySecret ?? ""
    if (!clientId || !secret) return failed("invalid_client", "Client authentication failed.")

    const row = isClientId(clientId)
      ? await withoutTenantScope(async () => await prisma.oauthClient.findUnique({
          where: { clientId },
          select: {
            id: true, tenantId: true, secretHash: true, scopes: true, expiresAt: true, revokedAt: true, lastUsedAt: true,
            requireMtls: true, mtlsSubjectDn: true, mtlsCertSha256: true, ipAllowlist: true,
            tenant: { select: { status: true } }, createdBy: { select: { active: true, role: true } },
          },
        }))
      : null
    // A wrong secret and an unknown client look the same.
    if (!row || !apiKeyMatches(secret, row.secretHash)) return failed("invalid_client", "Client authentication failed.")
    tenantId = row.tenantId
    clientRowId = row.id

    const limit = await clientLimiter(row.id, TOKEN_CLIENT_RATE_LIMIT)
    if (!limit.allowed) {
      return finish(NextResponse.json({ error: "invalid_request", error_description: "Too many token requests for this client." }, {
        status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds), "Cache-Control": "no-store" },
      }))
    }
    // The secret is proven: from here on the client is told why.
    const state = oauthClientState(row, now)
    if (state !== "active") return finish(oauthError("invalid_client", `The client is ${state}.`, viaBasic))
    if (!keyIssuerStillAuthorised(row.createdBy)) return finish(oauthError("invalid_client", "The client's creator is no longer an active admin.", viaBasic))
    if (row.tenant.status !== "ACTIVE") return finish(oauthError("invalid_client", "This lender is not active.", viaBasic))
    if (!sourceAddressAllowed(req, row.ipAllowlist ?? [])) {
      return finish(oauthError("invalid_client", "This client may not be used from this address.", viaBasic))
    }
    if (checkClientCertificate(req.headers, row) !== "ok") {
      return finish(oauthError("invalid_client", "This client must present its pinned client certificate.", viaBasic))
    }

    const requested = form.get("scope")
    const asked = requested === null || requested.trim() === "" ? row.scopes : [...new Set(requested.trim().split(/\s+/))]
    if (!asked.every((s) => isApiScope(s) && row.scopes.includes(s))) {
      return finish(oauthError("invalid_scope", "The client may not request that scope.", viaBasic))
    }

    const { token, expiresIn } = await mintAccessToken({ clientRowId: row.id, tenantId: row.tenantId, scopes: asked })
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
      await prisma.oauthClient.updateMany({ where: { id: row.id, tenantId: row.tenantId }, data: { lastUsedAt: now } })
    }
    return finish(NextResponse.json(
      { access_token: token, token_type: "Bearer", expires_in: expiresIn, scope: asked.join(" ") },
      { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
    ))
  } catch (error) {
    console.error("[oauth] token request failed", { clientRowId }, error)
    return finish(NextResponse.json({ error: "invalid_request", error_description: "The request failed." }, { status: 500, headers: { "Cache-Control": "no-store" } }))
  }
}
