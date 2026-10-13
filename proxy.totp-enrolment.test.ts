import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// proxy.ts wraps its handler in the edge auth; with the wrapper as identity
// the default export IS the handler, and `req.auth` is the session it reads.
vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))

import proxy from "./proxy"

type Handler = (req: NextRequest) => Response | Promise<Response>
const handler = proxy as unknown as Handler

const base = { id: "user-1", role: "CREDIT_OFFICER", tenantId: "tenant-1" }
const FORCED = { user: { ...base, totpEnrolmentRequired: true } }
const FREE = { user: { ...base, totpEnrolmentRequired: false } }
const LEGACY = { user: base } // a token issued before the claim existed
const CLIENT = { user: { id: "client-1", role: "CLIENT", tenantId: "tenant-1", totpEnrolmentRequired: false } }

function visit(pathname: string, session: { user: Record<string, unknown> } | null, init: { method?: string; headers?: Record<string, string> } = {}) {
  const req = new NextRequest(`http://localhost${pathname}`, init) as NextRequest & { auth: unknown }
  req.auth = session
  return handler(req)
}

const PAGES = ["/dashboard", "/loans", "/applications/app-1", "/settings", "/settings/users", "/settings/security-policy", "/settings/identity", "/compliance/dsar"]
const APIS = ["/api/loans", "/api/settings/users", "/api/settings/identity", "/api/applications/app-1/decide", "/api/documents/doc-1", "/api/settings/totp/extra"]

describe("forced TOTP enrolment (session.user.totpEnrolmentRequired)", () => {
  it.each(PAGES)("sends a forced user from page %s to the enrolment page", async (pathname) => {
    const res = await visit(pathname, FORCED)
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/settings/security")
  })

  it.each(APIS)("answers a forced user's API call to %s with 403", async (pathname) => {
    const res = await visit(pathname, FORCED)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Two-factor enrolment required", code: "totp_enrolment_required" })
  })

  it.each(["POST", "PATCH", "PUT", "DELETE"])("refuses a forced user's %s to a staff API", async (method) => {
    expect((await visit("/api/settings/users", FORCED, { method })).status).toBe(403)
  })

  it("lets a forced user reach the enrolment page and the enrolment API", async () => {
    for (const [pathname, method] of [["/settings/security", "GET"], ["/settings/security/", "GET"], ["/api/settings/totp", "GET"], ["/api/settings/totp", "POST"]]) {
      const res = await visit(pathname, FORCED, { method })
      expect(res.headers.get("x-middleware-next"), `${method} ${pathname}`).toBe("1")
    }
  })

  it("does not let a forced user disable TOTP through the enrolment API", async () => {
    expect((await visit("/api/settings/totp", FORCED, { method: "DELETE" })).status).toBe(403)
  })

  // A server action is a POST to a page URL; its id is not tied to the page.
  it("refuses a server action even on the enrolment page", async () => {
    for (const pathname of ["/settings/security", "/dashboard"]) {
      const res = await visit(pathname, FORCED, { method: "POST", headers: { "next-action": "abc123" } })
      expect(res.status).toBe(403)
    }
  })

  it("keeps the sign-in and sign-out routes open", async () => {
    for (const pathname of ["/api/auth/signout", "/api/auth/session", "/login"]) {
      const res = await visit(pathname, FORCED, { method: "POST" })
      expect(res.status, pathname).not.toBe(403)
    }
  })

  it.each([["a user the lender does not force", FREE], ["a token issued before the claim existed", LEGACY]])(
    "does not touch %s",
    async (_label, session) => {
      for (const pathname of [...PAGES, ...APIS]) {
        const res = await visit(pathname, session)
        expect(res.headers.get("x-middleware-next"), pathname).toBe("1")
      }
    },
  )

  it("does not touch a CLIENT session", async () => {
    expect((await visit("/api/portal/loans", CLIENT)).headers.get("x-middleware-next")).toBe("1")
  })

  it("still sends an anonymous visitor to sign in", async () => {
    expect((await visit("/dashboard", null)).status).toBe(307)
    expect((await visit("/api/loans", null)).status).toBe(401)
  })
})
