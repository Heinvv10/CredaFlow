import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// proxy.ts with the edge auth wrapper as identity: `req.auth` is the session.
vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))

import proxy from "@/proxy"

type Handler = (req: NextRequest) => Response | Promise<Response>
const handler = proxy as unknown as Handler

const CONSOLE = "console.platform.example"
const STAFF_HOST = "app.lender.example"

type Session = { user: Record<string, unknown> } | null
const OPERATOR: Session = { user: { id: "op-1", role: "OPERATOR_SUPPORT", tenantId: null, operatorId: "operator-1", totpEnrolmentRequired: false } }
const OPERATOR_HELD: Session = { user: { ...OPERATOR!.user, totpEnrolmentRequired: true } }
const STAFF: Session = { user: { id: "u-1", role: "SUPER_ADMIN", tenantId: "tenant-1", totpEnrolmentRequired: false } }
const CLIENT: Session = { user: { id: "c-1", role: "CLIENT", tenantId: "tenant-1", totpEnrolmentRequired: false } }

// A write from the console's own pages: same origin, JSON. `raw` sends exactly the headers given.
function visit(host: string, pathname: string, session: Session, init: { method?: string; headers?: Record<string, string>; raw?: boolean } = {}) {
  const write = !!init.method && init.method !== "GET" && init.method !== "HEAD"
  const sameOrigin: Record<string, string> = write && !init.raw ? { origin: `https://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/json" } : {}
  const req = new NextRequest(`https://${host}${pathname}`, { method: init.method, headers: { host, ...sameOrigin, ...init.headers } }) as NextRequest & { auth: unknown }
  req.auth = session
  return handler(req)
}
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1"
const location = (res: Response) => new URL(res.headers.get("location")!).pathname

beforeEach(() => {
  vi.stubEnv("OPERATOR_APP_HOST", CONSOLE)
  vi.stubEnv("TENANT_HOST_MAP", `${STAFF_HOST}=lender`)
})
afterEach(() => vi.unstubAllEnvs())

describe("operator console host — serves the console only", () => {
  it.each(["/dashboard", "/login", "/portal", "/portal/login", "/settings/users", "/site/about", "/forgot-password", "/reset-password"])(
    "404s the lender page %s", async (path) => {
      expect((await visit(CONSOLE, path, null)).status).toBe(404)
      expect((await visit(CONSOLE, path, OPERATOR)).status).toBe(404)
    },
  )

  it.each(["/api/clients", "/api/loans", "/api/settings/support-access", "/api/portal/me", "/api/auth/forgot-password"])(
    "404s the lender API %s, even for an operator session", async (path) => {
      expect((await visit(CONSOLE, path, OPERATOR)).status).toBe(404)
    },
  )

  it("sends a visitor to the operator sign-in, and an API caller gets 401", async () => {
    const page = await visit(CONSOLE, "/operator/lenders/t1", null)
    expect(page.status).toBe(307)
    expect(location(page)).toBe("/operator/login")
    expect(new URL(page.headers.get("location")!).searchParams.get("callbackUrl")).toBe("/operator/lenders/t1")
    expect((await visit(CONSOLE, "/api/operator/users", null, { method: "POST" })).status).toBe(401)
    expect(location(await visit(CONSOLE, "/", null))).toBe("/operator")
  })

  it("serves the sign-in, set-password and NextAuth endpoints to a visitor", async () => {
    for (const path of ["/operator/login", "/operator/set-password", "/api/auth/csrf", "/api/auth/session"]) {
      expect(passes(await visit(CONSOLE, path, null)), path).toBe(true)
    }
    expect(passes(await visit(CONSOLE, "/api/auth/callback/credentials", null, { method: "POST" }))).toBe(true)
    expect(passes(await visit(CONSOLE, "/api/auth/reset-password", null, { method: "POST" }))).toBe(true)
  })

  it("refuses a lender staff or client session on the console", async () => {
    for (const s of [STAFF, CLIENT]) {
      expect((await visit(CONSOLE, "/operator", s)).status).toBe(404)
      expect((await visit(CONSOLE, "/api/operator/lenders", s, { method: "POST" })).status).toBe(404)
    }
  })

  it("holds an operator without 2FA at the enrolment page and its API", async () => {
    const page = await visit(CONSOLE, "/operator", OPERATOR_HELD)
    expect(location(page)).toBe("/operator/security")
    expect(passes(await visit(CONSOLE, "/operator/security", OPERATOR_HELD))).toBe(true)
    expect(passes(await visit(CONSOLE, "/api/operator/totp", OPERATOR_HELD, { method: "POST" }))).toBe(true)
    expect((await visit(CONSOLE, "/api/operator/lenders", OPERATOR_HELD, { method: "POST" })).status).toBe(403)
    // A token minted before the claim existed is held too.
    const legacy = { user: { id: "op-1", role: "OPERATOR_ADMIN", operatorId: "operator-1" } }
    expect(location(await visit(CONSOLE, "/operator/users", legacy))).toBe("/operator/security")
  })

  it("lets a verified operator use the console, including its management writes", async () => {
    expect(passes(await visit(CONSOLE, "/operator", OPERATOR))).toBe(true)
    expect(passes(await visit(CONSOLE, "/api/operator/lenders", OPERATOR, { method: "POST" }))).toBe(true)
    expect(passes(await visit(CONSOLE, "/api/operator/users/u1/deactivate", OPERATOR, { method: "POST" }))).toBe(true)
  })

  it("keeps support access read-only: no write to a support API, no page POST, no server action", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await visit(CONSOLE, "/api/operator/support/t1/clients", OPERATOR, { method })).status).toBe(403)
    }
    expect((await visit(CONSOLE, "/operator/lenders/t1/support", OPERATOR, { method: "POST" })).status).toBe(403)
    expect((await visit(CONSOLE, "/operator", OPERATOR, { method: "POST", headers: { "next-action": "abc" } })).status).toBe(403)
  })

  it("forwards no tenant to console code, whatever the caller sends", async () => {
    const res = await visit(CONSOLE, "/operator", OPERATOR, { headers: { "x-tenant-slug": "lender" } })
    expect(res.headers.get("x-middleware-request-x-tenant-slug")).toBeNull()
    expect(res.headers.get("x-middleware-request-x-cf-request-method")).toBe("GET")
  })
})

describe("operator console host — cross-site writes are refused (CSRF)", () => {
  const raw = (method: string, headers: Record<string, string>) => ({ method, raw: true, headers })

  it("refuses a cross-origin text/plain POST to /api/operator/users", async () => {
    const res = await visit(CONSOLE, "/api/operator/users", OPERATOR, raw("POST", { origin: "https://evil.example", "content-type": "text/plain" }))
    expect(res.status).toBe(403)
  })

  it("refuses a write whose Origin is another host or port, or whose Sec-Fetch-Site is not same-origin", async () => {
    const json = { "content-type": "application/json" }
    for (const headers of [
      { ...json, origin: "https://app.lender.example" },
      { ...json, origin: `https://${CONSOLE}:8443` },
      { ...json, origin: "null" },
      { ...json, origin: `https://${CONSOLE}`, "sec-fetch-site": "same-site" },
      { ...json, "sec-fetch-site": "cross-site" },
    ]) {
      expect((await visit(CONSOLE, "/api/operator/lenders", OPERATOR, raw("POST", headers))).status, JSON.stringify(headers)).toBe(403)
    }
  })

  it("refuses a write that carries neither Origin nor Sec-Fetch-Site, sign-in and sign-out included", async () => {
    for (const path of ["/api/operator/users", "/api/auth/callback/credentials", "/api/auth/signout", "/api/auth/reset-password"]) {
      expect((await visit(CONSOLE, path, OPERATOR, raw("POST", { "content-type": "application/json" }))).status, path).toBe(403)
    }
  })

  it("requires application/json on every /api/operator write", async () => {
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
      const res = await visit(CONSOLE, "/api/operator/users", OPERATOR, raw("POST", { origin: `https://${CONSOLE}`, ...(ct ? { "content-type": ct } : {}) }))
      expect(res.status, ct).toBe(415)
    }
    const ok = await visit(CONSOLE, "/api/operator/users", OPERATOR, raw("POST", { origin: `https://${CONSOLE}`, "content-type": "application/json; charset=utf-8" }))
    expect(passes(ok)).toBe(true)
  })

  it("lets a same-origin sign-in through (NextAuth posts a form)", async () => {
    const res = await visit(CONSOLE, "/api/auth/callback/credentials", null, raw("POST", { origin: `https://${CONSOLE}`, "content-type": "application/x-www-form-urlencoded" }))
    expect(passes(res)).toBe(true)
  })
})

describe("every other host — no console, no operator session", () => {
  it.each(["/operator", "/operator/login", "/api/operator/lenders"])("404s %s on a lender host", async (path) => {
    expect((await visit(STAFF_HOST, path, null)).status).toBe(404)
    expect((await visit(STAFF_HOST, path, STAFF)).status).toBe(404)
  })

  it("refuses an operator session on a lender host, page and API alike", async () => {
    expect((await visit(STAFF_HOST, "/dashboard", OPERATOR)).status).toBe(404)
    expect((await visit(STAFF_HOST, "/api/clients/c1", OPERATOR)).status).toBe(403)
    // It can still end the session.
    expect(passes(await visit(STAFF_HOST, "/api/auth/signout", OPERATOR, { method: "POST" }))).toBe(true)
  })

  it("has no console anywhere while OPERATOR_APP_HOST is unset", async () => {
    vi.stubEnv("OPERATOR_APP_HOST", "")
    expect((await visit(CONSOLE, "/operator", OPERATOR)).status).toBe(404)
    expect((await visit("localhost", "/operator/login", null)).status).toBe(404)
  })

  it("still serves lender staff on their own host", async () => {
    expect(passes(await visit(STAFF_HOST, "/dashboard", STAFF))).toBe(true)
  })
})
