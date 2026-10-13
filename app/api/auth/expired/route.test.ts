import { afterEach, describe, it, expect, vi } from "vitest"
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

  // Browsers read "/\" as "//": a backslash anywhere, however it arrives, must
  // not survive into the Location. Each lands on the staff /login with the
  // default destination.
  it.each([
    ["a literal backslash", "callbackUrl=" + encodeURIComponent("/\\evil.example")],
    ["a %5C-encoded backslash", "callbackUrl=/%5Cevil.example"],
    ["a double-encoded backslash", "callbackUrl=" + encodeURIComponent("/%5Cevil.example")],
    ["a protocol-relative URL", "callbackUrl=" + encodeURIComponent("//evil")],
    ["an absolute URL", "callbackUrl=" + encodeURIComponent("https://evil")],
    ["a tab before the slashes", "callbackUrl=" + encodeURIComponent("/\t/evil.example")],
  ])("refuses %s → staff /login, callbackUrl /dashboard", (_label, query) => {
    const res = call(`${ORIGIN}/api/auth/expired?${query}`)
    const { raw, url } = location(res)
    expect(raw.startsWith("/login?")).toBe(true)
    expect(url.origin).toBe(ORIGIN)
    expect(url.searchParams.get("callbackUrl")).toBe("/dashboard")
    expect(raw).not.toMatch(/evil/)
  })

  it.each(["/loans/123", "/clients/abc-1/edit"])("keeps the valid internal path %s", (dest) => {
    const res = call(`${ORIGIN}/api/auth/expired?callbackUrl=${encodeURIComponent(dest)}`)
    expect(location(res).url.searchParams.get("callbackUrl")).toBe(dest)
  })

  // A client cannot sign in on the staff form. The cookie is cleared in the
  // same response, so /portal/login renders its form instead of sending the
  // client back to /portal (app/portal/login/page.test.tsx: no session → form).
  it.each(["/portal", "/portal/loans/123"])("sends a portal destination (%s) to /portal/login, cookie cleared", (dest) => {
    const res = call(`${ORIGIN}/api/auth/expired?callbackUrl=${encodeURIComponent(dest)}`)
    expect(res.status).toBe(307)
    const { raw, url } = location(res)
    expect(raw.startsWith("/portal/login")).toBe(true)
    expect(url.pathname).toBe("/portal/login")
    expect(url.searchParams.get("callbackUrl")).toBe(dest)
    expect(res.cookies.get(COOKIE)?.maxAge).toBe(0)
  })

  it("does not treat a path that merely starts with the letters 'portal' as the portal", () => {
    const res = call(`${ORIGIN}/api/auth/expired?callbackUrl=${encodeURIComponent("/portalx")}`)
    expect(location(res).url.pathname).toBe("/login")
  })
})

// The client host 404s /login (proxy.ts), so there every redirect goes to the
// portal sign-in and no destination outside the portal survives.
describe("GET /api/auth/expired on the client host (APP_MODE=client)", () => {
  afterEach(() => vi.unstubAllEnvs())

  const target = (query: string) => {
    vi.stubEnv("APP_MODE", "client")
    const res = call(`${ORIGIN}/api/auth/expired${query}`)
    return { res, ...location(res) }
  }

  it("with no callbackUrl goes to /portal/login with callbackUrl=/portal", () => {
    const { res, raw, url } = target("")
    expect(res.status).toBe(307)
    expect(raw).toBe("/portal/login?callbackUrl=%2Fportal")
    expect(url.pathname).toBe("/portal/login")
    expect(res.cookies.get(COOKIE)?.maxAge).toBe(0)
  })

  it.each(["/portal", "/portal/loans", "/portal/applications/abc123"])("keeps the portal destination %s", (dest) => {
    expect(target(`?callbackUrl=${encodeURIComponent(dest)}`).raw).toBe(
      `/portal/login?callbackUrl=${encodeURIComponent(dest)}`,
    )
  })

  it.each(["/dashboard", "/settings/users", "/portalx", "/login", "/"])(
    "sends the non-portal destination %s to the portal home",
    (dest) => {
      expect(target(`?callbackUrl=${encodeURIComponent(dest)}`).raw).toBe("/portal/login?callbackUrl=%2Fportal")
    },
  )

  it.each(["//evil.example", "/\\evil.example", "https://evil.example/portal", "/portal/../dashboard", "/portal?x=1"])(
    "sends the rejected callbackUrl %j to the portal home",
    (dest) => {
      expect(target(`?callbackUrl=${encodeURIComponent(dest)}`).raw).toBe("/portal/login?callbackUrl=%2Fportal")
    },
  )

  it.each(["staff", "all"])("APP_MODE=%s keeps the staff behaviour (no callbackUrl → /login, /dashboard)", (mode) => {
    vi.stubEnv("APP_MODE", mode)
    expect(location(call(`${ORIGIN}/api/auth/expired`)).raw).toBe("/login?callbackUrl=%2Fdashboard")
  })
})
