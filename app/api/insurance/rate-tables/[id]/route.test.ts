// app/api/insurance/rate-tables/[id]/route.test.ts
//
// The load-bearing rule here is immutability: once a rate table is ACTIVE or
// RETIRED it is frozen, because an in-force policy must keep the rate it was
// sold at. A rate change is a new version, never an edit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { findFirstTable, updateMany, deleteMany, logAudit, queryRaw, findManyBands, txUpdateMany, prismaTransaction } =
  vi.hoisted(() => ({
    findFirstTable: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    logAudit: vi.fn().mockResolvedValue(undefined),
    queryRaw: vi.fn(),
    findManyBands: vi.fn(),
    txUpdateMany: vi.fn(),
    prismaTransaction: vi.fn(),
  }))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insuranceRateTable: {
      findFirst: findFirstTable,
      updateMany,
      deleteMany,
    },
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

import { GET, PATCH, DELETE } from "./route"

const ctx = { params: Promise.resolve({ id: "table-1" }) }
const url = "http://localhost/api/insurance/rate-tables/table-1"

function patchReq(body: unknown) {
  return new NextRequest(url, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

/** The transaction client the basis-change path runs on. */
const tx = {
  $queryRaw: queryRaw,
  insuranceRateBand: { findMany: findManyBands },
  insuranceRateTable: { updateMany: txUpdateMany },
}

/** The parent table as the FOR UPDATE lock sees it. */
function lockReturns(status: string | null, basis = "AGE_BANDED") {
  queryRaw.mockResolvedValue(status === null ? [] : [{ id: "table-1", status, productId: "product-1", basis }])
}

afterEach(() => {
  vi.clearAllMocks()
})

beforeEach(() => {
  lockReturns("DRAFT")
  findManyBands.mockResolvedValue([])
  txUpdateMany.mockResolvedValue({ count: 1 })
  prismaTransaction.mockImplementation(async (fn: (c: typeof tx) => unknown) => fn(tx))
})

describe("GET /api/insurance/rate-tables/[id]", () => {
  it("404s a table belonging to another tenant", async () => {
    findFirstTable.mockResolvedValue(null)

    const res = await GET(new NextRequest(url), ctx)

    expect(res.status).toBe(404)
    expect(findFirstTable.mock.calls[0][0].where).toEqual({ id: "table-1", tenantId: "tenant-1" })
  })

  it("returns the table with its bands", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT", bands: [] })

    const res = await GET(new NextRequest(url), ctx)

    expect(res.status).toBe(200)
    expect(findFirstTable.mock.calls[0][0].include).toMatchObject({ bands: expect.anything() })
  })
})

describe("PATCH /api/insurance/rate-tables/[id]", () => {
  it("updates a DRAFT table and audits it", async () => {
    findFirstTable
      .mockResolvedValueOnce({ id: "table-1", status: "DRAFT", name: "old", productId: "product-1" })
      .mockResolvedValueOnce({ id: "table-1", status: "DRAFT", name: "new", productId: "product-1" })
    updateMany.mockResolvedValue({ count: 1 })

    const res = await PATCH(patchReq({ name: "new" }), ctx)

    expect(res.status).toBe(200)
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ name: "new" })
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_RATE_TABLE_UPDATED", entityId: "table-1" })
    )
  })

  // D2: the status read before the write is a courtesy, not the guard. Between
  // that read and the write a concurrent activate can have taken the table
  // ACTIVE, and an unconditional `update({ where: { id } })` would then silently
  // restate the rate an in-force policy was sold at.
  it("carries id, tenantId AND status DRAFT in the WHERE clause of the write itself", async () => {
    findFirstTable
      .mockResolvedValueOnce({ id: "table-1", status: "DRAFT", name: "old", productId: "product-1" })
      .mockResolvedValueOnce({ id: "table-1", status: "DRAFT", name: "new", productId: "product-1" })
    updateMany.mockResolvedValue({ count: 1 })

    await PATCH(patchReq({ name: "new" }), ctx)

    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: "table-1",
      tenantId: "tenant-1",
      status: "DRAFT",
    })
  })

  it("409s without auditing when the guarded write matches no row (activated mid-request)", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT", name: "old", productId: "product-1" })
    updateMany.mockResolvedValue({ count: 0 })

    const res = await PATCH(patchReq({ name: "new" }), ctx)

    expect(res.status).toBe(409)
    // An audit row asserting an edit that the database refused is worse than none.
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("refuses to mutate an ACTIVE table with 409", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "ACTIVE", productId: "product-1" })

    const res = await PATCH(patchReq({ name: "sneaky repricing" }), ctx)

    expect(res.status).toBe(409)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it("refuses to mutate a RETIRED table with 409", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "RETIRED", productId: "product-1" })

    const res = await PATCH(patchReq({ name: "history rewrite" }), ctx)

    expect(res.status).toBe(409)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it("never lets a PATCH change status or version", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT", productId: "product-1" })
    updateMany.mockResolvedValue({ count: 1 })

    await PATCH(patchReq({ status: "ACTIVE", version: 42, name: "ok" }), ctx)

    const data = updateMany.mock.calls[0][0].data
    expect(data.status).toBeUndefined()
    expect(data.version).toBeUndefined()
  })

  it("404s a table belonging to another tenant", async () => {
    findFirstTable.mockResolvedValue(null)

    const res = await PATCH(patchReq({ name: "x" }), ctx)

    expect(res.status).toBe(404)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it("returns 422 for an unparseable body", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT", productId: "product-1" })

    const res = await PATCH(
      new NextRequest(url, { method: "PATCH", body: "{oops", headers: { "content-type": "application/json" } }),
      ctx
    )

    expect(res.status).toBe(422)
    expect(updateMany).not.toHaveBeenCalled()
  })
})

describe("DELETE /api/insurance/rate-tables/[id]", () => {
  it("deletes a DRAFT table and audits it", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT", productId: "product-1", version: 2 })
    deleteMany.mockResolvedValue({ count: 1 })

    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx)

    expect(res.status).toBe(200)
    // D2: the delete cascades to every band (InsuranceRateBand.rateTable is
    // onDelete: Cascade). An unconditional `delete({ where: { id } })` after a
    // stale DRAFT read would destroy an ACTIVE card and its priced terms.
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "table-1", tenantId: "tenant-1", status: "DRAFT" },
    })
    // A destruction, recorded as one. Filing it under _UPDATED left an auditor
    // filtering on action unable to tell an edit from the row's disappearance.
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_RATE_TABLE_DELETED", entityId: "table-1" })
    )
  })

  it("409s without auditing when the guarded delete matches no row (activated mid-request)", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT", productId: "product-1", version: 2 })
    deleteMany.mockResolvedValue({ count: 0 })

    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx)

    expect(res.status).toBe(409)
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("refuses to delete an ACTIVE table with 409", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "ACTIVE", productId: "product-1" })

    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx)

    expect(res.status).toBe(409)
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it("refuses to delete a RETIRED table with 409", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "RETIRED", productId: "product-1" })

    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx)

    expect(res.status).toBe(409)
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it("404s a table belonging to another tenant", async () => {
    findFirstTable.mockResolvedValue(null)

    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx)

    expect(res.status).toBe(404)
    expect(deleteMany).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/insurance/rate-tables/[id] — non-object bodies", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a scalar", 42],
  ])("returns 422 for a body that is %s", async (_label, body) => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT", productId: "product-1" })

    const res = await PATCH(patchReq(body), ctx)

    expect(res.status).toBe(422)
    expect(updateMany).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/insurance/rate-tables/[id] — nothing to write", () => {
  it.each([
    ["an empty body", {}],
    ["only non-writable keys", { status: "ACTIVE", version: 42 }],
  ])("returns 422 for %s without writing or auditing", async (_label, body) => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT", productId: "product-1" })

    const res = await PATCH(patchReq(body), ctx)

    expect(res.status).toBe(422)
    expect(updateMany).not.toHaveBeenCalled()
    // An audit row reading `newValue: {}` is worse than none: it asserts a
    // change was made when nothing moved.
    expect(logAudit).not.toHaveBeenCalled()
  })
})


// Changing `basis` on a DRAFT table re-keys every band it already holds. Bands
// captured as valid under AGE_BANDED — two MAIN_MEMBER 18-65 rows at different
// cover amounts, say — become ambiguous the moment the table becomes
// PER_MILLE, because PER_MILLE rating ignores a band's own sumAssured. Nothing
// re-checked them, so the same unquotable state the band routes refuse could be
// reached through the back door.
describe("PATCH /api/insurance/rate-tables/[id] — changing the basis re-validates the bands", () => {
  const DRAFT = { id: "table-1", status: "DRAFT", basis: "AGE_BANDED", name: "old", productId: "product-1" }

  it("refuses the change when existing bands would collide under the NEW basis", async () => {
    findFirstTable.mockResolvedValue(DRAFT)
    findManyBands.mockResolvedValue([
      { id: "b1", lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 65, sumAssured: 10000 },
      { id: "b2", lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 65, sumAssured: 20000 },
    ])

    const res = await PATCH(patchReq({ basis: "PER_MILLE" }), ctx)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error).toMatch(/b1/)
    expect(body.error).toMatch(/b2/)
    expect(txUpdateMany).not.toHaveBeenCalled()
    expect(updateMany).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("allows the change when the same bands stay unambiguous under the new basis", async () => {
    findFirstTable.mockResolvedValue(DRAFT)
    findManyBands.mockResolvedValue([
      { id: "b1", lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 40, sumAssured: 10000 },
      { id: "b2", lifeType: "MAIN_MEMBER", minAge: 41, maxAge: 65, sumAssured: 20000 },
    ])

    const res = await PATCH(patchReq({ basis: "PER_MILLE" }), ctx)

    expect(res.status).toBe(200)
    expect(txUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "table-1", tenantId: "tenant-1", status: "DRAFT" },
      data: { basis: "PER_MILLE" },
    })
  })

  it("re-validates behind the SAME row lock the band writes take, so no band can slip in", async () => {
    findFirstTable.mockResolvedValue(DRAFT)

    await PATCH(patchReq({ basis: "FLAT" }), ctx)

    const sql = queryRaw.mock.calls[0][0]
    expect(String(sql.sql ?? sql)).toMatch(/FROM "InsuranceRateTable"[\s\S]*FOR UPDATE/)
    expect(sql.values).toEqual(["table-1", "tenant-1"])
  })

  it("409s when the table left DRAFT between the courtesy read and the lock", async () => {
    findFirstTable.mockResolvedValue(DRAFT)
    lockReturns("ACTIVE")

    const res = await PATCH(patchReq({ basis: "FLAT" }), ctx)

    expect(res.status).toBe(409)
    expect(txUpdateMany).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("does not re-validate when the basis is sent unchanged", async () => {
    findFirstTable.mockResolvedValue(DRAFT)
    updateMany.mockResolvedValue({ count: 1 })

    const res = await PATCH(patchReq({ basis: "AGE_BANDED", name: "renamed" }), ctx)

    expect(res.status).toBe(200)
    expect(prismaTransaction).not.toHaveBeenCalled()
  })
})
