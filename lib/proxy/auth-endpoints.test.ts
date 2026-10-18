import { describe, expect, it } from "vitest"
import { splitCookiesString } from "next/dist/server/web/utils"
import { removeMiddlewareSessionRenewals, isCanonicalSignOutPost } from "./auth-endpoints"
describe("canonical Auth.js session-clearing action", () => {
  it("matches only POST on the exact signout pathname", () => {
    expect(isCanonicalSignOutPost({ method: "POST", nextUrl: { pathname: "/api/auth/signout" } })).toBe(true)
  })
  it.each([...["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"].map(method => [method, "/api/auth/signout"]), ...["/api/auth/signout/", "/api/auth/signout/extra", "/api/auth/signout-other", "/api/auth/Signout", "/api/auth/session", "/api/auth/callback/credentials", "/api/auth/csrf", "/api/auth/forgot-password"].map(path => ["POST", path])])("does not exempt %s %s", (method, pathname) => {
    expect(isCanonicalSignOutPost({ method, nextUrl: { pathname } })).toBe(false)
  })
})

describe("middleware session renewal ownership", () => {
  it.each(["authjs.session-token", "__Host-authjs.session-token"])("removes only nonempty %s renewals and numeric chunks from both headers", name => {
    const keep = [
      `${name}=; Path=/; Max-Age=0`,
      `${name}.2=; Path=/; Max-Age=0`,
      `${name}-other=keep; Path=/`,
      `${name}.other=keep; Path=/`,
      "authjs.csrf-token=csrf; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
      "authjs.callback-url=callback; Path=/",
    ]
    const response = new Response(null, { status: 307, headers: { location: "/portal/login", "x-demo": "preserved" } })
    for (const header of ["set-cookie", "x-middleware-set-cookie"]) {
      response.headers.set(header, [`${name}=renewed; Path=/`, `${name}.0=first; Path=/`, `${name}.1=second; Path=/`, ...keep].join(", "))
    }
    const result = removeMiddlewareSessionRenewals(response, name)
    for (const header of ["set-cookie", "x-middleware-set-cookie"]) expect(splitCookiesString(result.headers.get(header)!)).toEqual(keep)
    expect(result.status).toBe(307)
    expect(result.headers.get("location")).toBe("/portal/login")
    expect(result.headers.get("x-demo")).toBe("preserved")
  })
  it("removes an empty header after the last renewal and preserves unrelated response identity", () => {
    const response = new Response("unchanged", { headers: { "set-cookie": "authjs.session-token=renewed", "x-middleware-set-cookie": "authjs.session-token.0=chunk" } })
    expect(removeMiddlewareSessionRenewals(response, "authjs.session-token")).toBe(response)
    expect(response.headers.has("set-cookie")).toBe(false)
    expect(response.headers.has("x-middleware-set-cookie")).toBe(false)
  })
  it("does not mutate the downstream auth route's separate login response", () => {
    const middleware = new Response(null, { headers: { "set-cookie": "authjs.session-token=middleware" } })
    const downstream = new Response(null, { headers: { "set-cookie": "authjs.session-token=legitimate-login" } })
    removeMiddlewareSessionRenewals(middleware, "authjs.session-token")
    expect(downstream.headers.get("set-cookie")).toBe("authjs.session-token=legitimate-login")
  })
})
