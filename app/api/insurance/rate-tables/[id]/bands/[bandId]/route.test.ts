// app/api/insurance/rate-tables/[id]/bands/[bandId]/route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const {
  findFirstTable,
  findFirstBand,
  updateBand,
  deleteBand,
  queryRaw,
  prismaTransaction,
  callOrder,
  logAudit,
} = vi.hoisted(() => ({
  findFirstTable: vi.fn(),
  findFirstBand: vi.fn(),
  updateBand: vi.fn(),
  deleteBand: vi.fn(),
  queryRaw: vi.fn(),
  prismaTransaction: vi.fn(),
  callOrder: [] as string[],
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insuranceRateTable: { findFirst: findFirstTable },
    insuranceRateBand: { findFirst: findFirstBand, update: updateBand, delete: deleteBand },
    $transaction: prismaTransaction,
  },
}))

vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "officer@acme-lending.example" },
  }),
}))

vi.mock("@/lib/audit", () => ({
  logAudit,
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

import { PATCH, DELETE } from "./route"

const ctx = { params: Promise.resolve({ id: "table-1", bandId: "band-1" }) }
const url = "http://localhost/api/insurance/rate-tables/table-1/bands/band-1"

const EXISTING = {
  id: "band-1",
  rateTableId: "table-1",
  lifeType: "MAIN_MEMBER",
  minAge: 18,
  maxAge: 64,
  sumAssured: 30000,
  premiumAmount: 84.5,
}

function patchReq(body: unknown) {
  return new NextRequest(url, {
    method: "PATCH",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

const deleteReq = () => new NextRequest(url, { method: "DELETE" })

/**
 * The transaction client. The band lookup, the overlap check and the write all
 * run on it, behind the parent-table lock taken by `$queryRaw`.
 */
const tx = {
  $queryRaw: (...args: unknown[]) => {
    callOrder.push("$queryRaw")
    return queryRaw(...args)
  },
  insuranceRateBand: {
    findFirst: (...args: unknown[]) => {
      callOrder.push("findFirst")
      return findFirstBand(...args)
    },
    update: (...args: unknown[]) => {
      callOrder.push("update")
      return updateBand(...args)
    },
    delete: (...args: unknown[]) => {
      callOrder.push("delete")
      return deleteBand(...args)
    },
  },
}

/** The parent table as the FOR UPDATE lock sees it. */
function lockReturns(status: string | null, basis: string = "AGE_BANDED") {
  queryRaw.mockResolvedValue(
    status === null ? [] : [{ id: "table-1", status, productId: "product-1", basis }]
  )
}

afterEach(() => {
  vi.clearAllMocks()
  callOrder.length = 0
})

beforeEach(() => {
  lockReturns("DRAFT")
  prismaTransaction.mockImplementation(async (fn: (c: typeof tx) => unknown) => fn(tx))
})

describe("PATCH /api/insurance/rate-tables/[id]/bands/[bandId]", () => {
  it("404s a table belonging to another tenant", async () => {
    findFirstTable.mockResolvedValue(null)

    const res = await PATCH(patchReq({ premiumAmount: 90 }), ctx)

    expect(res.status).toBe(404)
    expect(updateBand).not.toHaveBeenCalled()
  })

  it("refuses to edit a band on an ACTIVE table with 409", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "ACTIVE" })

    const res = await PATCH(patchReq({ premiumAmount: 1 }), ctx)

    expect(res.status).toBe(409)
    expect(updateBand).not.toHaveBeenCalled()
  })

  it("refuses to edit a band on a RETIRED table with 409", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "RETIRED" })

    const res = await PATCH(patchReq({ premiumAmount: 1 }), ctx)

    expect(res.status).toBe(409)
    expect(updateBand).not.toHaveBeenCalled()
  })

  it("404s a band that does not belong to this table", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    findFirstBand.mockResolvedValue(null)

    const res = await PATCH(patchReq({ premiumAmount: 90 }), ctx)

    expect(res.status).toBe(404)
    expect(findFirstBand.mock.calls[0][0].where).toEqual({ id: "band-1", rateTableId: "table-1" })
    expect(updateBand).not.toHaveBeenCalled()
  })

  it.each([
    ["zero premium", { premiumAmount: 0 }],
    ["negative premium", { premiumAmount: -1 }],
    ["zero sumAssured", { sumAssured: 0 }],
    ["inverted age range", { minAge: 70 }],
    ["negative age", { minAge: -5 }],
    ["unknown lifeType", { lifeType: "PET" }],
  ])("rejects %s with 422", async (_label, override) => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    findFirstBand.mockResolvedValueOnce({ ...EXISTING })

    const res = await PATCH(patchReq(override), ctx)

    expect(res.status).toBe(422)
    expect(updateBand).not.toHaveBeenCalled()
  })

  it("rejects an edit that would overlap a sibling band", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    findFirstBand
      .mockResolvedValueOnce({ ...EXISTING }) // the band being edited
      .mockResolvedValueOnce({ id: "band-2", minAge: 65, maxAge: 80 }) // a sibling it now collides with

    const res = await PATCH(patchReq({ maxAge: 70 }), ctx)

    expect(res.status).toBe(409)
    expect(updateBand).not.toHaveBeenCalled()
    // The band being edited must be excluded from its own overlap check.
    expect(findFirstBand.mock.calls[1][0].where).toMatchObject({
      rateTableId: "table-1",
      NOT: { id: "band-1" },
    })
  })

  it("updates a band on a DRAFT table and audits it", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    findFirstBand
      .mockResolvedValueOnce({ ...EXISTING })
      .mockResolvedValueOnce(null)
    updateBand.mockResolvedValue({ ...EXISTING, premiumAmount: 91.25 })

    const res = await PATCH(patchReq({ premiumAmount: 91.25 }), ctx)

    expect(res.status).toBe(200)
    expect(updateBand.mock.calls[0][0]).toMatchObject({
      where: { id: "band-1" },
      data: { premiumAmount: 91.25 },
    })
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "INSURANCE_RATE_BAND_UPDATED",
        entity: "InsuranceRateBand",
        entityId: "band-1",
      })
    )
  })
})

describe("DELETE /api/insurance/rate-tables/[id]/bands/[bandId]", () => {
  it("404s a table belonging to another tenant", async () => {
    findFirstTable.mockResolvedValue(null)

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(404)
    expect(deleteBand).not.toHaveBeenCalled()
  })

  it("refuses to delete a band from an ACTIVE table with 409", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "ACTIVE" })

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(409)
    expect(deleteBand).not.toHaveBeenCalled()
  })

  it("404s a band that does not belong to this table", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    findFirstBand.mockResolvedValue(null)

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(404)
    expect(deleteBand).not.toHaveBeenCalled()
  })

  it("deletes a band from a DRAFT table and audits it", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    findFirstBand.mockResolvedValue({ ...EXISTING })
    deleteBand.mockResolvedValue({ id: "band-1" })

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(200)
    expect(deleteBand).toHaveBeenCalledWith({ where: { id: "band-1" } })
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_RATE_BAND_DELETED",
        entity: "InsuranceRateBand",
        entityId: "band-1",
      })
    )
  })
})

// D2 + D6. The status read before the write is taken outside any lock, so a
// concurrent activate can land between it and the write; and an overlap check
// that is a separate autocommit statement from the update it guards proves
// nothing about what the table looks like when the update lands.
describe("rate band writes — serialisation behind the parent table lock", () => {
  it("PATCH runs the lookup, the overlap check and the update in ONE transaction, lock first", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    findFirstBand.mockResolvedValueOnce({ ...EXISTING }).mockResolvedValueOnce(null)
    updateBand.mockResolvedValue({ ...EXISTING, premiumAmount: 91.25 })

    const res = await PATCH(patchReq({ premiumAmount: 91.25 }), ctx)

    expect(res.status).toBe(200)
    expect(prismaTransaction).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual(["$queryRaw", "findFirst", "findFirst", "update"])

    const sql = queryRaw.mock.calls[0][0]
    expect(String(sql.sql ?? sql)).toMatch(/FROM "InsuranceRateTable"[\s\S]*FOR UPDATE/)
    expect(sql.values).toEqual(["table-1", "tenant-1"])
  })

  it("DELETE runs the lookup and the delete in ONE transaction, lock first", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    findFirstBand.mockResolvedValue({ ...EXISTING })
    deleteBand.mockResolvedValue({ id: "band-1" })

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(200)
    expect(prismaTransaction).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual(["$queryRaw", "findFirst", "delete"])
  })

  it.each([
    ["PATCH", () => PATCH(patchReq({ premiumAmount: 91.25 }), ctx)],
    ["DELETE", () => DELETE(deleteReq(), ctx)],
  ])("%s 409s when the parent left DRAFT between the pre-check and the lock", async (_m, call) => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    // The band exists and does NOT overlap anything, so a 409 here can only
    // come from the status re-read under the lock.
    findFirstBand.mockResolvedValueOnce({ ...EXISTING }).mockResolvedValueOnce(null)
    lockReturns("ACTIVE")

    const res = await call()

    expect(res.status).toBe(409)
    expect(updateBand).not.toHaveBeenCalled()
    expect(deleteBand).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it.each([
    ["PATCH", () => PATCH(patchReq({ premiumAmount: 91.25 }), ctx)],
    ["DELETE", () => DELETE(deleteReq(), ctx)],
  ])("%s 404s when the parent table vanished between the pre-check and the lock", async (_m, call) => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    findFirstBand.mockResolvedValue({ ...EXISTING })
    lockReturns(null)

    const res = await call()

    expect(res.status).toBe(404)
    expect(updateBand).not.toHaveBeenCalled()
    expect(deleteBand).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/insurance/rate-tables/[id]/bands/[bandId] — non-object bodies", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a scalar", 42],
  ])("returns 422 for a body that is %s", async (_label, body) => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    findFirstBand.mockResolvedValue({ ...EXISTING })

    const res = await PATCH(patchReq(body), ctx)

    expect(res.status).toBe(422)
    expect(updateBand).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/insurance/rate-tables/[id]/bands/[bandId] — audit evidence", () => {
  it("records the row Prisma persisted, not the values that were typed", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    // First call is the band lookup, second is the overlap check.
    findFirstBand.mockResolvedValueOnce({ ...EXISTING }).mockResolvedValueOnce(null)
    const persisted = { ...EXISTING, premiumAmount: "90.00" }
    updateBand.mockResolvedValue(persisted)

    await PATCH(patchReq({ premiumAmount: 90 }), ctx)

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "band-1", newValue: persisted })
    )
  })
})
