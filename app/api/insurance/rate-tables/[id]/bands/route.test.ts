// app/api/insurance/rate-tables/[id]/bands/route.test.ts
//
// A band is one row of the insurer's rate card. Two things must be impossible
// to configure at all, rather than merely detected later at quote time:
//   - a non-positive premium (a free policy nobody priced), and
//   - two bands whose age ranges overlap for the same life type and cover
//     amount, which makes the price of a life ambiguous.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const {
  findFirstTable,
  findManyBands,
  findFirstBand,
  createBand,
  queryRaw,
  prismaTransaction,
  callOrder,
  logAudit,
} = vi.hoisted(() => ({
  findFirstTable: vi.fn(),
  findManyBands: vi.fn().mockResolvedValue([]),
  findFirstBand: vi.fn().mockResolvedValue(null),
  createBand: vi.fn(),
  queryRaw: vi.fn(),
  prismaTransaction: vi.fn(),
  callOrder: [] as string[],
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insuranceRateTable: { findFirst: findFirstTable },
    insuranceRateBand: { findMany: findManyBands, findFirst: findFirstBand, create: createBand },
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

import { GET, POST } from "./route"

const ctx = { params: Promise.resolve({ id: "table-1" }) }
const url = "http://localhost/api/insurance/rate-tables/table-1/bands"

const VALID = {
  lifeType: "MAIN_MEMBER",
  minAge: 18,
  maxAge: 64,
  sumAssured: 30000,
  premiumAmount: 84.5,
}

function postReq(body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

/**
 * The transaction client, recording call order. The overlap check and the
 * insert MUST both run on it: on the real client they would be two separate
 * autocommit statements with the row lock released between them, which is the
 * defect this fixture exists to detect.
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
    create: (...args: unknown[]) => {
      callOrder.push("create")
      return createBand(...args)
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
  findManyBands.mockResolvedValue([])
  findFirstBand.mockResolvedValue(null)
  createBand.mockResolvedValue({ id: "band-1" })
  lockReturns("DRAFT")
  prismaTransaction.mockImplementation(async (fn: (c: typeof tx) => unknown) => fn(tx))
})

beforeEach(() => {
  lockReturns("DRAFT")
  prismaTransaction.mockImplementation(async (fn: (c: typeof tx) => unknown) => fn(tx))
})

describe("GET /api/insurance/rate-tables/[id]/bands", () => {
  it("404s a table belonging to another tenant", async () => {
    findFirstTable.mockResolvedValue(null)

    const res = await GET(new NextRequest(url), ctx)

    expect(res.status).toBe(404)
    expect(findFirstTable.mock.calls[0][0].where).toEqual({ id: "table-1", tenantId: "tenant-1" })
    expect(findManyBands).not.toHaveBeenCalled()
  })

  it("lists the bands of a table the tenant owns", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "ACTIVE" })

    const res = await GET(new NextRequest(url), ctx)

    expect(res.status).toBe(200)
    expect(findManyBands.mock.calls[0][0].where).toEqual({ rateTableId: "table-1" })
  })
})

describe("POST /api/insurance/rate-tables/[id]/bands", () => {
  it("404s a table belonging to another tenant", async () => {
    findFirstTable.mockResolvedValue(null)

    const res = await POST(postReq(VALID), ctx)

    expect(res.status).toBe(404)
    expect(createBand).not.toHaveBeenCalled()
  })

  it("refuses to add a band to an ACTIVE table with 409", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "ACTIVE" })

    const res = await POST(postReq(VALID), ctx)

    expect(res.status).toBe(409)
    expect(createBand).not.toHaveBeenCalled()
  })

  it("refuses to add a band to a RETIRED table with 409", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "RETIRED" })

    const res = await POST(postReq(VALID), ctx)

    expect(res.status).toBe(409)
    expect(createBand).not.toHaveBeenCalled()
  })

  describe("on a DRAFT table", () => {
    afterEach(() => {
      findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    })

    it("returns 422 for an unparseable body", async () => {
      findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })

      const res = await POST(postReq("{nope"), ctx)

      expect(res.status).toBe(422)
      expect(createBand).not.toHaveBeenCalled()
    })

    it.each([
      ["minAge above maxAge", { minAge: 65, maxAge: 18 }],
      ["negative minAge", { minAge: -1 }],
      ["non-integer minAge", { minAge: 18.5 }],
      ["non-integer maxAge", { maxAge: 64.2 }],
      ["missing lifeType", { lifeType: undefined }],
      ["unknown lifeType", { lifeType: "PET" }],
      ["zero sumAssured", { sumAssured: 0 }],
      ["negative sumAssured", { sumAssured: -30000 }],
      ["zero premiumAmount", { premiumAmount: 0 }],
      ["negative premiumAmount", { premiumAmount: -84.5 }],
      ["non-numeric premiumAmount", { premiumAmount: "84.50" }],
    ])("rejects %s with 422", async (_label, override) => {
      findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })

      const res = await POST(postReq({ ...VALID, ...override }), ctx)

      expect(res.status).toBe(422)
      expect(createBand).not.toHaveBeenCalled()
    })

    it("rejects a band overlapping an existing one for the same life type and cover", async () => {
      findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
      findFirstBand.mockResolvedValue({ id: "band-existing", minAge: 18, maxAge: 40 })

      const res = await POST(postReq({ ...VALID, minAge: 35, maxAge: 50 }), ctx)

      expect(res.status).toBe(409)
      expect(createBand).not.toHaveBeenCalled()

      // The overlap query is the CLOSED-interval test: age ranges are
      // inclusive at both ends, so an existing band overlaps when it starts at
      // or before the new end AND ends at or after the new start — keyed on the
      // same life type and, under AGE_BANDED, the same cover tier.
      expect(findFirstBand.mock.calls[0][0].where).toMatchObject({
        rateTableId: "table-1",
        lifeType: "MAIN_MEMBER",
        sumAssured: 30000,
        minAge: { lte: 50 },
        maxAge: { gte: 35 },
      })
    })

    it("creates a valid, non-overlapping band and audits it", async () => {
      findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
      findFirstBand.mockResolvedValue(null)
      createBand.mockResolvedValue({ id: "band-9" })

      const res = await POST(postReq(VALID), ctx)

      expect(res.status).toBe(200)
      expect(createBand.mock.calls[0][0].data).toMatchObject({
        rateTableId: "table-1",
        lifeType: "MAIN_MEMBER",
        minAge: 18,
        maxAge: 64,
        sumAssured: 30000,
        premiumAmount: 84.5,
      })
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-1",
          action: "INSURANCE_RATE_BAND_CREATED",
          entity: "InsuranceRateBand",
          entityId: "band-9",
        })
      )
    })

    it("allows the same age range at a DIFFERENT cover amount", async () => {
      findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
      findFirstBand.mockResolvedValue(null)

      const res = await POST(postReq({ ...VALID, sumAssured: 50000 }), ctx)

      expect(res.status).toBe(200)
      expect(findFirstBand.mock.calls[0][0].where).toMatchObject({ sumAssured: 50000 })
    })
  })
})

// D6 — the unique index @@unique([rateTableId, lifeType, minAge, maxAge,
// sumAssured]) catches EXACT tuple duplicates and nothing else. Two concurrent
// POSTs for 18–30 and 25–40 at the same life type and cover both pass the
// overlap query (neither has committed) and both insert, because the tuples
// differ. The table then prices age 27 two ways, which `rate-quote` has no
// answer for. The only thing that stops it is serialising the writers.
describe("POST /api/insurance/rate-tables/[id]/bands — serialisation", () => {
  it("runs the overlap check and the insert in ONE transaction, behind a lock on the parent table", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })

    const res = await POST(postReq(VALID), ctx)

    expect(res.status).toBe(200)
    expect(prismaTransaction).toHaveBeenCalledTimes(1)
    // The lock comes FIRST, then the check, then the write — all on the
    // transaction client. A lock taken after the check would prove nothing.
    expect(callOrder).toEqual(["$queryRaw", "findFirst", "create"])
  })

  it("locks the parent rate table row FOR UPDATE, scoped to this tenant", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })

    await POST(postReq(VALID), ctx)

    const sql = queryRaw.mock.calls[0][0]
    expect(String(sql.sql ?? sql)).toMatch(/FROM "InsuranceRateTable"[\s\S]*FOR UPDATE/)
    expect(sql.values).toEqual(["table-1", "tenant-1"])
  })

  it("409s when the parent left DRAFT between the pre-check and the lock", async () => {
    // The pre-check saw DRAFT. A concurrent activate committed before this
    // transaction got the row lock, so the status read UNDER the lock is ACTIVE.
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    lockReturns("ACTIVE")

    const res = await POST(postReq(VALID), ctx)

    expect(res.status).toBe(409)
    expect(createBand).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("404s when the parent table vanished between the pre-check and the lock", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    lockReturns(null)

    const res = await POST(postReq(VALID), ctx)

    expect(res.status).toBe(404)
    expect(createBand).not.toHaveBeenCalled()
  })
})

describe("POST /api/insurance/rate-tables/[id]/bands — non-object bodies", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a scalar", 42],
  ])("returns 422 for a body that is %s", async (_label, body) => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })

    const res = await POST(postReq(body), ctx)

    expect(res.status).toBe(422)
    expect(createBand).not.toHaveBeenCalled()
  })
})

describe("POST /api/insurance/rate-tables/[id]/bands — audit evidence", () => {
  it("records the row Prisma persisted, not the values that were typed", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    findFirstBand.mockResolvedValue(null)
    // What comes back from the Decimal(12,2) columns, which is the only thing
    // an auditor can be shown as evidence of what the rate card holds.
    const persisted = {
      id: "band-9",
      rateTableId: "table-1",
      lifeType: "MAIN_MEMBER",
      minAge: 18,
      maxAge: 64,
      sumAssured: "30000.00",
      premiumAmount: "84.50",
    }
    createBand.mockResolvedValue(persisted)

    await POST(postReq(VALID), ctx)

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "band-9", newValue: persisted })
    )
  })
})

describe("POST /api/insurance/rate-tables/[id]/bands — the outer catch", () => {
  it("turns an unexpected Prisma failure into a 500 instead of a rejected promise", async () => {
    // `return withTenantContext(...)` inside a try returns the promise BEFORE
    // it settles, so it settled outside the try and the catch below it was
    // unreachable — the deliberate re-throw of a non-P2002 error escaped the
    // handler entirely. `return await` is what makes the catch real.
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    findFirstBand.mockResolvedValue(null)
    createBand.mockRejectedValue(new Error("connection reset"))
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    const res = await POST(postReq(VALID), ctx)

    expect(res.status).toBe(500)
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })
})

// The overlap check was keyed on `sumAssured` for EVERY basis, while
// PER_MILLE rating ignores a band's own sumAssured — the rate applies across
// cover amounts. Two MAIN_MEMBER 18-65 bands at R10 000 and R20 000 therefore
// both stored, and every life on the table afterwards quoted AMBIGUOUS_BANDS
// while readiness still called the product sellable. The refusal now mirrors
// whatever the table's basis actually matches on, read under the row lock.
describe("POST /api/insurance/rate-tables/[id]/bands — the overlap rule follows the table's basis", () => {
  it("reads the basis from the locked row, not from the courtesy read", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    lockReturns("DRAFT", "PER_MILLE")

    await POST(postReq(VALID), ctx)

    const sql = queryRaw.mock.calls[0][0]
    expect(String(sql.sql ?? sql)).toMatch(/"basis"[\s\S]*FROM "InsuranceRateTable"[\s\S]*FOR UPDATE/)
  })

  it("refuses a second PER_MILLE band at a DIFFERENT cover amount", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    lockReturns("DRAFT", "PER_MILLE")
    findFirstBand.mockResolvedValue({ id: "band-existing", minAge: 18, maxAge: 65 })

    const res = await POST(postReq({ ...VALID, sumAssured: 50000 }), ctx)

    expect(res.status).toBe(409)
    expect(createBand).not.toHaveBeenCalled()
    // The query must NOT constrain sumAssured, or it would find nothing and
    // store the ambiguous band.
    expect(findFirstBand.mock.calls[0][0].where).not.toHaveProperty("sumAssured")
    expect(findFirstBand.mock.calls[0][0].where).toMatchObject({
      rateTableId: "table-1",
      lifeType: "MAIN_MEMBER",
      minAge: { lte: 64 },
      maxAge: { gte: 18 },
    })
  })

  it("names the real reason in the refusal rather than a cover tier that is not a key", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    lockReturns("DRAFT", "PER_MILLE")
    findFirstBand.mockResolvedValue({ id: "band-existing", minAge: 18, maxAge: 65 })

    const res = await POST(postReq(VALID), ctx)
    const body = await res.json()

    expect(body.error).toMatch(/PER_MILLE/)
    expect(body.error).toMatch(/not a tier key/)
  })

  it("refuses a second FLAT band at the same cover even with a disjoint age range", async () => {
    findFirstTable.mockResolvedValue({ id: "table-1", status: "DRAFT" })
    lockReturns("DRAFT", "FLAT")
    findFirstBand.mockResolvedValue({ id: "band-existing", minAge: 0, maxAge: 17 })

    const res = await POST(postReq({ ...VALID, minAge: 18, maxAge: 64 }), ctx)

    expect(res.status).toBe(409)
    expect(createBand).not.toHaveBeenCalled()
    // Age is not a rating factor under FLAT, so constraining on it would let
    // the second band in and make every FLAT quote ambiguous.
    const where = findFirstBand.mock.calls[0][0].where
    expect(where).not.toHaveProperty("minAge")
    expect(where).not.toHaveProperty("maxAge")
    expect(where).toMatchObject({ rateTableId: "table-1", lifeType: "MAIN_MEMBER", sumAssured: 30000 })
  })
})
