import { describe, expect, it } from "vitest"
import { activeRateTableFindManyArgs, resolveActiveRateTable } from "./rate-table"

const AT = new Date("2026-08-15T00:00:00Z")
const PARAMS = { tenantId: "tenant-1", productId: "product-1", at: AT }

const BANDS = [
  { id: "band-1", lifeType: "MAIN_MEMBER" as const, minAge: 18, maxAge: 35, sumAssured: "10000.00", premiumAmount: "42.50" },
]

/** A findMany stub, so the query shape and the branching are tested without a DB. */
function readerReturning(tables: unknown[]) {
  const calls: unknown[] = []
  return {
    calls,
    prisma: {
      insuranceRateTable: {
        findMany: async (args: unknown) => {
          calls.push(args)
          return tables
        },
      },
    } as never,
  }
}

describe("activeRateTableFindManyArgs", () => {
  it("scopes to the tenant, the product and ACTIVE status", () => {
    expect(activeRateTableFindManyArgs(PARAMS).where).toMatchObject({
      tenantId: "tenant-1",
      productId: "product-1",
      status: "ACTIVE",
    })
  })

  it("bounds the window with an inclusive start and an exclusive end", () => {
    // Inclusive/exclusive matters: a table retired at the instant its successor
    // starts must leave neither a gap nor an overlap.
    expect(activeRateTableFindManyArgs(PARAMS).where).toMatchObject({
      effectiveFrom: { lte: AT },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: AT } }],
    })
  })

  it("loads the bands alongside the table", () => {
    expect(activeRateTableFindManyArgs(PARAMS).select.bands).toBeTruthy()
  })
})

describe("resolveActiveRateTable", () => {
  it("returns the single in-force table with its bands", async () => {
    const { prisma } = readerReturning([
      { id: "rt-1", version: 3, name: "2026 funeral", basis: "AGE_BANDED", effectiveFrom: AT, effectiveTo: null, insurerId: "ins-1", bands: BANDS },
    ])
    const result = await resolveActiveRateTable(prisma, PARAMS)
    expect(result.ok).toBe(true)
    expect(result).toMatchObject({ table: { id: "rt-1", version: 3, bands: BANDS } })
  })

  it("reports NOT_CONFIGURED when nothing is in force, rather than throwing", async () => {
    const { prisma } = readerReturning([])
    expect(await resolveActiveRateTable(prisma, PARAMS)).toMatchObject({ ok: false, reason: "NOT_CONFIGURED" })
  })

  it("errors on two in-force tables instead of picking one", async () => {
    const table = { version: 1, name: "a", basis: "AGE_BANDED", effectiveFrom: AT, effectiveTo: null, insurerId: null, bands: BANDS }
    const { prisma } = readerReturning([
      { ...table, id: "rt-1" },
      { ...table, id: "rt-2" },
    ])
    const result = await resolveActiveRateTable(prisma, PARAMS)
    expect(result).toMatchObject({ ok: false, reason: "AMBIGUOUS_ACTIVE_TABLES" })
    expect(result.ok === false && result.tableIds).toEqual(["rt-1", "rt-2"])
  })

  it("refuses an in-force table with no bands", async () => {
    const { prisma } = readerReturning([
      { id: "rt-1", version: 1, name: "empty", basis: "AGE_BANDED", effectiveFrom: AT, effectiveTo: null, insurerId: null, bands: [] },
    ])
    expect(await resolveActiveRateTable(prisma, PARAMS)).toMatchObject({ ok: false, reason: "NO_BANDS" })
  })

  it("passes the caller's date through to the query, not today's", async () => {
    const { prisma, calls } = readerReturning([])
    await resolveActiveRateTable(prisma, PARAMS)
    expect(calls[0]).toMatchObject({ where: { effectiveFrom: { lte: AT } } })
  })
})
