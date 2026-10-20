import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// proxy.ts with the edge auth wrapper as identity: `req.auth` is the session.
vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))

import proxy from "@/proxy"
import { dealerHostGate } from "./dealer-host"
import { dealerAppHost, DeploymentConfigError } from "@/lib/config/deployment-urls"

type Handler = (req: NextRequest) => Response | Promise<Response>
const handler = proxy as unknown as Handler

const DEALER_HOST = "dealers.lender.example"
const STAFF_HOST = "app.lender.example"
const PORTAL_HOST = "portal.lender.example"
const CONSOLE = "console.platform.example"

type Session = { user: Record<string, unknown> } | null
const DEALER: Session = { user: { id: "du-1", role: "DEALER", tenantId: "tenant-1", dealerId: "dealer-1", dealerRole: "DEALER_SALES", totpEnrolmentRequired: false } }
const STAFF: Session = { user: { id: "u-1", role: "SUPER_ADMIN", tenantId: "tenant-1", totpEnrolmentRequired: false } }
const CLIENT: Session = { user: { id: "c-1", role: "CLIENT", tenantId: "tenant-1", totpEnrolmentRequired: false } }
const OPERATOR: Session = { user: { id: "op-1", role: "OPERATOR_SUPPORT", tenantId: null, operatorId: "operator-1", totpEnrolmentRequired: false } }

// A write from the portal's own pages carries Origin and Sec-Fetch-Site; `raw` sends exactly the headers given.
function visit(host: string, pathname: string, session: Session, init: { method?: string; headers?: Record<string, string>; raw?: boolean } = {}) {
  const write = !!init.method && init.method !== "GET" && init.method !== "HEAD"
  const sameOrigin: Record<string, string> = write && !init.raw ? { origin: `https://${host}`, "sec-fetch-site": "same-origin" } : {}
  const req = new NextRequest(`https://${host}${pathname}`, { method: init.method, headers: { host, ...sameOrigin, ...init.headers } }) as NextRequest & { auth: unknown }
  req.auth = session
  return handler(req)
}
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1"
const location = (res: Response) => new URL(res.headers.get("location")!).pathname

beforeEach(() => {
  vi.stubEnv("DEALER_APP_HOST", DEALER_HOST)
  vi.stubEnv("OPERATOR_APP_HOST", CONSOLE)
  vi.stubEnv("STAFF_APP_HOST", STAFF_HOST)
  vi.stubEnv("TENANT_HOST_MAP", `${STAFF_HOST}=lender,${DEALER_HOST}=lender,${PORTAL_HOST}=lender`)
})
afterEach(() => vi.unstubAllEnvs())

describe("dealer host — serves the dealer portal only", () => {
  it.each(["/dashboard", "/login", "/portal", "/portal/login", "/settings/users", "/site/about", "/operator", "/reset-password", "/pasq/x"])(
    "404s the page %s to a visitor and a dealer", async (path) => {
      expect((await visit(DEALER_HOST, path, null)).status).toBe(404)
      expect((await visit(DEALER_HOST, path, DEALER)).status).toBe(404)
    },
  )

  it.each(["/api/clients", "/api/asset-finance/deals", "/api/portal/me", "/api/operator/lenders", "/api/auth/forgot-password", "/api/v1/loans"])(
    "404s the API %s, even for a dealer session", async (path) => {
      expect((await visit(DEALER_HOST, path, DEALER)).status).toBe(404)
    },
  )

  it("sends a visitor to the dealer sign-in, and an API caller gets 401", async () => {
    const page = await visit(DEALER_HOST, "/dealer/deals/d1", null)
    expect(page.status).toBe(307)
    expect(location(page)).toBe("/dealer/login")
    expect(new URL(page.headers.get("location")!).searchParams.get("callbackUrl")).toBe("/dealer/deals/d1")
    expect((await visit(DEALER_HOST, "/api/dealer/deals", null, { method: "POST" })).status).toBe(401)
    expect(location(await visit(DEALER_HOST, "/", null))).toBe("/dealer")
  })

  it("serves the sign-in, set-password and NextAuth endpoints to a visitor", async () => {
    for (const path of ["/dealer/login", "/dealer/set-password", "/api/auth/csrf", "/api/auth/session"]) {
      expect(passes(await visit(DEALER_HOST, path, null)), path).toBe(true)
    }
    expect(passes(await visit(DEALER_HOST, "/api/auth/callback/credentials", null, { method: "POST" }))).toBe(true)
    expect(passes(await visit(DEALER_HOST, "/api/dealer/set-password", null, { method: "POST" }))).toBe(true)
  })

  it("refuses a staff or client session on the dealer paths (404)", async () => {
    for (const s of [STAFF, CLIENT]) {
      expect((await visit(DEALER_HOST, "/dealer", s)).status).toBe(404)
      expect((await visit(DEALER_HOST, "/api/dealer/deals", s)).status).toBe(404)
      expect((await visit(DEALER_HOST, "/api/dealer/deals", s, { method: "POST" })).status).toBe(404)
    }
  })

  it("refuses an operator session there before the dealer gate (operator off-host rule)", async () => {
    expect((await visit(DEALER_HOST, "/dealer", OPERATOR)).status).toBe(404)
    expect((await visit(DEALER_HOST, "/api/dealer/deals", OPERATOR)).status).toBe(403)
  })

  it("serves a dealer session its portal, forwarding the host's tenant slug", async () => {
    const page = await visit(DEALER_HOST, "/dealer", DEALER)
    expect(passes(page)).toBe(true)
    expect(page.headers.get("x-middleware-request-x-tenant-slug")).toBe("lender")
    const api = await visit(DEALER_HOST, "/api/dealer/deals", DEALER, { method: "POST", headers: { "x-tenant-slug": "other" } })
    expect(passes(api)).toBe(true)
    expect(api.headers.get("x-middleware-request-x-tenant-slug")).toBe("lender")
    expect(location(await visit(DEALER_HOST, "/dealer/login", DEALER))).toBe("/dealer")
  })

  it("refuses a server action, a page write, and a write that does not say it is same-origin", async () => {
    expect((await visit(DEALER_HOST, "/dealer", DEALER, { method: "POST", headers: { "next-action": "abc" } })).status).toBe(403)
    expect((await visit(DEALER_HOST, "/dealer/deals/new", DEALER, { method: "POST" })).status).toBe(403)
    expect((await visit(DEALER_HOST, "/api/dealer/deals", DEALER, { method: "POST", raw: true })).status).toBe(403)
    expect((await visit(DEALER_HOST, "/api/dealer/deals", DEALER, {
      method: "POST", raw: true, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    })).status).toBe(403)
  })

  it("404s everything on a host that resolves no lender", async () => {
    vi.stubEnv("DEALER_APP_HOST", "dealer.example")
    expect((await visit("dealer.example", "/dealer", DEALER)).status).toBe(404)
    expect((await visit("dealer.example", "/dealer/login", null)).status).toBe(404)
  })

  it("never serves the portal from a client-audience container", () => {
    const req = new NextRequest(`https://${DEALER_HOST}/dealer`, { headers: { host: DEALER_HOST } })
    const forward = new Headers({ "x-tenant-slug": "lender" })
    expect(dealerHostGate(req, DEALER, forward, "client").status).toBe(404)
    expect(dealerHostGate(new NextRequest(`https://${DEALER_HOST}/dealer/login`, { headers: { host: DEALER_HOST } }), null, forward, "client").status).toBe(404)
  })
})

describe("off the dealer host", () => {
  it.each([STAFF_HOST, PORTAL_HOST, CONSOLE])("404s the dealer paths on %s", async (host) => {
    for (const path of ["/dealer", "/dealer/login", "/dealer/set-password", "/api/dealer/deals", "/api/dealer/set-password"]) {
      expect((await visit(host, path, null)).status, path).toBe(404)
      expect((await visit(host, path, DEALER)).status, path).toBe(404)
    }
  })

  it("refuses a dealer session on the staff host and the portal, except NextAuth", async () => {
    expect((await visit(STAFF_HOST, "/dashboard", DEALER)).status).toBe(404)
    expect((await visit(STAFF_HOST, "/api/clients", DEALER)).status).toBe(403)
    expect((await visit(STAFF_HOST, "/api/documents/d1/view", DEALER)).status).toBe(403)
    expect((await visit(PORTAL_HOST, "/portal", DEALER)).status).toBe(404)
    expect((await visit(PORTAL_HOST, "/api/portal/me", DEALER)).status).toBe(403)
    expect(passes(await visit(STAFF_HOST, "/api/auth/session", DEALER))).toBe(true)
    expect(passes(await visit(STAFF_HOST, "/api/auth/signout", DEALER, { method: "POST" }))).toBe(true)
  })

  it("leaves staff and client sessions on their own hosts alone", async () => {
    expect(passes(await visit(STAFF_HOST, "/dashboard", STAFF))).toBe(true)
  })

  it("with DEALER_APP_HOST unset, 404s the dealer paths and refuses a dealer session everywhere", async () => {
    vi.stubEnv("DEALER_APP_HOST", "")
    expect((await visit(DEALER_HOST, "/dealer", DEALER)).status).toBe(404)
    expect((await visit(DEALER_HOST, "/dealer/login", null)).status).toBe(404)
    expect((await visit(STAFF_HOST, "/dashboard", DEALER)).status).toBe(404)
  })
})

describe("dealerAppHost", () => {
  it("normalises the host, and is null when unset", () => {
    expect(dealerAppHost({ DEALER_APP_HOST: " Dealers.Lender.Example. " })).toBe("dealers.lender.example")
    expect(dealerAppHost({})).toBeNull()
  })

  it("refuses the staff or operator host", () => {
    expect(() => dealerAppHost({ DEALER_APP_HOST: STAFF_HOST, STAFF_APP_HOST: STAFF_HOST })).toThrow(DeploymentConfigError)
    expect(() => dealerAppHost({ DEALER_APP_HOST: CONSOLE, OPERATOR_APP_HOST: CONSOLE })).toThrow(DeploymentConfigError)
  })
})
