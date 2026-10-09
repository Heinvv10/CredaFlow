// app/api/insurance/rate-tables/route.test.ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const {
  findManyTables,
  findFirstTable,
  createTable,
  findFirstProduct,
  findFirstInsurer,
  logAudit,
} = vi.hoisted(() => ({
  findManyTables: vi.fn().mockResolvedValue([]),
  findFirstTable: vi.fn().mockResolvedValue(null),
  createTable: vi.fn(),
  findFirstProduct: vi.fn(),
  findFirstInsurer: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // featureIms ON — requireImsEnabled reads the LIVE TenantConfig row.
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insuranceProduct: { findFirst: findFirstProduct },
    insurer: { findFirst: findFirstInsurer },
    insuranceRateTable: {
      findMany: findManyTables,
      findFirst: findFirstTable,
      create: createTable,
    },
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

import { GET, POST } from "./route"

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/insurance/rate-tables", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

const VALID = {
  productId: "product-1",
  name: "Guardrisk funeral rates 2026",
  basis: "AGE_BANDED",
  effectiveFrom: "2026-09-01T00:00:00.000Z",
}

afterEach(() => {
  vi.clearAllMocks()
  findManyTables.mockResolvedValue([])
  findFirstTable.mockResolvedValue(null)
  findFirstProduct.mockResolvedValue({ id: "product-1" })
  createTable.mockResolvedValue({ id: "table-1", version: 1, status: "DRAFT" })
})

describe("GET /api/insurance/rate-tables", () => {
  it("scopes the list to the caller's tenant", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })
    const res = await GET(new NextRequest("http://localhost/api/insurance/rate-tables"))

    expect(res.status).toBe(200)
    expect(findManyTables.mock.calls[0][0].where).toEqual({ tenantId: "tenant-1" })
  })

  it("filters by productId when supplied", async () => {
    await GET(new NextRequest("http://localhost/api/insurance/rate-tables?productId=product-9"))

    expect(findManyTables.mock.calls[0][0].where).toEqual({
      tenantId: "tenant-1",
      productId: "product-9",
    })
  })
})

describe("POST /api/insurance/rate-tables", () => {
  it("returns 422 for an unparseable body", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })
    const res = await POST(postReq("not json at all"))

    expect(res.status).toBe(422)
    expect(createTable).not.toHaveBeenCalled()
  })

  it("returns 422 when productId or name is missing", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })
    const res = await POST(postReq({ name: "no product" }))

    expect(res.status).toBe(422)
    expect(createTable).not.toHaveBeenCalled()
  })

  it("returns 422 for an unknown basis", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })
    const res = await POST(postReq({ ...VALID, basis: "WHATEVER" }))

    expect(res.status).toBe(422)
    expect(createTable).not.toHaveBeenCalled()
  })

  it("404s a product belonging to another tenant rather than leaking it", async () => {
    findFirstProduct.mockResolvedValue(null)
    const res = await POST(postReq(VALID))

    expect(res.status).toBe(404)
    expect(createTable).not.toHaveBeenCalled()
    // The lookup itself was tenant-scoped, which is what makes the 404 honest.
    expect(findFirstProduct.mock.calls[0][0].where).toMatchObject({
      id: "product-1",
      tenantId: "tenant-1",
    })
  })

  it("404s an insurer belonging to another tenant", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })
    findFirstInsurer.mockResolvedValue(null)
    const res = await POST(postReq({ ...VALID, insurerId: "insurer-other" }))

    expect(res.status).toBe(404)
    expect(createTable).not.toHaveBeenCalled()
  })

  it("creates the first table for a product at version 1, status DRAFT", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })
    findFirstTable.mockResolvedValue(null)

    const res = await POST(postReq(VALID))

    expect(res.status).toBe(200)
    expect(createTable.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant-1",
      productId: "product-1",
      version: 1,
      status: "DRAFT",
    })
  })

  it("assigns the version server-side, ignoring any client-supplied version", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })
    findFirstTable.mockResolvedValue({ version: 3 })

    await POST(postReq({ ...VALID, version: 99, status: "ACTIVE" }))

    const data = createTable.mock.calls[0][0].data
    expect(data.version).toBe(4)
    // A caller must not be able to bypass activation by posting a status.
    expect(data.status).toBe("DRAFT")
  })

  it("audits the creation", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })
    createTable.mockResolvedValue({ id: "table-7", version: 1, status: "DRAFT" })

    await POST(postReq(VALID))

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "INSURANCE_RATE_TABLE_CREATED",
        entity: "InsuranceRateTable",
        entityId: "table-7",
      })
    )
  })
})

// A JSON body of `null`, an array or a scalar all parse fine, so the
// `catch { 422 }` around req.json() never sees them and the next property
// access used to throw — out of reach of the (dead) outer catch.
describe("POST /api/insurance/rate-tables — non-object bodies", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a scalar", 42],
  ])("returns 422 for a body that is %s", async (_label, body) => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })

    const res = await POST(postReq(body))

    expect(res.status).toBe(422)
    expect(createTable).not.toHaveBeenCalled()
  })
})
