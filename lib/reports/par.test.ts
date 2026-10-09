import { describe, it, expect, vi, beforeEach } from "vitest"

const aggregate = vi.fn()
vi.mock("@/lib/prisma", () => ({ prisma: { loan: { aggregate: (a: unknown) => aggregate(a) } } }))

import { getPortfolioPar } from "./par"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"

const BOOK = { in: [...COLLECTIBLE_STATUSES] }

/** Distinct value per band so a bucket reading the wrong aggregate is visible. */
function stub() {
  aggregate.mockImplementation((args: { where: Record<string, unknown> }) => {
    const dpd = (args.where.daysInArrears as { gte?: number } | undefined)?.gte
    if (dpd === 90) return { _count: 1, _sum: { outstandingPrincipal: 100_00 } }
    if (dpd === 60) return { _count: 2, _sum: { outstandingPrincipal: 200_00 } }
    if (dpd === 30) return { _count: 3, _sum: { outstandingPrincipal: 400_00 } }
    return { _count: 10, _sum: { outstandingPrincipal: 1000_00 } }
  })
}

describe("getPortfolioPar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stub()
  })

  it("computes every band over the collectible book", async () => {
    // This module used to use ACTIVE only, while the reports overview and the
    // NCR return used a wider population — so the business reported one PAR
    // number to itself and another to the regulator.
    await getPortfolioPar("t1")
    const wheres = aggregate.mock.calls.map(([a]) => (a as { where: Record<string, unknown> }).where)
    expect(wheres).toHaveLength(4)
    for (const w of wheres) {
      expect(w.tenantId).toBe("t1")
      expect(w.status).toEqual(BOOK)
    }
  })

  it("uses >= at each DPD threshold, matching PAR90/NPL elsewhere", async () => {
    await getPortfolioPar("t1")
    const thresholds = aggregate.mock.calls
      .map(([a]) => (a as { where: { daysInArrears?: { gte?: number } } }).where.daysInArrears?.gte)
      .filter((v) => v !== undefined)
    expect(thresholds.sort((a, b) => (a as number) - (b as number))).toEqual([30, 60, 90])
  })

  it("draws the denominator from the whole book, with no DPD filter", async () => {
    await getPortfolioPar("t1")
    const bookCall = aggregate.mock.calls
      .map(([a]) => (a as { where: Record<string, unknown> }).where)
      .filter((w) => w.daysInArrears === undefined)
    expect(bookCall).toHaveLength(1)
    expect(bookCall[0].status).toEqual(BOOK)
  })

  it("returns value-weighted percentages of the book", async () => {
    const par = await getPortfolioPar("t1")
    expect(par.book).toBe(1000_00)
    expect(par.par30).toMatchObject({ count: 3, value: 400_00 })
    expect(par.par30.pct).toBeCloseTo(40)
    expect(par.par60.pct).toBeCloseTo(20)
    expect(par.par90.pct).toBeCloseTo(10)
  })

  // Bounding pct with a stub whose numerators are already smaller than its
  // denominator asserts a property of the stub, not of par.ts — it cannot fail.
  // The real invariant is structural: every band queries the SAME population as
  // the book, so the database cannot return a numerator the denominator does
  // not contain. That is what is asserted here.
  it("cannot exceed 100%, because every band queries the book's own population", async () => {
    await getPortfolioPar("t1")
    const wheres = aggregate.mock.calls.map(([a]) => (a as { where: Record<string, unknown> }).where)
    const book = wheres.find((w) => w.daysInArrears === undefined)
    const bands = wheres.filter((w) => w.daysInArrears !== undefined)
    expect(bands).toHaveLength(3)
    for (const band of bands) {
      expect(band.status).toEqual(book!.status)
      expect(band.tenantId).toEqual(book!.tenantId)
      // A band is the book NARROWED by DPD — it adds a predicate, never
      // replaces or widens one.
      expect(Object.keys(band).sort()).toEqual(["daysInArrears", "status", "tenantId"])
    }
  })

  it("orders the bands so a wider one always subsumes a narrower one", async () => {
    // Monotonicity of the returned values follows from the thresholds nesting,
    // which is a property of par.ts; comparing stub numbers would not be.
    await getPortfolioPar("t1")
    const gte = aggregate.mock.calls
      .map(([a]) => (a as { where: { daysInArrears?: { gte?: number } } }).where.daysInArrears?.gte)
      .filter((v): v is number => v !== undefined)
      .sort((x, y) => x - y)
    expect(gte).toEqual([30, 60, 90])
    // Each successive band is a strict subset of the previous one.
    for (let i = 1; i < gte.length; i++) expect(gte[i]).toBeGreaterThan(gte[i - 1])
  })

  it("returns 0% rather than NaN on an empty book", async () => {
    aggregate.mockResolvedValue({ _count: 0, _sum: { outstandingPrincipal: null } })
    const par = await getPortfolioPar("t1")
    expect(par.book).toBe(0)
    for (const b of [par.par30, par.par60, par.par90]) {
      expect(b.pct).toBe(0)
      expect(Number.isNaN(b.pct)).toBe(false)
    }
  })
})
