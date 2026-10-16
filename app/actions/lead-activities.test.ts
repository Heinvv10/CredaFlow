import { describe, it, expect, vi, beforeEach } from "vitest"

const requireMinRoleMock = vi.fn()
const getDefaultTenantIdMock = vi.fn()
const transactionMock = vi.fn()
const logAuditMock = vi.fn()

// requireLoanBookStaff is requireMinRole plus view_loan_book (lib/__tests__/auth-guards.loan-book.test.ts).
vi.mock("@/lib/auth-guards", () => ({ requireMinRole: (r: string) => requireMinRoleMock(r), requireLoanBookStaff: (r: string) => requireMinRoleMock(r) }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: () => getDefaultTenantIdMock() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (fn: (tx: unknown) => Promise<unknown>) => transactionMock(fn) },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAuditMock(a),
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { toggleLeadActivityPinned } from "./lead-activities"

function mockTx(activity: { id: string; leadId: string | null; pinned: boolean } | null) {
  const tx = {
    crmActivity: {
      findFirst: vi.fn().mockResolvedValue(activity),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn().mockResolvedValue({}),
    },
  }
  transactionMock.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
  return tx
}

describe("toggleLeadActivityPinned — tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireMinRoleMock.mockResolvedValue({ id: "u1", email: "o@acme-lending.example", tenantId: "t1" })
    getDefaultTenantIdMock.mockResolvedValue("default-tenant")
  })

  it("looks the activity up and audits under the user's tenant, not the default", async () => {
    const tx = mockTx({ id: "a1", leadId: "l1", pinned: false })

    const result = await toggleLeadActivityPinned("a1", true)

    expect(result).toEqual({ ok: true })
    expect(tx.crmActivity.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a1", tenantId: "t1" } }))
    expect(tx.crmActivity.count).toHaveBeenCalledWith({ where: { tenantId: "t1", leadId: "l1", pinned: true } })
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }))
    expect(getDefaultTenantIdMock).not.toHaveBeenCalled()
  })

  it("does not find a cross-tenant activity and writes nothing", async () => {
    const tx = mockTx(null)

    const result = await toggleLeadActivityPinned("other-tenant-activity", true)

    expect(result).toEqual({ ok: false, error: "Activity not found" })
    expect(tx.crmActivity.update).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })
})
