import { auth } from "@/lib/auth-edge"
import type { NextAuthRequest } from "next-auth"
import { NextResponse } from "next/server"
import { isPublicOperationalRoute } from "@/lib/public-routes"
import { isQuickQuoteHost } from "@/lib/insurance/quickquote-config"
import { isSharedClientApiPath } from "@/lib/proxy/shared-client-api"
import { applyDemoHeaders } from "@/lib/config/demo-mode"
import { staffAppHost } from "@/lib/config/deployment-urls"
import { enrolmentGate, isHeldAtEnrolment } from "@/lib/proxy/totp-enrolment"
import { isStaticAssetRead } from "@/lib/proxy/static-image"
import { operatorWriteRefusal, stampRequest } from "@/lib/proxy/operator-read-only"
import {
  buildTenantHeaders,
  resolveTenantSlug,
} from "@/lib/proxy/tenant-routing"

export { buildTenantHeaders, resolveTenantSlug }

// Build-time audience gate. Set APP_MODE=staff or APP_MODE=client to serve
// only that audience's routes; anything outside the audience returns 404.
// Default "all" preserves the legacy single-host behaviour for dev and the
// current single-container deploy.
type AppMode = "staff" | "client" | "all"
const APP_MODE: AppMode =
  process.env.APP_MODE === "staff" || process.env.APP_MODE === "client"
    ? process.env.APP_MODE
    : "all"

// Every response (redirects and 404s included) goes through applyDemoHeaders so
// a demo deployment is never indexable; with DEMO_MODE unset it is a no-op.
const handle = auth((req) => applyDemoHeaders(route(req)))

// Reads of the real files in public/ are answered before the session is decoded,
// as when the matcher skipped images. Everything else, image-suffixed or not,
// reaches route() (lib/proxy/static-image.ts).
export default function proxy(...args: Parameters<typeof handle>) {
  return isStaticAssetRead(args[0]) ? NextResponse.next() : handle(...args)
}

function route(req: NextAuthRequest): Response {
  const path = req.nextUrl.pathname
  const hostname = req.headers.get("host") ?? ""
  const baseHostname = hostname.split(":")[0].toLowerCase().replace(/\.$/, "")
  const isLoggedIn = !!req.auth?.user
  const isLoginPage = req.nextUrl.pathname === "/login"
  const isPortalLoginPage = req.nextUrl.pathname === "/portal/login"
  const isPortalPath = path === "/portal" || path.startsWith("/portal/")
  const isRegisterPage = req.nextUrl.pathname === "/register"
  const isPortalRegisterPage = req.nextUrl.pathname === "/portal/register"
  // Smart email-CTA entry: checks account state and 302s to login or register.
  // Public like the login/register pages it routes to (it holds no session).
  const isPortalContinuePage = req.nextUrl.pathname === "/portal/continue"
  // Client-facing self-service reset page. Must be public like
  // /portal/login and /portal/register — the page's own auth() redirects a
  // logged-in user, so no separate logged-in guard entry is needed.
  const isPortalForgotPasswordPage = req.nextUrl.pathname === "/portal/forgot-password"
  const isForgotPasswordPage = req.nextUrl.pathname === "/forgot-password"
  const isResetPasswordPage = req.nextUrl.pathname === "/reset-password"
  const isApiAuthRoute = req.nextUrl.pathname.startsWith("/api/auth")
  // isPortalApiRoute is used for the CLIENT role gate — all /api/portal/* routes allow CLIENT sessions.
  const isPortalApiRoute = req.nextUrl.pathname.startsWith("/api/portal")
  const isWebsiteRoute = req.nextUrl.pathname.startsWith("/site")
  const isWebsiteApi = req.nextUrl.pathname.startsWith("/api/website")
  // The isolated FSP QuickQuote host (quote.*). Public for the same reason
  // /site/* is — it is a marketing surface reached by anonymous visitors, via
  // an iframe on the insurance page. The page itself renders nothing unless
  // the embed is fully configured (lib/insurance/quickquote-config.ts).
  //
  // Scoped to the allow-listed quote hosts. Path alone is NOT sufficient:
  // `app` and `app-portal` are separate services sharing ONE image, so
  // a path-only match would serve FSP's jQuery 1.9.1 bundle on app.* and portal.*
  // — the origins that carry staff and client session cookies. Script running
  // there can issue same-origin credentialed fetches from any logged-in tab.
  const isQuoteHostRoute = path === "/quote" || path.startsWith("/quote/")
  const isOnQuoteHost = isQuickQuoteHost(baseHostname)
  const isPublicOperationalApi = isPublicOperationalRoute(req.nextUrl.pathname)
  // The consumer-facing one-time quotation link. Public for the same reason
  // /portal/register is: the person opening it has no account yet, and for most
  // consumers never will. The page itself resolves the token and
  // renders nothing without a valid one.
  const isPasqLinkPage = path.startsWith("/pasq/")
  // The consumer-facing one-time selfie capture link, for the same reason as
  // /pasq/* above: the person opening it has no account and usually never will.
  // The page resolves the token server-side and renders nothing without a valid
  // one.
  const isSelfieLinkPage = path.startsWith("/selfie/")
  // Shared client+staff APIs the portal calls (documents, statement, PASQ,
  // agreement, debit mandate, signing packet).
  // Reachable on the client host and by CLIENT sessions; handlers self-gate.
  const isSharedClientApi = isSharedClientApiPath(req.nextUrl.pathname, req.method)
  const isPublicWebsiteRoot = path === "/"
  // SEO/AI-crawler assets must reach robots/sitemap/llms.txt without redirecting
  // to the login page — these three paths are intentionally always public.
  const isSeoAsset =
    path === "/robots.txt" || path === "/sitemap.xml" || path === "/llms.txt"
  // Static in-app learning media for authenticated staff manual pages. Public
  // files (seeded demo data), not client records; keep reachable so <video>
  // can stream MP4 ranges without a /login redirect.
  const isManualAsset = path.startsWith("/admin-manual/")
  // Only specific portal endpoints are truly unauthenticated (registration, password reset, HMAC webhook).
  // All other /api/portal/* routes require a valid session (but allow CLIENT role).
  const isPublicPortalRoute =
    req.nextUrl.pathname === "/api/portal/register" ||
    req.nextUrl.pathname.startsWith("/api/portal/forgot-password") ||
    req.nextUrl.pathname.startsWith("/api/portal/reset-password") ||
    req.nextUrl.pathname.startsWith("/api/portal/payment/webhook")
  const isPublicRoute =
    isPublicWebsiteRoot ||
    isSeoAsset ||
    isManualAsset ||
    isLoginPage ||
    isPortalLoginPage ||
    isRegisterPage ||
    isPortalRegisterPage ||
    isPortalContinuePage ||
    isPortalForgotPasswordPage ||
    isForgotPasswordPage ||
    isResetPasswordPage ||
    isApiAuthRoute ||
    isPublicPortalRoute ||
    isPublicOperationalApi ||
    isPasqLinkPage ||
    isSelfieLinkPage ||
    isWebsiteRoute ||
    (isQuoteHostRoute && isOnQuoteHost) ||
    isWebsiteApi

  // STAFF_APP_HOST is the staff workspace host — its root never
  // serves the marketing site. Marketing lives at the apex + www hosts (which
  // fall through to isPublicWebsiteRoot below).
  //   - Unauthenticated:    → /login (staff form)
  //   - Staff (non-CLIENT): → /dashboard
  //   - CLIENT cookie on app.* (edge case — should never occur because cookies
  //     are host-only, but if it did): fall through to the role gate below
  //     which redirects them to /portal (which on app.* is 404'd by the
  //     APP_MODE=staff audience gate, surfacing the misconfiguration).
  // Gated on APP_MODE !== "client" so the rule never fires if app.* is ever
  // accidentally pointed at a client-mode container.
  if (
    path === "/" &&
    baseHostname === staffAppHost() &&
    APP_MODE !== "client"
  ) {
    if (!isLoggedIn) {
      return NextResponse.redirect(new URL("/login", req.url))
    }
    const role = req.auth?.user?.role as string | null | undefined
    // Treat a missing/null role as staff for routing purposes — authorize()
    // always sets a role today, but a future migration could introduce a
    // brief window where it's null; defaulting to staff prevents that user
    // from being incorrectly routed into the client tree.
    if (role && role !== "CLIENT") {
      return NextResponse.redirect(new URL("/dashboard", req.url))
    }
    if (!role) {
      return NextResponse.redirect(new URL("/dashboard", req.url))
    }
  }

  // Origin confinement for the QuickQuote embed. Runs before every other gate:
  // the requirement is that FSP's bundle is unreachable outside its own host,
  // not that it is merely unauthenticated there. Dropping /quote out of
  // isPublicRoute would send app.* to /login and still serve it to any
  // logged-in staff member — the one visitor whose origin must never run it.
  if (isQuoteHostRoute && !isOnQuoteHost) {
    return new NextResponse("Not found", { status: 404 })
  }

  // Audience gate (APP_MODE) — runs before tenant resolution so a wrong-mode
  // request never touches application code. APP_MODE is read from env at
  // container launch (effectively startup-time, not literally build-time —
  // restart-to-flip).
  //
  // Routes intentionally NOT classified (shared in both modes by falling
  // through both checks):
  //   - `/` (marketing root, app/page.tsx)
  //   - `/site/*` (marketing sub-pages, app/(website)/site/*)
  //   - `/quote*` (isolated FSP QuickQuote host, app/(quote)/*) — served on
  //     quote.*, which runs its own container mode-agnostically
  //   - `/api/auth/*` (NextAuth — both audiences need it)
  //   - `/api/website/*` and the public-operational allowlist
  //   - `/pasq/*` (one-time consumer quotation link; its `/api/pasq-link/*`
  //     endpoints ride the public-operational allowlist, which is what keeps
  //     them reachable on the client host)
  //   - `/selfie/*` (one-time consumer KYC capture link; its
  //     `/api/selfie-link/*` endpoint rides the same allowlist, for the same
  //     reason — the link is sent to a consumer who has no account on either
  //     host)
  //
  // Routes intentionally CLIENT-ONLY (incl. cross-system webhooks):
  //   - `/api/portal/payment/webhook` — external payment processor MUST point
  //     at the client host (portal.*) after Phase 2 cutover. Until then,
  //     APP_MODE=all keeps the legacy single-host behaviour for backward
  //     compatibility.
  if (APP_MODE !== "all") {
    // The client host serves an allow-list of pages: the portal, plus the
    // public routes minus the staff sign-in pages. Anything else is a staff
    // page, or no page at all, and 404s. A deny-list of staff prefixes missed
    // /inbox, /contacts and /learn, and would miss the next staff page added.
    const isStaffSignInPage =
      isLoginPage || isRegisterPage || isForgotPasswordPage || isResetPasswordPage
    const isUnlistedPage =
      !path.startsWith("/api/") &&
      !(isPortalPath || (isPublicRoute && !isStaffSignInPage))
    const isClientOnlyPage = isPortalLoginPage || isPortalPath
    // /api/auth/* is public everywhere, but the app's own staff handlers
    // (forgot-password, reset-password) share the prefix. The client host serves
    // NextAuth's endpoints and the stale-session loop-breaker only.
    const isNextAuthApi =
      /^\/api\/auth\/(?:session|csrf|providers|signin|signout|callback|error|verify-request|webauthn-options|_log|expired)(?:\/|$)/.test(path)
    const isStaffOnlyApi =
      path.startsWith("/api/") &&
      !isNextAuthApi &&
      !isWebsiteApi &&
      !isPublicOperationalApi &&
      !isSharedClientApi &&
      !path.startsWith("/api/portal/")
    const isClientOnlyApi = path.startsWith("/api/portal/")

    const reject = (forApi: boolean) =>
      forApi
        ? NextResponse.json({ error: "Not found" }, { status: 404 })
        : new NextResponse("Not found", { status: 404 })

    if (APP_MODE === "staff" && (isClientOnlyPage || isClientOnlyApi)) {
      return reject(isClientOnlyApi)
    }
    if (APP_MODE === "client" && (isUnlistedPage || isStaffOnlyApi)) {
      return reject(isStaffOnlyApi)
    }
  }

  const tenantSlug = resolveTenantSlug(req)

  if (path === "/site") {
    const url = req.nextUrl.clone()
    url.pathname = "/"
    return NextResponse.redirect(url, 308)
  }

  // In production, require a resolvable tenant on non-local hostnames
  const isLocal =
    baseHostname === "localhost" || baseHostname === "127.0.0.1"

  if (!isLocal && !tenantSlug && process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 })
  }

  // Forward tenant slug to Server Components via request header
  const requestHeaders = stampRequest(buildTenantHeaders(req, tenantSlug), req.method)

  // Operator support access is read-only: no write, server action included.
  const operatorRefusal = operatorWriteRefusal(req.auth?.user?.role, req.method, path)
  if (operatorRefusal) return operatorRefusal

  // A staff session the lender's 2FA policy holds at enrolment (lib/auth.ts)
  // reaches only the enrolment page, public paths included.
  if (isHeldAtEnrolment(req.auth)) {
    const refusal = enrolmentGate(req, isPublicRoute)
    if (refusal) return refusal
  }

  if (isPublicRoute) {
    if (isLoggedIn && (isLoginPage || isRegisterPage || isForgotPasswordPage)) {
      return NextResponse.redirect(new URL("/", req.url))
    }
    // `/portal/login` deliberately falls through here: the page itself
    // (`app/portal/login/page.tsx`) does a role-aware redirect — CLIENT → /portal,
    // staff → /dashboard — so middleware shouldn't preempt it.
    return NextResponse.next({ request: { headers: requestHeaders } })
  }

  const isApiPath = path.startsWith("/api/")

  if (!isLoggedIn) {
    // API callers get JSON 401 — not a page redirect — so clients can read the error.
    if (isApiPath) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    // Path-aware login destination: portal URLs go to the portal login form,
    // everything else goes to the staff login. A staff member following a
    // /portal deep link will land at /portal/login and can use the
    // "Are you staff?" cross-link in the form.
    const loginUrl = new URL(isPortalPath ? "/portal/login" : "/login", req.url)
    // Only forward `path` as callbackUrl if it is a safe relative pathname.
    // `req.nextUrl.pathname` is already query/fragment-stripped, but reject
    // anything starting with `//` (protocol-relative — could navigate cross-origin)
    // as defence in depth against open-redirect attempts.
    if (path.startsWith("/") && !path.startsWith("//")) {
      loginUrl.searchParams.set("callbackUrl", path)
    }
    return NextResponse.redirect(loginUrl)
  }

  const role = req.auth?.user?.role as string | undefined
  const isClient = role === "CLIENT"

  // API: staff-by-default. /api/portal/* and the shared client APIs
  // (documents, statement, PASQ, agreement, debit mandate, signing packet) are
  // the carve-outs for CLIENT sessions.
  // Individual route guards (requireApiRole / requireOwnerOrStaff /
  // getDocumentCaller) remain the authoritative enforcement layer; this is
  // defense-in-depth.
  if (isApiPath && isClient && !isPortalApiRoute && !isSharedClientApi) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // Page-level role routing — staff and clients live in separate UI trees.
  if (!isApiPath) {
    if (isClient && !isPortalPath) {
      return NextResponse.redirect(new URL("/portal", req.url))
    }

    if (!isClient && isPortalPath) {
      return NextResponse.redirect(new URL("/", req.url))
    }
  }

  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
}
