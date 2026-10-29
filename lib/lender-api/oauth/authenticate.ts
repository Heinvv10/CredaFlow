import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { apiError } from "@/lib/lender-api/api-error"
import { keyIssuerStillAuthorised } from "@/lib/lender-api/keys"
import type { AuthOutcome } from "@/lib/lender-api/handler"
import { readAccessToken } from "./access-token"
import { checkClientCertificate } from "./mtls"
import { oauthClientState } from "./clients"

/**
 * Bearer access tokens on /api/v1, beside API keys (handler.ts picks the path
 * by the shape of the credential: a JWT has dots, an API key does not).
 *
 * The signed token is only a claim to look the client up. Every call re-reads
 * the OauthClient: revoked, expired, a deactivated or demoted creator, a
 * suspended lender, a changed certificate pin, and scopes narrowed since the
 * token was issued all take effect on the next request. The scopes granted are
 * the token's AND the client's current ones.
 */

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/

export const looksLikeAccessToken = (token: string): boolean => JWT_SHAPE.test(token)

export async function authenticateAccessToken(req: Request, token: string, now: Date): Promise<AuthOutcome> {
  const fail = (status: number, code: string, message: string, tenantId: string | null = null, keyId: string | null = null): AuthOutcome => ({
    ok: false, tenantId, keyId, kind: "oauth_client",
    response: apiError(status, code, message, status === 401 ? { "WWW-Authenticate": `Bearer error="invalid_token"` } : undefined),
  })
  const claims = await readAccessToken(token)
  if (!claims) return fail(401, "invalid_token", "The access token is not valid or has expired.")

  const row = await withoutTenantScope(async () => await prisma.oauthClient.findFirst({
    where: { id: claims.clientRowId, tenantId: claims.tenantId },
    select: {
      id: true, tenantId: true, scopes: true, createdById: true, expiresAt: true, revokedAt: true, lastUsedAt: true,
      requireMtls: true, mtlsSubjectDn: true, mtlsCertSha256: true,
      tenant: { select: { status: true } },
      createdBy: { select: { active: true, role: true } },
    },
  }))
  if (!row) return fail(401, "invalid_token", "The access token is not valid or has expired.")

  const state = oauthClientState(row, now)
  if (state !== "active") return fail(401, `oauth_client_${state}`, `The OAuth client is ${state}.`, row.tenantId, row.id)
  if (!keyIssuerStillAuthorised(row.createdBy)) {
    return fail(401, "oauth_client_suspended", "The OAuth client's creator is no longer an active admin. Register a new client.", row.tenantId, row.id)
  }
  if (row.tenant.status !== "ACTIVE") return fail(403, "tenant_inactive", "This lender is not active.", row.tenantId, row.id)
  // A stolen token is useless without the client's certificate.
  if (checkClientCertificate(req.headers, row) !== "ok") {
    return fail(401, "client_certificate_required", "This OAuth client must present its pinned client certificate.", row.tenantId, row.id)
  }

  const scopes = claims.scopes.filter((s) => row.scopes.includes(s))
  return {
    ok: true,
    lastUsedAt: row.lastUsedAt,
    caller: { keyId: row.id, kind: "oauth_client", tenantId: row.tenantId, scopes, createdById: row.createdById },
  }
}
