import { splitCookiesString } from "next/dist/server/web/utils"

/** Only this Auth.js action clears the session; it must not also renew it. */
export function isCanonicalSignOutPost(req: { method: string; nextUrl: { pathname: string } }): boolean {
  return req.method === "POST" && req.nextUrl.pathname === "/api/auth/signout"
}

/** Middleware authenticates requests; only the downstream Auth.js route owns renewal.
 * A prefetch started before logout may finish afterwards, so it must never
 * restore a nonempty session cookie. Preserve empty stale-session deletions.
 */
export function removeMiddlewareSessionRenewals(response: Response, sessionCookieName: string): Response {
  for (const header of ["set-cookie", "x-middleware-set-cookie"]) {
    const raw = response.headers.get(header)
    if (!raw) continue
    const cookies = splitCookiesString(raw)
    const retained = cookies.filter(cookie => {
      const first = cookie.split(";", 1)[0]
      const equals = first.indexOf("=")
      if (equals < 0) return true
      const name = first.slice(0, equals).trim()
      const isSession = name === sessionCookieName ||
        (name.startsWith(sessionCookieName + ".") && /^\d+$/.test(name.slice(sessionCookieName.length + 1)))
      return !isSession || first.slice(equals + 1).length === 0
    })
    if (retained.length === cookies.length) continue
    response.headers.delete(header)
    if (header === "x-middleware-set-cookie" && retained.length) {
      response.headers.set(header, retained.join(", "))
    } else {
      for (const cookie of retained) response.headers.append(header, cookie)
    }
  }
  return response
}
