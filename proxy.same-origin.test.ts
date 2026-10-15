import { afterEach, describe, expect, it, vi } from "vitest"
import type { NextAuthRequest } from "next-auth"
import { NextRequest } from "next/server"

// auth(handler) normally returns a session-aware wrapper; return the handler
// itself so the real routing logic runs against a plain request.
vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))

import proxy from "./proxy"

const run = proxy as unknown as (req: NextAuthRequest) => Promise<Response> | Response

// Every lender sits under one registrable domain, so a sibling lender's host is
// "same-site": SameSite=lax cookies ride its requests. Only the host itself may write.
const HOST = "acme.credaflow.example"
const SIBLING = "https://evil.credaflow.example"

const OFFICER = { user: { id: "u1", role: "LOAN_ADMIN", tenantId: "t1", totpEnrolmentRequired: false } }
const CLIENT = { user: { id: "c1", role: "CLIENT", tenantId: "t1" } }

function send(path: string, headers: Record<string, string>, opts: { method?: string; session?: unknown } = {}) {
  const req = new NextRequest(`https://${HOST}${path}`, {
    method: opts.method ?? "POST",
    headers: { host: HOST, ...headers },
  })
  return run(Object.assign(req, { auth: opts.session === undefined ? OFFICER : opts.session }) as unknown as NextAuthRequest)
}

async function expectRefused(res: Response) {
  expect(res.status).toBe(403)
  expect(res.headers.get("x-middleware-next")).toBeNull()
}

function expectPassed(res: Response) {
  expect(res.status).toBe(200)
  expect(res.headers.get("x-middleware-next")).toBe("1")
}

afterEach(() => vi.unstubAllEnvs())

describe("cross-origin writes are refused before any other gate", () => {
  it("refuses a same-site POST that would create a staff user", async () => {
    const res = await send("/api/settings/users", { "sec-fetch-site": "same-site", origin: SIBLING })
    await expectRefused(res)
    expect(await res.json()).toEqual({ error: "Cross-origin request refused" })
  })

  it("refuses a same-site POST to a page path (a server action or form post)", async () => {
    await expectRefused(await send("/applications/app-1", { "sec-fetch-site": "same-site" }))
  })

  it("refuses a borrower's same-site POST to the portal signing API", async () => {
    await expectRefused(
      await send("/api/applications/app-1/agreement/sign", { "sec-fetch-site": "same-site" }, { session: CLIENT }),
    )
  })

  it.each(["cross-site", "same-site", "bogus", ""])("refuses Sec-Fetch-Site %j", async (site) => {
    await expectRefused(await send("/api/applications/app-1/disburse", { "sec-fetch-site": site }))
  })

  it.each(["PUT", "PATCH", "DELETE"])("refuses a same-site %s", async (method) => {
    await expectRefused(await send("/api/settings/users", { "sec-fetch-site": "same-site" }, { method }))
  })

  it("refuses before authentication: an anonymous same-site POST to a public route is still 403", async () => {
    await expectRefused(await send("/api/website/apply", { "sec-fetch-site": "same-site" }, { session: null }))
  })

  it("passes a same-origin POST", async () => {
    expectPassed(await send("/api/settings/users", { "sec-fetch-site": "same-origin", origin: `https://${HOST}` }))
  })

  it("passes Sec-Fetch-Site none (user-initiated)", async () => {
    expectPassed(await send("/api/settings/users", { "sec-fetch-site": "none" }))
  })

  it("passes a server-to-server POST that carries neither header", async () => {
    expectPassed(await send("/api/settings/users", {}))
  })

  it.each(["GET", "HEAD", "OPTIONS"])("leaves a same-site %s to the rest of the proxy", async (method) => {
    const res = await send("/api/loans", { "sec-fetch-site": "same-site" }, { method })
    expect(res.status).not.toBe(403)
  })
})

describe("Origin is checked when Sec-Fetch-Site is absent", () => {
  it("refuses a sibling Origin", async () => {
    await expectRefused(await send("/api/settings/users", { origin: SIBLING }))
  })

  it("refuses an opaque Origin", async () => {
    await expectRefused(await send("/api/settings/users", { origin: "null" }))
  })

  it("refuses the host's own name on another port", async () => {
    await expectRefused(await send("/api/settings/users", { origin: `https://${HOST}:8443` }))
  })

  it("passes the host's own Origin", async () => {
    expectPassed(await send("/api/settings/users", { origin: `https://${HOST}` }))
  })

  it("refuses a plain-http Origin in production", async () => {
    vi.stubEnv("NODE_ENV", "production")
    await expectRefused(await send("/api/settings/users", { origin: `http://${HOST}` }))
  })

  it("passes a plain-http Origin for the same host outside production (dev over http)", async () => {
    expectPassed(await send("/api/settings/users", { origin: `http://${HOST}` }))
  })

  it("never trusts X-Forwarded-Host for the expected origin", async () => {
    await expectRefused(
      await send("/api/settings/users", { origin: SIBLING, "x-forwarded-host": "evil.credaflow.example" }),
    )
  })
})

describe("exempt paths (no cookies; authenticated by signature, secret or token)", () => {
  it.each([
    "/api/webhooks/whatsapp",
    "/api/webhooks/whatsapp-cloud",
    "/api/portal/payment/webhook",
    "/api/cron/collections",
    "/api/messaging/unsubscribe",
    "/api/messaging/unsubscribe/",
    "/api/notifications/application",
    "/api/notifications/payment",
    "/api/health",
  ])("passes a cross-site POST to %s", async (path) => {
    expectPassed(await send(path, { "sec-fetch-site": "cross-site", origin: "https://provider.example" }))
  })

  it.each([
    "/api/auth/callback/credentials",
    "/api/auth/signout",
    "/api/pasq-link/tok/acknowledge",
    "/api/selfie-link/tok/capture",
    "/api/website/contact",
    "/api/portal/payment/webhook/extra",
    "/api/portal/payment/webhooks",
    "/api/notifications/read",
    "/api/messaging/unsubscribe/extra",
    "/api/healthz",
  ])("is not exempt: refuses a same-site POST to %s", async (path) => {
    await expectRefused(await send(path, { "sec-fetch-site": "same-site" }, { session: null }))
  })
})
