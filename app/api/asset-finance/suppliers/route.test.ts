import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({
  flag: { on: true },
  findMany: vi.fn(),
  create: vi.fn(),
  requireApiRole: vi.fn(),
  logAuditStrict: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    supplier: { findMany: m.findMany },
    $transaction: (fn: (tx: unknown) => unknown) => fn({ supplier: { create: m.create } }),
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) => fn({ id: "tenant-1", name: "T" }),
}))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: () => m.requireApiRole(),
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))

import { GET, POST } from "./route"

const signIn = (id: string, role: string) =>
  m.requireApiRole.mockResolvedValue({ user: { id, email: `${id}@lender.test`, role, tenantId: "tenant-1" } })
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/asset-finance/suppliers", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}))

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  signIn("officer-a", "CREDIT_OFFICER")
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sup-1", ...data }))
})

describe("/api/asset-finance/suppliers", () => {
  it("answers 404 when the flag is off", async () => {
    m.flag.on = false
    expect((await GET(new NextRequest("http://localhost/api/asset-finance/suppliers"))).status).toBe(404)
    expect((await post({ name: "TEST Plant Sales" })).status).toBe(404)
  })

  it("summarises each supplier's approved and pending accounts", async () => {
    m.findMany.mockResolvedValue([
      { id: "sup-1", name: "A", bankAccounts: [{ status: "APPROVED" }, { status: "PENDING" }, { status: "PENDING" }] },
      { id: "sup-2", name: "B", bankAccounts: [] },
    ])
    const body = await (await GET(new NextRequest("http://localhost/api/asset-finance/suppliers"))).json()
    expect(m.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1" } }))
    expect(body).toEqual([
      { id: "sup-1", name: "A", hasApprovedAccount: true, pendingAccounts: 2 },
      { id: "sup-2", name: "B", hasApprovedAccount: false, pendingAccounts: 0 },
    ])
  })

  it("refuses a user without manage_asset_finance 403", async () => {
    signIn("viewer", "READONLY")
    expect((await post({ name: "TEST Plant Sales" })).status).toBe(403)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("answers 400 for a supplier without a name", async () => {
    expect((await post({ vatNumber: "4000000001" })).status).toBe(400)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("creates the supplier in the tenant and audits it", async () => {
    expect((await post({ name: "TEST Plant Sales" })).status).toBe(201)
    expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: "TEST Plant Sales", tenantId: "tenant-1", createdById: "officer-a" }) })
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "SUPPLIER_CREATED", entityId: "sup-1" }), expect.anything())
  })
})
