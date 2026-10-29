import { SignJWT, jwtVerify } from "jose"
import { randomUUID } from "node:crypto"
import { derivedKey } from "@/lib/crypto/derived-key"
import { claimOnce } from "./cache"
import { isMappableRole, type MappableRole } from "./groups"

/**
 * The two short-lived signed values of an SSO sign-in.
 *
 *  - flow state: set as a cookie when the browser leaves for the identity
 *    provider (state, nonce, PKCE verifier, where to land). It ties the
 *    provider's answer to the browser that asked, which defeats a forged
 *    callback (login CSRF).
 *  - ticket: minted once the provider's answer is verified and names a staff
 *    user. NextAuth's "sso" credentials provider (lib/auth.ts) trades it for a
 *    session. It is single use (claimTicket), carries only ids, and says
 *    whether the provider proved MFA; whether that is accepted is decided again
 *    at the trade, against the lender's current settings.
 *
 * HS256, each with its own derived key and audience, so neither verifies as the other.
 */

const TICKET_AUD = "sso-ticket"
const STATE_AUD = "sso-state"
export const TICKET_TTL_SECONDS = 300
export const STATE_TTL_SECONDS = 600

const key = (context: string) => new Uint8Array(derivedKey(context))

export interface SsoTicket {
  userId: string
  tenantId: string
  /** The provider reported a second factor for this sign-in. Recorded in the audit row only: it never replaces a CredaFlow code. */
  mfaReported: boolean
  /** The role the provider's groups map to now (applied in authorizeSso once the sign-in has passed every check); null keeps the user's role. */
  role: MappableRole | null
}

export async function mintTicket(ticket: SsoTicket, opts: { ttlSeconds?: number } = {}): Promise<string> {
  const ttl = opts.ttlSeconds ?? TICKET_TTL_SECONDS
  return new SignJWT({ tid: ticket.tenantId, mfa: ticket.mfaReported, rl: ticket.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(ticket.userId)
    .setAudience(TICKET_AUD)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(key("sso-ticket"))
}

export async function readTicket(token: string): Promise<(SsoTicket & { jti: string; exp: number }) | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, key("sso-ticket"), { algorithms: ["HS256"], audience: TICKET_AUD, clockTolerance: 5 })
    if (typeof payload.sub !== "string" || typeof payload.tid !== "string" || typeof payload.jti !== "string"
      || typeof payload.mfa !== "boolean" || typeof payload.exp !== "number") return null
    const role = payload.rl === null || payload.rl === undefined ? null : isMappableRole(payload.rl) ? payload.rl : undefined
    if (role === undefined) return null
    return { userId: payload.sub, tenantId: payload.tid, mfaReported: payload.mfa, role, jti: payload.jti, exp: payload.exp }
  } catch {
    return null
  }
}

/** True for the first caller to spend this ticket. */
export function claimTicket(ticket: { jti: string; exp: number }): Promise<boolean> {
  return claimOnce(`sso-ticket:${ticket.jti}`, new Date((ticket.exp + 60) * 1000))
}

export interface SsoFlowState {
  tenantId: string
  /** The OAuth `state` (OIDC) or the RelayState nonce (SAML). */
  state: string
  /** SAML: the id of the AuthnRequest this browser sent; the response must answer exactly it. */
  requestId?: string
  nonce?: string
  codeVerifier?: string
  /** An internal path to land on after sign-in. */
  returnTo: string
}

export async function mintState(state: SsoFlowState, opts: { ttlSeconds?: number } = {}): Promise<string> {
  const ttl = opts.ttlSeconds ?? STATE_TTL_SECONDS
  return new SignJWT({ tid: state.tenantId, st: state.state, nc: state.nonce, cv: state.codeVerifier, rt: state.returnTo, rq: state.requestId })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(STATE_AUD)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(key("sso-state"))
}

export async function readState(token: string): Promise<SsoFlowState | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, key("sso-state"), { algorithms: ["HS256"], audience: STATE_AUD, clockTolerance: 5 })
    if (typeof payload.tid !== "string" || typeof payload.st !== "string" || typeof payload.rt !== "string") return null
    return {
      tenantId: payload.tid,
      state: payload.st,
      nonce: typeof payload.nc === "string" ? payload.nc : undefined,
      codeVerifier: typeof payload.cv === "string" ? payload.cv : undefined,
      requestId: typeof payload.rq === "string" ? payload.rq : undefined,
      returnTo: payload.rt,
    }
  } catch {
    return null
  }
}
