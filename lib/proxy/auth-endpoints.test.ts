import { describe, expect, it } from "vitest"
import { isCanonicalSignOutPost } from "./auth-endpoints"
describe("canonical Auth.js session-clearing action", () => {
  it("matches only POST on the exact signout pathname", () => {
    expect(isCanonicalSignOutPost({ method: "POST", nextUrl: { pathname: "/api/auth/signout" } })).toBe(true)
  })
  it.each([...["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"].map(method => [method, "/api/auth/signout"]), ...["/api/auth/signout/", "/api/auth/signout/extra", "/api/auth/signout-other", "/api/auth/Signout", "/api/auth/session", "/api/auth/callback/credentials", "/api/auth/csrf", "/api/auth/forgot-password"].map(path => ["POST", path])])("does not exempt %s %s", (method, pathname) => {
    expect(isCanonicalSignOutPost({ method, nextUrl: { pathname } })).toBe(false)
  })
})
