/**
 * The DEALER branch of the jwt callback in lib/auth.ts, which runs it before
 * the staff branch (that one would look for a User row, find none and sign the
 * dealer out). Sign-in copies the claims authorizeDealer returned; every later
 * request re-applies lib/dealer/principal.ts.
 */
import type { JWT } from "next-auth/jwt"
import type { User } from "next-auth"
import { revalidateDealerPrincipal } from "./principal"

/** The token for a dealer sign-in, or null when the claims are incomplete. */
export function dealerTokenAtSignIn(token: JWT, user: User): JWT | null {
  if (!user.id || typeof user.tenantId !== "string" || typeof user.dealerId !== "string" || !user.dealerRole) return null
  token.id = user.id
  token.role = "DEALER"
  token.tokenVersion = user.tokenVersion ?? 0
  token.tenantId = user.tenantId
  token.dealerId = user.dealerId
  token.dealerRole = user.dealerRole
  token.totpVerified = false
  token.totpEnrolmentRequired = false
  return token
}

/**
 * The token on a later request: null signs out (deactivated user or dealer,
 * tokenVersion bump, portal off, lender suspended, claims that no longer fit
 * the row); a transient DB failure keeps the tenant-bound token, as for staff.
 */
export async function refreshDealerToken(token: JWT): Promise<JWT | null> {
  if (typeof token.id !== "string" || typeof token.tenantId !== "string") return null
  const fresh = await revalidateDealerPrincipal(token.id, {
    tenantId: token.tenantId, dealerId: token.dealerId, tokenVersion: token.tokenVersion,
  })
  if (fresh === "error") return token
  if (fresh === null) return null
  token.dealerRole = fresh.dealerRole // picks up role changes mid-session
  return token
}
