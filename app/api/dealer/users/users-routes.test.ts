import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// DEALER_ADMIN user management through the real guard and lib/dealer/users.ts:
// an admin creates DEALER_SALES users only, gets a one-time link (never in the
// audit row), deactivates a user of its own dealer (tokenVersion bumped, link
// cleared, audited) and never itself; another dealer's user is 404.
const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  tx: {
    dealer: { findFirst: vi.fn() },
    dealerUser: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  },
  audit: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true }) },
    dealerUser: h.tx.dealerUser,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(h.tx),
  },
}))
vi.mock("@/lib/tenant", () => ({
  getTenantFromRequest: async () => ({ id: "tenant-1", slug: "lender", name: "Lender", domain: null, status: "ACTIVE" }),
  withTenantContext: async (_req: Request, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/audit", () => ({ AuditAction: { DEALER_USER_CREATED: "DEALER_USER_CREATED", DEALER_USER_DEACTIVATED: "DEALER_USER_DEACTIVATED" }, logAuditStrict: h.audit }))
vi.mock("@/lib/config/deployment-urls", () => ({ requireDealerBaseUrl: () => "https://dealers.lender.example" }))

import { GET, POST } from "./route"
import { POST as DEACTIVATE } from "./[id]/deactivate/route"

const ADMIN = { id: "du-1", email: "admin@dealer.example", role: "DEALER", tenantId: "tenant-1", dealerId: "dealer-1", dealerRole: "DEALER_ADMIN" }
const req = (body?: unknown) => new NextRequest("https://dealers.lender.example/api/dealer/users", {
  method: body === undefined ? "GET" : "POST",
  body: body === undefined ? undefined : JSON.stringify(body),
  headers: { host: "dealers.lender.example", "sec-fetch-site": "same-origin", "content-type": "application/json" },
})
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  h.session = { user: { ...ADMIN } }
  h.tx.dealer.findFirst.mockResolvedValue({ id: "dealer-1", active: true })
  h.tx.dealerUser.create.mockResolvedValue({ id: "du-2" })
  h.tx.dealerUser.update.mockResolvedValue({})
})

describe("POST /api/dealer/users", () => {
  it("creates a sales user of the admin's own dealer and returns its one-time link", async () => {
    const res = await POST(req({ email: "New@Dealer.example", name: "New Sales", role: "DEALER_SALES" }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBe("du-2")
    expect(body.setPasswordUrl).toMatch(/^https:\/\/dealers\.lender\.example\/dealer\/set-password\?token=[0-9a-f]{64}$/)
    expect(h.tx.dealerUser.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: "tenant-1", dealerId: "dealer-1", email: "new@dealer.example", role: "DEALER_SALES", createdByDealerUserId: "du-1", createdByUserId: null }),
    }))
    const token = new URL(body.setPasswordUrl).searchParams.get("token")!
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "DEALER_USER_CREATED", userId: undefined, userEmail: "admin@dealer.example" }), h.tx)
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(token)
  })

  it("refuses to create a DEALER_ADMIN (the lender adds admins), writing nothing", async () => {
    const res = await POST(req({ email: "boss@dealer.example", name: "Boss", role: "DEALER_ADMIN" }))
    expect(res.status).toBe(400)
    expect((await res.json()).fields).toHaveProperty("role")
    expect(h.tx.dealerUser.create).not.toHaveBeenCalled()
  })

  it("answers 400 with the field errors for a bad body", async () => {
    const res = await POST(req({ email: "not-an-email", name: "", role: "DEALER_SALES" }))
    expect(res.status).toBe(400)
    expect(Object.keys((await res.json()).fields).sort()).toEqual(["email", "name"])
  })
})

describe("GET /api/dealer/users", () => {
  it("lists the admin's own dealer's users without hashes or tokens", async () => {
    h.tx.dealerUser.findMany.mockResolvedValue([{
      id: "du-2", email: "s@dealer.example", name: "S", role: "DEALER_SALES", active: true, lastLoginAt: null,
      createdAt: new Date("2026-10-01T00:00:00Z"), passwordHash: "$2a$12$secret", setPasswordTokenExp: new Date(Date.now() + 3_600_000),
    }])
    const res = await GET(req())
    const text = await res.text()
    expect(text).not.toContain("$2a$12$secret")
    expect(JSON.parse(text)).toEqual([expect.objectContaining({ id: "du-2", passwordSet: true, linkPending: true })])
    expect(h.tx.dealerUser.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1", dealerId: "dealer-1" } }))
  })
})

describe("POST /api/dealer/users/[id]/deactivate", () => {
  it("deactivates a user of the admin's dealer: tokenVersion bumped, link cleared, audited", async () => {
    h.tx.dealerUser.findFirst.mockResolvedValue({ id: "du-2", active: true })
    const res = await DEACTIVATE(req({}), ctx("du-2"))
    expect(res.status).toBe(200)
    expect(h.tx.dealerUser.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "du-2", tenantId: "tenant-1", dealerId: "dealer-1" } }))
    expect(h.tx.dealerUser.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { active: false, setPasswordTokenHash: null, setPasswordTokenExp: null, tokenVersion: { increment: 1 } },
    }))
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "DEALER_USER_DEACTIVATED", entityId: "du-2" }), h.tx)
  })

  it("is 404 for a user of another dealer", async () => {
    h.tx.dealerUser.findFirst.mockResolvedValue(null)
    expect((await DEACTIVATE(req({}), ctx("du-other"))).status).toBe(404)
    expect(h.tx.dealerUser.update).not.toHaveBeenCalled()
  })

  it("refuses the admin's own user (409)", async () => {
    expect((await DEACTIVATE(req({}), ctx("du-1"))).status).toBe(409)
    expect(h.tx.dealerUser.update).not.toHaveBeenCalled()
  })
})
