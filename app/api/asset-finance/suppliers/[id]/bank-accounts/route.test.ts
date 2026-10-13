import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({
  flag: { on: true },
  findSupplier: vi.fn(),
  create: vi.fn(),
  requireApiRole: vi.fn(),
  logAuditStrict: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    supplier: { findFirst: m.findSupplier },
    $transaction: (fn: (tx: unknown) => unknown) => fn({ supplierBankAccount: { create: m.create } }),
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

import { POST } from "./route"

const signIn = (id: string, role: string) =>
  m.requireApiRole.mockResolvedValue({ user: { id, email: `${id}@lender.test`, role, tenantId: "tenant-1" } })
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/asset-finance/suppliers/sup-1/bank-accounts", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "sup-1" }) })
const account = { bankName: "TEST Bank", branchCode: "250655", accountNumber: "62000000001", accountHolder: "TEST Plant Sales" }

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  signIn("officer-a", "CREDIT_OFFICER")
  m.findSupplier.mockResolvedValue({ active: true })
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "acc-1", ...data }))
})

describe("POST /api/asset-finance/suppliers/[id]/bank-accounts", () => {
  it("answers 404 when the flag is off", async () => {
    m.flag.on = false
    expect((await post(account)).status).toBe(404)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("refuses a user without manage_asset_finance 403", async () => {
    signIn("viewer", "READONLY")
    expect((await post(account)).status).toBe(403)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("answers 400 for an invalid branch code", async () => {
    expect((await post({ ...account, branchCode: "12" })).status).toBe(400)
  })

  it("answers 404 for another tenant's supplier and 409 for an inactive one", async () => {
    m.findSupplier.mockResolvedValue(null)
    expect((await post(account)).status).toBe(404)
    expect(m.findSupplier).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "sup-1", tenantId: "tenant-1" } }))
    m.findSupplier.mockResolvedValue({ active: false })
    expect((await post(account)).status).toBe(409)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("creates a PENDING request attributed to the requester and audits it without the full account number", async () => {
    expect((await post(account)).status).toBe(201)
    expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      tenantId: "tenant-1", supplierId: "sup-1", status: "PENDING", requestedById: "officer-a", accountNumber: "62000000001",
    }) })
    const audit = m.logAuditStrict.mock.calls[0][0]
    expect(audit).toMatchObject({ action: "SUPPLIER_BANK_ACCOUNT_REQUESTED", entityId: "acc-1", newValue: { accountNumberLast4: "0001" } })
    expect(JSON.stringify(audit)).not.toContain("62000000001")
  })
})
