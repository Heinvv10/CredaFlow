/**
 * The dealer portal host (DEALER_APP_HOST, lib/config/deployment-urls.ts).
 *
 * Dealer and broker users work on their own host, as operator staff do on the
 * console host: the session cookie is host-only, so a dealer session never
 * rides along to the lender's staff or client host, and theirs never reaches
 * the dealer host. The host runs on the staff container and resolves the
 * lender from TENANT_HOST_MAP. On it proxy.ts hands every request to
 * dealerHostGate, which serves the portal (/dealer, /api/dealer), NextAuth and
 * the token-based password set, and 404s everything else. Off it the dealer
 * paths 404 and a DEALER session is refused (dealerOffHostRefusal).
 *
 * Dozens of call sites treat any non-CLIENT session as staff: this gate is the
 * boundary that keeps a DEALER session away from them, backed by the guard
 * census (lib/dealer/staff-guards-refuse.test.ts). The portal has no server
 * actions, and its pages are only read.
 */
import { NextResponse } from "next/server"
import { dealerAppHost, requireDealerBaseUrl } from "@/lib/config/deployment-urls"
import { crossSiteWrite } from "./operator-host"
import { isReadMethod } from "./operator-read-only"

export const DEALER_HOME = "/dealer"
export const DEALER_LOGIN = "/dealer/login"
export const DEALER_SET_PASSWORD = "/dealer/set-password"
export const DEALER_SET_PASSWORD_API = "/api/dealer/set-password"

/** NextAuth's own endpoints and the stale-session breaker (as on the console host). */
const NEXTAUTH_API = /^\/api\/auth\/(?:session|csrf|providers|signin|signout|callback|error|_log|expired)(?:\/|$)/

/** /dealer and /api/dealer, and everything under them. */
export function isDealerPortalPath(path: string): boolean {
  return path === "/dealer" || path.startsWith("/dealer/") || path === "/api/dealer" || path.startsWith("/api/dealer/")
}

type GateRequest = { nextUrl: URL; url: string; method: string; headers: Headers }
type GateSession = { user?: { role?: string | null } | null } | null | undefined

const notFound = (api: boolean) =>
  api ? NextResponse.json({ error: "Not found" }, { status: 404 }) : new NextResponse("Not found", { status: 404 })

// Never derive a redirect from client-controlled forwarded headers: the
// deployment's origin on the configured dealer host, else the request URL's
// own origin on that host.
function dealerRedirectUrl(path: string, req: GateRequest): URL {
  if (process.env.NEXTAUTH_URL?.trim()) return new URL(path, requireDealerBaseUrl())
  const base = new URL(req.url)
  const host = dealerAppHost()
  if (host) base.hostname = host
  return new URL(path, base)
}

/**
 * The response for a request on the dealer host. `forward` carries the request
 * headers application code may read: the lender's slug as this host resolves
 * it (any caller value removed), method and request id stamped.
 */
export function dealerHostGate(req: GateRequest, session: GateSession, forward: Headers, appMode: string): Response {
  const path = req.nextUrl.pathname.replace(/\/+$/, "") || "/"
  const isApi = path.startsWith("/api/")
  const next = () => NextResponse.next({ request: { headers: forward } })

  // A client-audience container never serves the portal, and a host that
  // resolves no lender has no dealers.
  if (appMode === "client" || !forward.get("x-tenant-slug")) return notFound(isApi)
  if (path === "/") return NextResponse.redirect(dealerRedirectUrl(DEALER_HOME, req))

  const isPublic = path === DEALER_LOGIN || path === DEALER_SET_PASSWORD || path === DEALER_SET_PASSWORD_API || NEXTAUTH_API.test(path)
  if (!isPublic && !isDealerPortalPath(path)) return notFound(isApi)

  // No server actions; pages are only read; a write says it is same-origin.
  if (req.headers.has("next-action")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!isApi && !isReadMethod(req.method)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!isReadMethod(req.method) && crossSiteWrite(req)) {
    return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 })
  }

  const user = session?.user
  if (isPublic) {
    if (user?.role === "DEALER" && path === DEALER_LOGIN) return NextResponse.redirect(dealerRedirectUrl(DEALER_HOME, req))
    return next()
  }
  if (!user) {
    if (isApi) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const login = dealerRedirectUrl(DEALER_LOGIN, req)
    login.searchParams.set("callbackUrl", path)
    return NextResponse.redirect(login)
  }
  // A staff, client or operator session has no business here (and cannot be
  // minted here: lib/auth.ts refuses it).
  if (user.role !== "DEALER") return notFound(isApi)
  return next()
}

/**
 * Off the dealer host: the portal does not exist, and a DEALER session is
 * refused (it can still sign out). Null when the request may proceed.
 */
export function dealerOffHostRefusal(path: string, role: unknown): Response | null {
  const isApi = path.startsWith("/api/")
  if (isDealerPortalPath(path)) return notFound(isApi)
  if (role === "DEALER" && !NEXTAUTH_API.test(path)) {
    return isApi ? NextResponse.json({ error: "Forbidden" }, { status: 403 }) : notFound(false)
  }
  return null
}
