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
const LEGACY = { user: base } // a token issued before the claim existed: unknown, so held
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
    for (const [pathname, method] of [["/api/auth/signout", "POST"], ["/api/auth/session", "GET"], ["/login", "GET"]]) {
      const res = await visit(pathname, FORCED, { method })
      expect(res.status, pathname).not.toBe(403)
    }
  })

  // Next 16 progressive enhancement: a form bound to a server action posts to
  // the PAGE url with a `$ACTION_ID_<id>` field and no `next-action` header,
  // as multipart or urlencoded. The refusal keys off the method, not the body.
  describe("form posts to a page (progressive-enhancement server actions)", () => {
    const multipart = () => {
      const form = new FormData()
      form.set("$ACTION_ID_abc123", "")
      form.set("file", new Blob(["synthetic,csv"]), "statement.csv")
      return { method: "POST", body: form }
    }
    const urlencoded = () => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "$ACTION_ID_abc123=&amount=1",
    })
    const PAGES_TO_TRY = ["/settings/security", "/payments/bank-reconciliation", "/dashboard", "/", "/site/apply"]

    it.each(PAGES_TO_TRY)("refuses a multipart $ACTION_ID post to %s", async (pathname) => {
      const res = await visit(pathname, FORCED, multipart())
      expect(res.status).toBe(403)
      expect(res.headers.get("x-middleware-next")).toBeNull()
    })

    it.each(PAGES_TO_TRY)("refuses a urlencoded $ACTION_ID post to %s", async (pathname) => {
      expect((await visit(pathname, FORCED, urlencoded())).status).toBe(403)
    })

    it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("refuses a bare %s to the enrolment page and to another page", async (method) => {
      for (const pathname of ["/settings/security", "/loans"]) {
        expect((await visit(pathname, FORCED, { method })).status, `${method} ${pathname}`).toBe(403)
      }
    })

    it("still lets a held user read the enrolment page (GET and HEAD)", async () => {
      for (const method of ["GET", "HEAD"]) {
        expect((await visit("/settings/security", FORCED, { method })).headers.get("x-middleware-next"), method).toBe("1")
      }
    })

    it("holds a staff token with no claim the same way", async () => {
      expect((await visit("/payments/bank-reconciliation", LEGACY, multipart())).status).toBe(403)
    })

    // The matcher once skipped any path ending in an image extension, so a
    // write to /x/y.png never reached the proxy.
    it.each(["/x/y.png", "/crm/leads/abc.png", "/a/b.jpg", "/a/b.jpeg", "/a/b.webp", "/a/b.svg", "/a/b.ico"])(
      "refuses a held session's POST to the image-suffixed path %s", async (pathname) => {
        expect((await visit(pathname, FORCED, multipart())).status).toBe(403)
        expect((await visit(pathname, FORCED, { method: "PUT" })).status).toBe(403)
        expect((await visit(pathname, LEGACY, urlencoded())).status).toBe(403)
      })

    it("still serves a plain image read to everyone, held or not, without a session lookup", async () => {
      for (const session of [FORCED, FREE, LEGACY, null]) {
        const res = await visit("/brand/logo.png", session)
        expect(res.headers.get("x-middleware-next")).toBe("1")
      }
    })

    it("does not touch a form post from a session that is not held", async () => {
      expect((await visit("/payments/bank-reconciliation", FREE, multipart())).headers.get("x-middleware-next")).toBe("1")
    })
  })

  it("does not touch a user the lender does not force", async () => {
    for (const pathname of [...PAGES, ...APIS]) {
      const res = await visit(pathname, FREE)
      expect(res.headers.get("x-middleware-next"), pathname).toBe("1")
    }
  })

  // The claim is read from the cookie. A staff token without one predates the
  // policy and says nothing: it is held, never waved through.
  it("holds a staff token that carries no claim", async () => {
    expect((await visit("/dashboard", LEGACY)).status).toBe(307)
    expect((await visit("/api/loans", LEGACY)).status).toBe(403)
  })

  // Only the exact enrolment page and API are allowed; every other spelling is
  // held (or, for a path the router would resolve elsewhere, never allowed here).
  it.each([
    "/settings/security/../users",
    "/settings/security/%2e%2e/users",
    "/settings/security%2Fx",
    "/settings/securityx",
    "/settings/security-policy",
    "/settings/security/extra",
    "/SETTINGS/security",
    "/settings//security/users",
    "/settings/security.json",
  ])("holds a forced user at the look-alike page %s", async (pathname) => {
    const res = await visit(pathname, FORCED)
    expect(res.headers.get("x-middleware-next"), pathname).not.toBe("1")
  })

  it.each([
    "/api/settings/totp/../users",
    "/api/settings/totp%2F..%2Fusers",
    "/api/settings/totpx",
    "/api/settings/totp/extra",
    "/API/settings/users",
  ])("holds a forced user at the look-alike API %s", async (pathname) => {
    const res = await visit(pathname, FORCED, { method: "POST" })
    expect(res.headers.get("x-middleware-next"), pathname).not.toBe("1")
  })

  it("does not touch a CLIENT token that carries no claim (client tokens never do)", async () => {
    const noClaim = { user: { id: "client-1", role: "CLIENT", tenantId: "tenant-1" } }
    expect((await visit("/api/portal/loans", noClaim)).headers.get("x-middleware-next")).toBe("1")
    expect((await visit("/portal", noClaim, { method: "POST" })).status).not.toBe(403)
  })

  it("refuses a request carrying the next-action header whatever its method", async () => {
    for (const pathname of ["/settings/security", "/dashboard"]) {
      expect((await visit(pathname, FORCED, { method: "GET", headers: { "next-action": "abc123" } })).status, pathname).toBe(403)
    }
  })

  it("does not touch a CLIENT session", async () => {
    expect((await visit("/api/portal/loans", CLIENT)).headers.get("x-middleware-next")).toBe("1")
  })

  it("still sends an anonymous visitor to sign in", async () => {
    expect((await visit("/dashboard", null)).status).toBe(307)
    expect((await visit("/api/loans", null)).status).toBe(401)
  })
})
