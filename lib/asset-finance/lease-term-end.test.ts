import { describe, expect, it, vi } from "vitest"
import { dbDate } from "./dates"
import { bestMarketValuation, checkPurchaseValuation, leaseTermEnd } from "./lease-term-end"

type Valuation = { valuedOn: Date; amountCents: number; source: string; createdById: string | null }

function tx(opts: { lastDue?: string; timing?: "ADVANCE" | "ARREARS"; valuation?: Valuation; maxAge?: number }) {
  return {
    leaseRental: { findFirst: vi.fn(async () => (opts.lastDue ? { dueDate: dbDate(opts.lastDue) } : null)) },
    assetFinanceDeal: { findFirst: vi.fn(async () => (opts.timing ? { rentalTiming: opts.timing } : null)) },
    assetValuation: { findFirst: vi.fn(async () => opts.valuation ?? null) },
    tenantConfig: { findUnique: vi.fn(async () => (opts.maxAge === undefined ? null : { leasePurchaseValuationMaxAgeDays: opts.maxAge })) },
  }
}
const valuation = (valuedOn: string, data: Partial<Valuation> = {}): Valuation => ({ valuedOn: dbDate(valuedOn), amountCents: 50_000_000, source: "ASSESSOR", createdById: "valuer", ...data })
const check = (t: ReturnType<typeof tx>, electorUserId: string | null = "elector") =>
  checkPurchaseValuation(t as never, { tenantId: "t1", assetId: "a1", valuationId: "v1", today: "2027-06-30", electorUserId })

describe("leaseTermEnd (C7)", () => {
  it("in arrears, the last uncancelled rental's due date; in advance, a month later (clamped)", async () => {
    const arrears = tx({ lastDue: "2027-05-31", timing: "ARREARS" })
    expect(await leaseTermEnd(arrears as never, "t1", "l1")).toBe("2027-05-31")
    expect(arrears.leaseRental.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", loanId: "l1", cancelledAt: null }, orderBy: { periodNo: "desc" } }))
    expect(await leaseTermEnd(tx({ lastDue: "2027-05-31", timing: "ADVANCE" }) as never, "t1", "l1")).toBe("2027-06-30")
  })
  it("no rentals: null", async () => {
    expect(await leaseTermEnd(tx({ timing: "ADVANCE" }) as never, "t1", "l1")).toBeNull()
  })
})

describe("checkPurchaseValuation (C7)", () => {
  it("a current assessor's or dealer's valuation of the asset, recorded by someone else: its amount", async () => {
    expect(await check(tx({ valuation: valuation("2027-06-30"), maxAge: 30 }))).toEqual({ ok: true, amountCents: 50_000_000 })
    expect(await check(tx({ valuation: valuation("2027-06-30", { source: "DEALER" }), maxAge: 30 }))).toMatchObject({ ok: true })
  })
  it("refuses a valuation not of this asset", async () => {
    const t = tx({ maxAge: 30 })
    expect(await check(t)).toMatchObject({ ok: false, reason: "valuation" })
    expect(t.assetValuation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "v1", tenantId: "t1", assetId: "a1" } }))
  })
  it.each(["INTERNAL", "AUCTIONEER"])("refuses a %s valuation (not market value)", async (source) => {
    expect(await check(tx({ valuation: valuation("2027-06-30", { source }), maxAge: 30 }))).toMatchObject({ ok: false, reason: "valuation_source" })
  })
  it("refuses a valuation the elector recorded; the lessee in the portal (no elector) is not checked", async () => {
    const own = valuation("2027-06-30", { createdById: "elector" })
    expect(await check(tx({ valuation: own, maxAge: 30 }))).toMatchObject({ ok: false, reason: "valuation_four_eyes" })
    expect(await check(tx({ valuation: own, maxAge: 30 }), null)).toMatchObject({ ok: true })
  })
  it("ages: exactly the tenant's maximum is current, a day more is stale; 30 days without a setting", async () => {
    expect(await check(tx({ valuation: valuation("2027-06-20"), maxAge: 10 }))).toMatchObject({ ok: true })
    expect(await check(tx({ valuation: valuation("2027-06-19"), maxAge: 10 }))).toMatchObject({ ok: false, reason: "valuation_stale" })
    expect(await check(tx({ valuation: valuation("2027-05-31") }))).toMatchObject({ ok: true })
    expect(await check(tx({ valuation: valuation("2027-05-30") }))).toMatchObject({ ok: false, reason: "valuation_stale" })
  })
})

describe("bestMarketValuation", () => {
  it("asks for the highest current assessor's or dealer's valuation", async () => {
    const t = tx({ valuation: valuation("2027-06-30"), maxAge: 10 })
    await bestMarketValuation(t as never, "t1", "a1", "2027-06-30")
    expect(t.assetValuation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "t1", assetId: "a1", source: { in: ["ASSESSOR", "DEALER"] }, valuedOn: { gte: dbDate("2027-06-20") } },
      orderBy: [{ amountCents: "desc" }, { valuedOn: "desc" }, { id: "asc" }],
    }))
  })
})
