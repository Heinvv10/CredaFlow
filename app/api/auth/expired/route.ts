import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { authBaseConfig } from "@/lib/auth-config"
import { safeInternalPath } from "@/lib/safe-path"
import { isOperatorConsolePath, OPERATOR_LOGIN } from "@/lib/proxy/operator-host"

// Stale-session loop-breaker.
//
// The edge middleware (`proxy.ts` → `lib/auth-edge`) trusts a JWT on signature
// alone, while the node-side guards (`lib/auth` → `revalidatePrincipal`) reject
// it when the principal is stale (tokenVersion bump or account deactivation).
// That node-side rejection happens inside Server Components, which CANNOT clear
// cookies — so the stale cookie survives and the user ping-pongs
// /login ⇄ /dashboard forever (ERR_TOO_MANY_REDIRECTS).
//
// Server guards send the user here instead of straight to /login. A route
// handler CAN delete cookies, so we clear the session token and then hand off
// to the login form. With the cookie gone, edge and node agree the user is
// logged out and the form renders normally.
//
// Reachable without a session: matched by `startsWith("/api/auth")` in
// proxy.ts (isApiAuthRoute → isPublicRoute), so it is never itself gated.
export function GET(req: NextRequest): NextResponse {
  // Preserve the original destination so re-login lands where they intended.
  // Only accept a safe same-origin path (defence against open-redirect: "//x"
  // and "/\x" both leave the origin); anything else falls back to the staff
  // dashboard.
  const requested = safeInternalPath(req.nextUrl.searchParams.get("callbackUrl"))
  const isPortalPath = (path: string) => path === "/portal" || path.startsWith("/portal/")
  // The client host serves no staff sign-in (proxy.ts 404s /login): it signs in
  // at the portal, and only a portal destination survives.
  const isClientHost = process.env.APP_MODE === "client"
  const callbackUrl = isClientHost
    ? requested && isPortalPath(requested) ? requested : "/portal"
    : requested ?? "/dashboard"

  // Emit a RELATIVE Location. A route handler's `req.url` is the container's
  // internal bind address (e.g. http://0.0.0.0:3300), so an absolute URL built
  // from it would send the browser to an unreachable host (nginx does not
  // rewrite a Location that doesn't match its proxy_pass target). A relative
  // path is resolved by the browser against the public origin instead.
  //
  // A portal destination goes to the portal's own sign-in form: a client sent
  // to the staff /login cannot sign in there. With the cookie cleared below,
  // /portal/login renders its form rather than bouncing back to /portal.
  // The operator console signs in on its own page (lib/proxy/operator-host.ts).
  const loginPath = isPortalPath(callbackUrl)
    ? "/portal/login"
    : isOperatorConsolePath(callbackUrl) ? OPERATOR_LOGIN : "/login"
  const location = `${loginPath}?callbackUrl=${encodeURIComponent(callbackUrl)}`
  const res = new NextResponse(null, { status: 307, headers: { Location: location } })

  // Derive the configured cookie name (e.g. `__Secure-authjs.session-token` on
  // https) so we delete exactly what was set. Auth.js chunks oversized tokens
  // into `.0`, `.1`; clear those too — deleting a non-existent cookie is a no-op.
  const base = authBaseConfig.cookies?.sessionToken?.name ?? "authjs.session-token"
  // Both `__Secure-` and `__Host-` prefixes require Secure; otherwise the
  // browser ignores the Set-Cookie and the stale cookie survives (loop persists).
  // We never set a `domain`, satisfying the extra `__Host-` constraints.
  const secure = base.startsWith("__Secure-") || base.startsWith("__Host-")
  for (const name of [base, `${base}.0`, `${base}.1`]) {
    res.cookies.set(name, "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure,
      maxAge: 0,
    })
  }

  return res
}
