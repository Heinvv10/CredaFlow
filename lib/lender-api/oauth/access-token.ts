import { SignJWT, jwtVerify } from "jose"
import { randomUUID } from "node:crypto"
import { derivedKey } from "@/lib/crypto/derived-key"

/**
 * The OAuth2 access token POST /api/auth/oauth/token issues: a signed JWT (HS256,
 * a key derived from AUTH_SECRET for this purpose only), fifteen minutes at
 * most. It names the client row (`sub`), the lender (`tid`) and the scopes, but
 * is NEVER trusted for them alone: lib/lender-api/oauth/authenticate.ts
 * re-reads the client on every call, so revoking a client, shrinking its
 * scopes or suspending the lender takes effect at once.
 */

const ISSUER = "credaflow"
const AUDIENCE = "credaflow-lender-api"
export const ACCESS_TOKEN_TTL_SECONDS = 900

const key = () => new Uint8Array(derivedKey("oauth-access-token"))

export interface AccessTokenClaims {
  clientRowId: string
  tenantId: string
  scopes: string[]
}

export async function mintAccessToken(claims: AccessTokenClaims, opts: { ttlSeconds?: number } = {}): Promise<{ token: string; expiresIn: number }> {
  const ttl = opts.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS
  const token = await new SignJWT({ tid: claims.tenantId, scope: claims.scopes.join(" ") })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.clientRowId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(key())
  return { token, expiresIn: ttl }
}

/** The token's claims if it is a valid, unexpired access token we issued; otherwise null. */
export async function readAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"], typ: "at+jwt", issuer: ISSUER, audience: AUDIENCE, clockTolerance: 5 })
    if (typeof payload.sub !== "string" || typeof payload.tid !== "string" || typeof payload.scope !== "string" || payload.scope === "") return null
    return { clientRowId: payload.sub, tenantId: payload.tid, scopes: payload.scope.split(" ") }
  } catch {
    return null
  }
}
