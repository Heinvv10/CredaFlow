/**
 * The operator console host (OPERATOR_APP_HOST, lib/config/deployment-urls.ts).
 *
 * Operator staff work on their own host, as clients do on the portal host and
 * lender staff on theirs: the session cookie is host-only, so an operator
 * session never rides along to a lender's host and a lender session never
 * reaches the console. On the operator host proxy.ts hands every request to
 * operatorHostGate, which serves the console (/operator, /api/operator),
 * NextAuth and the token-based password set, and 404s everything else. On any
 * other host the console paths 404 and an operator session is refused.
 *
 * Writes: support access is read-only (lib/proxy/operator-read-only.ts). The
 * console's own management APIs write (create or suspend a lender, invite an
 * operator user); they touch no borrower data. The grant-gated support APIs
 * (/api/operator/support/*) and every page stay GET/HEAD only, and a server
 * action is refused everywhere on this host: the console has none.
 */
import { NextResponse } from "next/server"
import { operatorAppHost, requireOperatorBaseUrl } from "@/lib/config/deployment-urls"
import { isOperatorRole } from "@/lib/operator/roles"
import { isReadMethod } from "./operator-read-only"

export const OPERATOR_HOME = "/operator"
export const OPERATOR_LOGIN = "/operator/login"
export const OPERATOR_SET_PASSWORD = "/operator/set-password"
export const OPERATOR_ENROLMENT_PAGE = "/operator/security"
export const OPERATOR_ENROLMENT_API = "/api/operator/totp"
export const OPERATOR_SUPPORT_API_PREFIX = "/api/operator/support/"

// NextAuth's own endpoints and the stale-session breaker. The app's other
// /api/auth/* handlers (staff forgot-password) are a lender surface.
const NEXTAUTH_API = /^\/api\/auth\/(?:session|csrf|providers|signin|signout|callback|error|_log|expired)(?:\/|$)/
// The token in an invite or reset link is the credential; the page that posts
// it is OPERATOR_SET_PASSWORD.
const SET_PASSWORD_API = "/api/auth/reset-password"

/** /operator and /api/operator, and everything under them. */
export function isOperatorConsolePath(path: string): boolean {
  return path === "/operator" || path.startsWith("/operator/") || path === "/api/operator" || path.startsWith("/api/operator/")
}

type GateRequest = { nextUrl: URL; url: string; method: string; headers: Headers }
type GateSession = { user?: { role?: string | null; totpEnrolmentRequired?: boolean } | null } | null | undefined

/**
 * A write must come from the console's own pages (CSRF). The browser says so
 * in Origin (host and port as the request's Host) and, where it sends it,
 * Sec-Fetch-Site: same-origin. A write that carries neither is refused: every
 * browser that runs the console sends at least one.
 */
export function crossSiteWrite(req: Pick<GateRequest, "headers">): boolean {
  const origin = req.headers.get("origin")
  const site = req.headers.get("sec-fetch-site")
  if (!origin && !site) return true
  if (site !== null && site !== "same-origin") return true
  if (origin !== null) {
    let host: string
    try {
      host = new URL(origin).host
    } catch {
      return true
    }
    if (host.toLowerCase() !== (req.headers.get("host") ?? "").toLowerCase()) return true
  }
  return false
}

// Auth.js may canonicalise req.url to NEXTAUTH_URL (the lender origin).
// This gate is reached only after proxy.ts matches the configured console host.
// Never derive a redirect destination from client-controlled forwarded headers.
function operatorRedirectUrl(path: string, req: GateRequest): URL {
  if (process.env.NEXTAUTH_URL?.trim()) return new URL(path, requireOperatorBaseUrl())
  const base = new URL(req.url)
  const host = operatorAppHost()
  if (host) base.hostname = host
  return new URL(path, base)
}

const isJson = (req: GateRequest) => /^application\/json(\s*;|$)/i.test(req.headers.get("content-type") ?? "")

const notFound = (api: boolean) =>
  api ? NextResponse.json({ error: "Not found" }, { status: 404 }) : new NextResponse("Not found", { status: 404 })

/**
 * The response for a request on the operator host. `forward` carries the
 * request headers application code may read (no tenant slug: the console has
 * no tenant; method and request id stamped by stampRequest).
 */
export function operatorHostGate(req: GateRequest, session: GateSession, forward: Headers, appMode: string): Response {
  const path = req.nextUrl.pathname.replace(/\/+$/, "") || "/"
  const isApi = path.startsWith("/api/")
  const next = () => NextResponse.next({ request: { headers: forward } })

  // A client-audience container never serves the console.
  if (appMode === "client") return notFound(isApi)
  if (path === "/") return NextResponse.redirect(operatorRedirectUrl(OPERATOR_HOME, req))

  const isPublic =
    path === OPERATOR_LOGIN || path === OPERATOR_SET_PASSWORD || NEXTAUTH_API.test(path) || path === SET_PASSWORD_API
  if (!isPublic && !isOperatorConsolePath(path)) return notFound(isApi)

  // The console has no server actions, and a page is only ever read.
  if (req.headers.has("next-action")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!isApi && !isReadMethod(req.method)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!isReadMethod(req.method)) {
    if (crossSiteWrite(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 })
    // A cross-site form can only send text/plain, urlencoded or multipart.
    if (isOperatorConsolePath(path) && !isJson(req)) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 })
    }
  }

  const user = session?.user
  if (isPublic) {
    if (user && isOperatorRole(user.role) && path === OPERATOR_LOGIN) {
      return NextResponse.redirect(operatorRedirectUrl(OPERATOR_HOME, req))
    }
    return next()
  }

  if (!user) {
    if (isApi) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const login = operatorRedirectUrl(OPERATOR_LOGIN, req)
    login.searchParams.set("callbackUrl", path)
    return NextResponse.redirect(login)
  }
  // A lender's staff or client session has no business here (and cannot be
  // minted here: lib/auth.ts refuses it).
  if (!isOperatorRole(user.role)) return notFound(isApi)

  // No TOTP yet (or a token minted before the claim): the enrolment page and
  // its API only. Operator 2FA is not optional.
  if (user.totpEnrolmentRequired !== false) {
    if (isApi) {
      const allowed = path === OPERATOR_ENROLMENT_API && (req.method === "GET" || req.method === "POST")
      return allowed ? next() : NextResponse.json({ error: "Two-factor enrolment required", code: "totp_enrolment_required" }, { status: 403 })
    }
    return path === OPERATOR_ENROLMENT_PAGE ? next() : NextResponse.redirect(operatorRedirectUrl(OPERATOR_ENROLMENT_PAGE, req))
  }

  if (path.startsWith(OPERATOR_SUPPORT_API_PREFIX) && !isReadMethod(req.method)) {
    return NextResponse.json({ error: "Support access is read-only" }, { status: 403 })
  }
  return next()
}

/**
 * Off the operator host: the console does not exist, and an operator session
 * is refused (it can still sign out). Null when the request may proceed.
 */
export function operatorOffHostRefusal(path: string, role: unknown): Response | null {
  const isApi = path.startsWith("/api/")
  if (isOperatorConsolePath(path)) return notFound(isApi)
  if (isOperatorRole(role) && !NEXTAUTH_API.test(path)) {
    return isApi ? NextResponse.json({ error: "Forbidden" }, { status: 403 }) : notFound(false)
  }
  return null
}
