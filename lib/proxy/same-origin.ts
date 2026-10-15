import { NextResponse } from "next/server"

/**
 * Cross-origin write gate (CSRF). Every lender runs under one registrable
 * domain (*.credaflow.com), so a page on a sibling lender's host is
 * "same-site": the SameSite=lax session cookie rides its requests, and most
 * JSON routes parse a text/plain body. A browser-sent write is honoured only
 * from the host's own origin. There is no sibling allowlist.
 *
 * - Sec-Fetch-Site present: only "same-origin" and "none" (user-initiated) pass.
 * - Sec-Fetch-Site absent (older browsers; plain-http hosts other than
 *   localhost): an Origin header must name this host. The host is the Host
 *   header, as everywhere else in proxy.ts; X-Forwarded-Host is never read.
 * - Neither header: a server-to-server call with no browser cookies. Passes.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * Paths that browsers never reach with a session: providers, schedulers and
 * mail clients post to them, and each handler authenticates its own caller
 * (HMAC signature, CRON_SECRET, INTERNAL_API_SECRET, signed unsubscribe token).
 */
const EXEMPT_PREFIXES = ["/api/webhooks/", "/api/cron/"]
const EXEMPT_PATHS = new Set([
  "/api/portal/payment/webhook",
  "/api/messaging/unsubscribe",
  "/api/messaging/unsubscribe/",
  "/api/notifications/application",
  "/api/notifications/payment",
  "/api/health",
])

export function isCrossOriginExempt(path: string): boolean {
  return EXEMPT_PATHS.has(path) || EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))
}

function originMatchesHost(origin: string, host: string | null): boolean {
  if (!host || !URL.canParse(origin)) return false
  const parsed = new URL(origin)
  const schemes = process.env.NODE_ENV === "production" ? ["https:"] : ["https:", "http:"]
  if (!schemes.includes(parsed.protocol)) return false
  const expected = `${parsed.protocol}//${host}`
  return URL.canParse(expected) && new URL(expected).host === parsed.host
}

/** True when the browser says this request was not made by the host's own pages. */
export function isCrossOriginRequest(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site")
  if (site !== null) return site !== "same-origin" && site !== "none"
  const origin = headers.get("origin")
  if (origin === null) return false
  return !originMatchesHost(origin, headers.get("host"))
}

/** The 403 for a cross-origin write, or null when the request may proceed. */
export function crossOriginWriteRefusal(req: {
  method: string
  headers: Headers
  nextUrl: { pathname: string }
}): Response | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null
  const path = req.nextUrl.pathname
  if (isCrossOriginExempt(path)) return null
  if (!isCrossOriginRequest(req.headers)) return null
  const body = { error: "Cross-origin request refused" }
  return path.startsWith("/api/")
    ? NextResponse.json(body, { status: 403 })
    : new NextResponse(body.error, { status: 403 })
}
