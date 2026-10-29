import { beforeEach, describe, expect, it, vi } from "vitest"

const { transaction, logAuditStrict, updateMany, findFirst, tenantConfigFindUnique, instanceFindUnique } = vi.hoisted(() => ({
  transaction: vi.fn(), logAuditStrict: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(),
  tenantConfigFindUnique: vi.fn(), instanceFindUnique: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: transaction } }))
vi.mock("@/lib/audit", () => ({ logAuditStrict, AuditAction: { TENANT_SUSPENDED: "S", TENANT_REACTIVATED: "R" } }))

import { setLenderStatus } from "./lender-actions"

const principal = { id: "op1", email: "op@test.invalid", operatorId: "op" } as never
const tx = { tenant: { updateMany, findFirst }, tenantConfig: { findUnique: tenantConfigFindUnique }, instanceJurisdiction: { findUnique: instanceFindUnique } }

beforeEach(() => {
  for (const m of [transaction, logAuditStrict, updateMany, findFirst, tenantConfigFindUnique, instanceFindUnique]) m.mockReset()
  transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx))
  updateMany.mockResolvedValue({ count: 1 })
})

const reactivate = () => setLenderStatus({ principal, tenantId: "za-1", status: "ACTIVE", reason: "back" })

describe("reactivating a lender on a one-jurisdiction instance", () => {
  it("is a 409 naming the clash when an ACTIVE lender differs, and changes nothing", async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: "ZA", currency: "ZAR" })
    instanceFindUnique.mockResolvedValue({ jurisdiction: "LS", currency: "LSL" })
    const r = await reactivate()
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect((r as { error: string }).error).toMatch(/this instance is LS\/LSL, this lender is ZA\/ZAR/)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it("goes ahead when the instance agrees", async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: "ZA", currency: "ZAR" })
    instanceFindUnique.mockResolvedValue({ jurisdiction: "ZA", currency: "ZAR" })
    expect(await reactivate()).toEqual({ ok: true, status: "ACTIVE" })
  })

  it("maps the database trigger's refusal (a race) to the same 409", async () => {
    tenantConfigFindUnique.mockResolvedValue(null)
    updateMany.mockRejectedValue(new Error("One instance serves one jurisdiction: an ACTIVE lender here is x=LS/LSL, this one would be ZA/ZAR. Give that lender its own instance and database."))
    expect(await reactivate()).toMatchObject({ ok: false, status: 409 })
  })

  it("suspending is never blocked by it", async () => {
    expect(await setLenderStatus({ principal, tenantId: "za-1", status: "SUSPENDED", reason: "x" })).toEqual({ ok: true, status: "SUSPENDED" })
    expect(instanceFindUnique).not.toHaveBeenCalled()
  })
})
