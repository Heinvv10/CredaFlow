import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findPortalLease: vi.fn(),
  loan: vi.fn(), reading: vi.fn(), quote: vi.fn(), config: vi.fn(), valuation: vi.fn(),
}))
vi.mock("./lease-portal-route", () => ({ findPortalLease: mocks.findPortalLease }))
vi.mock("@/lib/audit", () => ({ AuditAction: {}, logAuditStrict: vi.fn() }))
vi.mock("./meter-readings", () => ({ recordMeterReading: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findFirst: mocks.loan },
    assetMeterReading: { findFirst: mocks.reading },
    leaseTerminationQuote: { findFirst: mocks.quote },
    tenantConfig: { findUnique: mocks.config },
    assetValuation: { findFirst: mocks.valuation },
  },
}))

import { loadPortalLease } from "./portal-lease"

const at = (iso: string) => new Date(`${iso}T10:00:00+02:00`)
const rental = (periodNo: number, due: string, paid: number, over: Record<string, unknown> = {}) => ({
  id: `r${periodNo}`, periodNo, dueDate: new Date(`${due}T00:00:00Z`), rentalExclVatCents: 100_000, maintenanceExclVatCents: 10_000, vatCents: 16_500, totalCents: 126_500,
  cancelledAt: null, schedule: { totalPaid: paid }, taxInvoice: null, ...over,
})
const baseLoan = (over: Record<string, unknown> = {}) => ({
  id: "L1", reference: "TEST-LS-1", status: "ACTIVE", contractType: "OPERATING_LEASE", startDate: new Date("2027-01-01T00:00:00Z"), maturityDate: new Date("2029-12-31T00:00:00Z"),
  assetId: "a1", entity: null, asset: null, assetFinanceDeal: { usageUnit: null, earlyTerminationPenaltyRate: "0.05" }, leaseEndOfTerm: null,
  leaseRentals: [], maintenanceFund: null, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findPortalLease.mockResolvedValue({ entityId: null })
  mocks.reading.mockResolvedValue(null)
  mocks.quote.mockResolvedValue(null)
  mocks.config.mockResolvedValue(null)
  mocks.valuation.mockResolvedValue(null)
})

describe("loadPortalLease", () => {
  it("reads nothing for a client the lease gate refuses", async () => {
    mocks.findPortalLease.mockResolvedValue(null)
    expect(await loadPortalLease("t1", "c-other", "L1", at("2027-03-15"))).toBeNull()
    expect(mocks.findPortalLease).toHaveBeenCalledWith("t1", "c-other", "L1")
    expect(mocks.loan).not.toHaveBeenCalled()
  })

  it("states paid, overdue and cancelled rentals and what is overdue and next", async () => {
    mocks.loan.mockResolvedValue(baseLoan({
      leaseRentals: [
        rental(1, "2027-01-01", 126_500, { taxInvoice: { id: "inv1", invoiceNumber: "TI-1" } }),
        rental(2, "2027-02-01", 26_500),
        rental(3, "2027-03-01", 0, { cancelledAt: new Date("2027-03-02T00:00:00Z") }),
        rental(4, "2027-04-01", 0),
      ],
    }))
    const view = await loadPortalLease("t1", "c1", "L1", at("2027-03-15"))
    expect(view?.rentals.map((r) => [r.periodNo, r.state, r.outstandingCents])).toEqual([[1, "PAID", 0], [2, "OVERDUE", 100_000], [3, "CANCELLED", 0], [4, "PENDING", 126_500]])
    expect(view?.rentals[0].invoice).toEqual({ id: "inv1", invoiceNumber: "TI-1" })
    expect(view?.arrearsCents).toBe(100_000)
    expect(view?.nextRental).toEqual({ dueDate: "2027-04-01", amountCents: 126_500 })
  })

  it("has no fund and no meter on an operating lease without usage", async () => {
    mocks.loan.mockResolvedValue(baseLoan())
    const view = await loadPortalLease("t1", "c1", "L1", at("2027-03-15"))
    expect(view?.fund).toBeNull()
    expect(view?.meter).toBeNull()
    expect(mocks.reading).not.toHaveBeenCalled()
  })

  it("derives the fund balance from its movements and lists the claims, on a full-maintenance lease", async () => {
    mocks.loan.mockResolvedValue(baseLoan({
      contractType: "FULL_MAINTENANCE_LEASE", assetFinanceDeal: { usageUnit: "KM", earlyTerminationPenaltyRate: null },
      maintenanceFund: {
        riskModel: "LENDER_RISK",
        movements: [{ kind: "CONTRIBUTION", amountCents: 10_000 }, { kind: "CONTRIBUTION", amountCents: 10_000 }, { kind: "CLAIM", amountCents: 4_000 }],
        claims: [{ id: "c1", submittedAt: new Date("2027-02-10T08:00:00Z"), description: "Synthetic service", amountExclVatCents: 4_000, status: "PAID", supplier: { name: "TEST Workshop" } }],
      },
    }))
    mocks.reading.mockResolvedValue({ readingDate: new Date("2027-03-01T00:00:00Z"), value: 9_000 })
    const view = await loadPortalLease("t1", "c1", "L1", at("2027-03-15"))
    expect(view?.fund).toMatchObject({ balanceCents: 16_000, riskModel: "LENDER_RISK", claims: [{ provider: "TEST Workshop", description: "Synthetic service", status: "PAID" }] })
    expect(view?.meter).toEqual({ unit: "KM", latest: { readingDate: "2027-03-01", value: 9_000 } })
    expect(view?.termination.penaltyConfigured).toBe(false)
  })

  it("looks for a purchase valuation within the tenant's days, as the end-of-term route does", async () => {
    mocks.loan.mockResolvedValue(baseLoan())
    mocks.config.mockResolvedValue({ leasePurchaseValuationMaxAgeDays: 10 })
    mocks.valuation.mockResolvedValue({ valuedOn: new Date("2027-03-10T00:00:00Z"), amountCents: 40_000_000 })
    const view = await loadPortalLease("t1", "c1", "L1", at("2027-03-15"))
    const where = mocks.valuation.mock.calls[0][0].where as { valuedOn: { gte: Date } }
    expect(where.valuedOn.gte.toISOString().slice(0, 10)).toBe("2027-03-05")
    expect(view?.endOfTerm.valuation).toEqual({ valuedOn: "2027-03-10", amountExclVatCents: 40_000_000 })
  })
})
