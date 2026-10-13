import { encode, getToken } from "next-auth/jwt"
import type { NextRequest, NextResponse } from "next/server"
import { authBaseConfig } from "./auth-config"
import { clientCredentialStamp } from "./client-session"

// Auth.js's default session lifetime, which this app does not override.
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/**
 * After a portal password change, keep the session that made the change signed
 * in. Its stamp (lib/client-session.ts) names the old hash, so without this the
 * client's next click would end their own session; every OTHER session of the
 * client still carries the old stamp and ends, which is the point of the stamp.
 *
 * The cookie is re-issued here, server-side, and not through NextAuth's session
 * update: that is also reachable as POST /api/auth/session, so a jwt callback
 * that re-stamped on "update" would let a stale session of a client whose
 * password was just reset re-stamp itself. The stamp comes from the hash this
 * request just stored, never from caller input, and only a cookie that already
 * names this client is re-issued.
 */
export async function keepClientSessionAfterPasswordChange(
  req: NextRequest,
  res: NextResponse,
  clientId: string,
  newPasswordHash: string,
): Promise<void> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET
  const cookie = authBaseConfig.cookies.sessionToken
  if (!secret) throw new Error("AUTH_SECRET is required to re-issue a client session")

  const token = await getToken({ req, secret, salt: cookie.name, cookieName: cookie.name })
  if (!token || token.role !== "CLIENT" || token.id !== clientId) return

  token.credentialStamp = clientCredentialStamp(newPasswordHash)
  const value = await encode({ token, secret, salt: cookie.name, maxAge: SESSION_MAX_AGE_SECONDS })
  res.cookies.set(cookie.name, value, {
    ...cookie.options,
    expires: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000),
  })
}
