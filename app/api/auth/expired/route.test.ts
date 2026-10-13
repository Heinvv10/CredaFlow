import { describe, it, expect } from "vitest"
import { NextRequest } from "next/server"
import { authBaseConfig } from "@/lib/auth-config"
import { GET } from "./route"

const COOKIE = authBaseConfig.cookies?.sessionToken?.name ?? "authjs.session-token"
const ORIGIN = "https://staging.acme-lending.example"

function call(url: string) {
  return GET(new NextRequest(url))
}

// The handler emits a RELATIVE Location (no scheme/host) on purpose — a route
// handler's req.url is the internal bind address, so an absolute URL would point
// the browser at an unreachable host. Parse against a base to inspect it.
function location(res: { headers: Headers }) {
  const raw = res.headers.get("location") ?? ""
  return { raw, url: new URL(raw, ORIGIN) }
}

describe("GET /api/auth/expired (stale-session loop-breaker)", () => {
  it("clears the session cookie (empty value, maxAge 0)", () => {
    const res = call(`${ORIGIN}/api/auth/expired`)
    const cleared = res.cookies.get(COOKIE)
    expect(cleared?.value).toBe("")
    expect(cleared?.maxAge).toBe(0)
    expect(cleared?.path).toBe("/")
  })

  it("redirects (307) to a RELATIVE /login with default callbackUrl=/dashboard", () => {
    const res = call(`${ORIGIN}/api/auth/expired`)
    expect(res.status).toBe(307)
    const { raw, url } = location(res)
    expect(raw.startsWith("/login")).toBe(true) // relative — no scheme/host
    expect(url.pathname).toBe("/login")
    expect(url.searchParams.get("callbackUrl")).toBe("/dashboard")
  })

  it("preserves a safe relative callbackUrl", () => {
    const res = call(`${ORIGIN}/api/auth/expired?callbackUrl=${encodeURIComponent("/loans/123")}`)
    expect(location(res).url.searchParams.get("callbackUrl")).toBe("/loans/123")
  })

  it("rejects a protocol-relative callbackUrl (open-redirect) → falls back to /dashboard", () => {
    const res = call(`${ORIGIN}/api/auth/expired?callbackUrl=${encodeURIComponent("//evil.example.com")}`)
    expect(location(res).url.searchParams.get("callbackUrl")).toBe("/dashboard")
  })

  it("rejects an absolute-URL callbackUrl → falls back to /dashboard", () => {
    const res = call(`${ORIGIN}/api/auth/expired?callbackUrl=${encodeURIComponent("https://evil.example.com/phish")}`)
    expect(location(res).url.searchParams.get("callbackUrl")).toBe("/dashboard")
  })
})
