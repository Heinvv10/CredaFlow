import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> }, quote: vi.fn(), allowed: true }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }) }))
vi.mock("@/lib/non-nca-documents/pre-submission", () => ({ issueIndicativeKeyFacts: h.quote }))
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), checkRateLimit: async () => ({ allowed: h.allowed, retryAfterSeconds: 60 }) }))

import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { POST } from "./route"

const client = { user: { id: "c1", role: "CLIENT", email: "b@x.invalid", tenantId: "t1" } }
const call = (body: unknown = { productCode: "P", amount: 1500 }) => POST(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }))

describe("POST /api/portal/key-facts-quote", () => {
  beforeEach(() => {
    h.quote.mockReset(); h.quote.mockResolvedValue({ ok: true, sha256: "a" }); h.allowed = true; h.session = client
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
  })
  afterEach(() => resetActiveJurisdiction())

  it("is for the signed-in borrower: no session and staff are refused", async () => {
    h.session = null
    expect((await call()).status).toBe(401)
    h.session = { user: { id: "u1", role: "ADMIN", tenantId: "t1" } }
    expect((await call()).status).toBe(401)
    expect(h.quote).not.toHaveBeenCalled()
  })

  it("is rate limited: each statement is a real render", async () => {
    h.allowed = false
    const res = await call()
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("60")
    expect(h.quote).not.toHaveBeenCalled()
  })

  it("is refused on a South African lender", async () => {
    setActiveJurisdiction({ jurisdiction: "ZA", currency: "ZAR" })
    expect((await call()).status).toBe(409)
    expect(h.quote).not.toHaveBeenCalled()
  })

  it("issues in the borrower's name, in cents", async () => {
    expect((await call()).status).toBe(201)
    expect(h.quote).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", clientId: "c1", actor: { type: "client", clientId: "c1", email: "b@x.invalid" }, productCode: "P", amountCents: 150_000 }))
  })

  it("refuses an amount that is not a positive number", async () => {
    expect((await call({ productCode: "P", amount: -1 })).status).toBe(400)
  })
})
