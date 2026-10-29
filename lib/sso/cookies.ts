/**
 * The cookies of an SSO sign-in. Both are HttpOnly, path-scoped to /api/auth
 * and /login's needs, and short-lived; the flow cookie must survive the
 * identity provider's cross-site POST (SAML), so it is SameSite=None on https.
 */

const secure = () => (process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "").startsWith("https://")
const prefix = () => (secure() ? "__Host-" : "")

export const flowCookieName = () => `${prefix()}cf-sso-flow`
export const ticketCookieName = () => `${prefix()}cf-sso-ticket`

export function cookieOptions(maxAgeSeconds: number, crossSite: boolean) {
  const https = secure()
  return {
    httpOnly: true,
    secure: https,
    // A SAML response is a cross-site POST: only SameSite=None cookies ride it. On plain http (development) the attribute is left to the browser default.
    ...(crossSite && https ? { sameSite: "none" as const } : { sameSite: "lax" as const }),
    path: "/",
    maxAge: maxAgeSeconds,
  }
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim())
      } catch {
        return null // a malformed escape is a missing cookie, never a 500
      }
    }
  }
  return null
}

export const ssoTicketFromCookieHeader = (header: string | null) => readCookie(header, ticketCookieName())
export const ssoFlowFromCookieHeader = (header: string | null) => readCookie(header, flowCookieName())
