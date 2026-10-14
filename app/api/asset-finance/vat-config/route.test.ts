import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// VAT vendor details: ADMIN only, the asset-finance flag gate, SA VAT number
// format, audited with old and new values.
const m = vi.hoisted(() => ({
  session: { role: "ADMIN" as string },
  flag: { on: true },
  findUnique: vi.fn(),
  upsert: vi.fn(),
  logAuditStrict: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "admin-1", email: "admin@lender.test", role: m.session.role, tenantId: "tenant-1" } })),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    vatConfig: { findUnique: m.findUnique },
    $transaction: (fn: (tx: unknown) => unknown) => fn({ vatConfig: { findUnique: m.findUnique, upsert: m.upsert } }),
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))

import { GET, PUT } from "./route"

const details = { vatNumber: "4123456789", registeredName: "TEST Lender (Pty) Ltd", address: "1 Test Street, Testville" }
const put = (body: unknown) => PUT(new NextRequest("http://localhost/api/asset-finance/vat-config", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}))

beforeEach(() => {
  vi.clearAllMocks()
  m.session.role = "ADMIN"
  m.flag.on = true
  m.findUnique.mockResolvedValue({ vatNumber: "4999999999", registeredName: "TEST Old Name", address: "Old address" })
  m.upsert.mockImplementation(async ({ update }: { update: Record<string, unknown> }) => ({ ...update, updatedAt: new Date() }))
})

describe("/api/asset-finance/vat-config", () => {
  it("answers 404 while asset finance is off", async () => {
    m.flag.on = false
    expect((await put(details)).status).toBe(404)
    expect((await GET(new NextRequest("http://localhost/api/asset-finance/vat-config"))).status).toBe(404)
    expect(m.upsert).not.toHaveBeenCalled()
  })

  it.each(["LOAN_ADMIN", "CREDIT_OFFICER"])("refuses %s 403", async (role) => {
    m.session.role = role
    expect((await put(details)).status).toBe(403)
    expect(m.upsert).not.toHaveBeenCalled()
  })

  it("refuses a VAT number that is not ten digits starting with 4, 400", async () => {
    const res = await put({ ...details, vatNumber: "5123456789" })
    expect(res.status).toBe(400)
    expect((await res.json()).fields.vatNumber).toMatch(/starting with 4/)
    expect(m.upsert).not.toHaveBeenCalled()
  })

  it("saves the tenant's details and audits the old and new values in the same transaction", async () => {
    const res = await put(details)
    expect(res.status).toBe(200)
    expect(m.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1" }, update: details, create: { tenantId: "tenant-1", ...details },
    }))
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "VAT_CONFIG_UPDATED", entity: "VatConfig", entityId: "tenant-1", userId: "admin-1",
      oldValue: { vatNumber: "4999999999", registeredName: "TEST Old Name", address: "Old address" },
      newValue: details,
    }), expect.anything())
  })
})
