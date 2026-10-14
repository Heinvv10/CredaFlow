import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    supplierBankAccount: { findFirst: vi.fn(), update: vi.fn() },
  }
  return {
    tx,
    flag: { on: true },
    transaction: vi.fn(),
    findAccount: vi.fn(),
    requireApiRole: vi.fn(),
    logAuditStrict: vi.fn(),
    auditRefusal: vi.fn(),
  }
})

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    supplierBankAccount: { findFirst: m.findAccount },
    $transaction: (fn: (tx: unknown) => unknown) => {
      m.transaction()
      return fn(m.tx)
    },
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
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))

import { POST } from "./route"

const signIn = (id: string, role: string) =>
  m.requireApiRole.mockResolvedValue({ user: { id, email: `${id}@lender.test`, role, tenantId: "tenant-1" } })
const decide = (body: unknown) => POST(new NextRequest("http://localhost/api/asset-finance/suppliers/bank-accounts/acc-new/decide", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ accountId: "acc-new" }) })

const pending = (over: Record<string, unknown> = {}) => ({
  id: "acc-new", tenantId: "tenant-1", supplierId: "sup-1", status: "PENDING", requestedById: "officer-a", ...over,
})
const approve = { decision: "APPROVE", note: "Bank-stamped confirmation letter dated 2026-10-10" }

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  signIn("admin-b", "LOAN_ADMIN")
  m.findAccount.mockResolvedValue({ supplierId: "sup-1" })
  m.tx.$queryRaw.mockResolvedValueOnce([{ active: true }]).mockResolvedValueOnce([{ id: "acc-new" }])
  m.tx.supplierBankAccount.findFirst.mockImplementation(async ({ where }: { where: { status?: string } }) =>
    where.status === "APPROVED" ? { id: "acc-old" } : pending())
  m.tx.supplierBankAccount.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
    ({ ...pending({ id: where.id }), ...data }))
})

describe("POST /api/asset-finance/suppliers/bank-accounts/[accountId]/decide", () => {
  it("answers 404 when the flag is off", async () => {
    m.flag.on = false
    expect((await decide(approve)).status).toBe(404)
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it("refuses a CREDIT_OFFICER 403 and audits the refusal", async () => {
    signIn("officer-c", "CREDIT_OFFICER")
    expect((await decide(approve)).status).toBe(403)
    expect(m.transaction).not.toHaveBeenCalled()
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({
      action: "SUPPLIER_BANK_ACCOUNT_DECISION_REFUSED", reason: "insufficient_role", status: 403, userId: "officer-c",
    }))
  })

  it.each(["APPROVE", "REJECT"])("refuses the requester deciding their own account (%s) 403, audited, writing nothing", async (decision) => {
    signIn("officer-a", "LOAN_ADMIN")
    const res = await decide({ decision, note: "Deciding my own request" })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/other than its requester/)
    expect(m.tx.supplierBankAccount.update).not.toHaveBeenCalled()
    expect(m.logAuditStrict).not.toHaveBeenCalled()
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({
      action: "SUPPLIER_BANK_ACCOUNT_DECISION_REFUSED", reason: "four_eyes_self_decision", userId: "officer-a", entityId: "acc-new",
    }))
  })

  it("answers 400 without a verification note", async () => {
    expect((await decide({ decision: "APPROVE", note: "ok" })).status).toBe(400)
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it("answers 404 for an account outside the tenant", async () => {
    m.findAccount.mockResolvedValue(null)
    expect((await decide(approve)).status).toBe(404)
    expect(m.findAccount).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "acc-new", tenantId: "tenant-1" } }))
  })

  it("answers 409 for an account already decided", async () => {
    m.tx.supplierBankAccount.findFirst.mockResolvedValue(pending({ status: "REJECTED" }))
    expect((await decide(approve)).status).toBe(409)
    expect(m.tx.supplierBankAccount.update).not.toHaveBeenCalled()
  })

  it("approves: supersedes the current account first, records the manual verification, audits both ids", async () => {
    const res = await decide(approve)
    expect(res.status).toBe(200)
    const updates = m.tx.supplierBankAccount.update.mock.calls.map(([arg]) => arg)
    expect(updates[0]).toEqual({ where: { id: "acc-old" }, data: { status: "SUPERSEDED" } })
    expect(updates[1]).toMatchObject({
      where: { id: "acc-new" },
      data: {
        status: "APPROVED", decidedById: "admin-b", avsPassed: null,
        avsResult: { status: "NOT_RUN", manualVerification: { note: approve.note, verifiedById: "admin-b" } },
      },
    })
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "SUPPLIER_BANK_ACCOUNT_DECIDED",
      newValue: expect.objectContaining({ status: "APPROVED", supersededAccountId: "acc-old", requestedById: "officer-a" }),
    }), m.tx)
  })

  it("rejects without touching the supplier's approved account", async () => {
    const res = await decide({ decision: "REJECT", note: "Letter does not match the account" })
    expect(res.status).toBe(200)
    expect(m.tx.supplierBankAccount.update).toHaveBeenCalledTimes(1)
    expect(m.tx.supplierBankAccount.update).toHaveBeenCalledWith({
      where: { id: "acc-new" },
      data: expect.objectContaining({ status: "REJECTED", decidedById: "admin-b", avsResult: undefined, avsPassed: null }),
    })
  })

  it("does not approve an account of an inactive supplier", async () => {
    m.tx.$queryRaw.mockReset().mockResolvedValueOnce([{ active: false }]).mockResolvedValueOnce([{ id: "acc-new" }])
    expect((await decide(approve)).status).toBe(409)
    expect(m.tx.supplierBankAccount.update).not.toHaveBeenCalled()
  })
})
