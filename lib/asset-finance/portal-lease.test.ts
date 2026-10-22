import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findPortalLease: vi.fn(),
  loan: vi.fn(), reading: vi.fn(), voided: vi.fn(async (_args: { where: unknown }) => [] as unknown[]), quote: vi.fn(), config: vi.fn(), valuation: vi.fn(), charges: vi.fn(),
}))
vi.mock("./lease-portal-route", () => ({ findPortalLease: mocks.findPortalLease }))
vi.mock("@/lib/portal/loan-charges", () => ({ portalLoanCharges: mocks.charges }))
vi.mock("@/lib/audit", () => ({ AuditAction: {}, logAuditStrict: vi.fn() }))
vi.mock("./meter-readings", () => ({ recordMeterReading: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findFirst: mocks.loan },
    assetMeterReading: { findFirst: mocks.reading, findMany: mocks.voided },
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
  leaseRentals: [], repaymentSchedule: [], maintenanceFund: null, ...over,
})
const ON = { featureCrm: false, featureIms: false, featureAssetFinance: true, leasePurchaseValuationMaxAgeDays: 30 }
const NO_CHARGES = { outstanding: 0, lines: [], settlementAmount: null }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findPortalLease.mockResolvedValue({ entityId: null })
  mocks.reading.mockResolvedValue(null)
  mocks.quote.mockResolvedValue(null)
  mocks.config.mockResolvedValue(ON)
  mocks.valuation.mockResolvedValue(null)
  mocks.charges.mockResolvedValue(NO_CHARGES)
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

  it("reads the loan's start and maturity timestamps (SAST midnight) as their SAST calendar days", async () => {
    mocks.loan.mockResolvedValue(baseLoan({ startDate: new Date("2026-12-31T22:00:00Z"), maturityDate: new Date("2029-12-30T22:00:00Z") }))
    const view = await loadPortalLease("t1", "c1", "L1", at("2027-03-15"))
    expect([view?.loan.startDate, view?.loan.maturityDate]).toEqual(["2027-01-01", "2029-12-31"])
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
    mocks.reading.mockResolvedValue({ readingDate: new Date("2027-03-01T00:00:00Z"), value: 9_000, source: "TELEMATICS" })
    mocks.voided.mockResolvedValue([{ readingDate: new Date("2027-02-01T00:00:00Z"), value: 90_000, voidedAt: new Date("2027-02-03T08:00:00Z") }])
    const view = await loadPortalLease("t1", "c1", "L1", at("2027-03-15"))
    expect(view?.fund).toMatchObject({ balanceCents: 16_000, riskModel: "LENDER_RISK", claims: [{ provider: "TEST Workshop", description: "Synthetic service", status: "PAID" }] })
    expect(view?.meter).toEqual({ unit: "KM", latest: { readingDate: "2027-03-01", value: 9_000, source: "TELEMATICS" }, voided: [{ readingDate: "2027-02-01", value: 90_000, voidedOn: "2027-02-03" }] })
    // This lease's readings, not the asset's: an asset leased before carries an older lease's readings. A voided one is never the meter.
    expect(mocks.reading.mock.calls[0][0].where).toEqual({ tenantId: "t1", loanId: "L1", unit: "KM", voidedAt: null })
    expect(mocks.voided.mock.calls[0][0].where).toEqual({ tenantId: "t1", loanId: "L1", unit: "KM", voidedAt: { not: null } })
    expect(view?.termination.penaltyConfigured).toBe(false)
  })

  it("looks for a purchase valuation within the tenant's days, as the end-of-term route does", async () => {
    mocks.loan.mockResolvedValue(baseLoan())
    mocks.config.mockResolvedValue({ ...ON, leasePurchaseValuationMaxAgeDays: 10 })
    mocks.valuation.mockResolvedValue({ valuedOn: new Date("2027-03-10T00:00:00Z"), amountCents: 40_000_000 })
    const view = await loadPortalLease("t1", "c1", "L1", at("2027-03-15"))
    const where = mocks.valuation.mock.calls[0][0].where as { valuedOn: { gte: Date }; source: { in: string[] } }
    expect(where.source.in).toEqual(["ASSESSOR", "DEALER"]) // market value: never an internal or forced-sale figure
    expect(where.valuedOn.gte.toISOString().slice(0, 10)).toBe("2027-03-05")
    expect(view?.endOfTerm.valuation).toEqual({ valuedOn: "2027-03-10", amountExclVatCents: 40_000_000 })
  })

  it("serves no lease while the tenant's asset-finance module is off, or has no config", async () => {
    for (const config of [{ ...ON, featureAssetFinance: false }, null]) {
      mocks.config.mockResolvedValue(config)
      mocks.loan.mockResolvedValue(baseLoan())
      expect(await loadPortalLease("t1", "c1", "L1", at("2027-03-15"))).toBeNull()
    }
    expect(mocks.config).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1" } }))
    expect(mocks.findPortalLease).not.toHaveBeenCalled()
    expect(mocks.loan).not.toHaveBeenCalled()
  })

  it("scopes every read to the tenant and the lease", async () => {
    mocks.loan.mockResolvedValue(baseLoan())
    await loadPortalLease("t1", "c1", "L1", at("2027-03-15"))
    expect(mocks.loan.mock.calls[0][0].where).toEqual({ id: "L1", tenantId: "t1", contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } })
    expect(mocks.quote.mock.calls[0][0].where).toEqual({ tenantId: "t1", loanId: "L1" })
    expect(mocks.valuation.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", assetId: "a1" })
    expect(mocks.charges).toHaveBeenCalledWith("t1", "L1", at("2027-03-15"))
    // The other charges are the loan's schedule rows that are not rentals.
    expect(mocks.loan.mock.calls[0][0].select.repaymentSchedule.where).toEqual({ leaseRental: { is: null } })
  })

  it("lists the end-of-term and termination charges with their invoices, and adds them and the default charges to what is overdue", async () => {
    mocks.loan.mockResolvedValue(baseLoan({
      leaseRentals: [rental(1, "2027-01-01", 26_500)],
      repaymentSchedule: [
        { id: "s9", dueDate: new Date("2027-02-28T22:00:00Z"), totalDue: 50_000, totalPaid: 20_000, leaseEndOfTermCharge: { taxInvoice: { id: "inv9", invoiceNumber: "TI-9" } }, leaseTerminationCharge: null },
        { id: "s10", dueDate: new Date("2027-03-31T22:00:00Z"), totalDue: 80_000, totalPaid: 0, leaseEndOfTermCharge: null, leaseTerminationCharge: { taxInvoice: { id: "inv10", invoiceNumber: "TI-10" } } },
      ],
    }))
    mocks.charges.mockResolvedValue({ outstanding: 7_000, lines: [{ label: "Default interest", amount: 5_000 }, { label: "Letter fee", amount: 2_000 }], settlementAmount: 999 })
    const view = await loadPortalLease("t1", "c1", "L1", at("2027-03-15"))
    expect(view?.otherCharges).toEqual([
      { id: "s9", kind: "END_OF_TERM", dueDate: "2027-03-01", totalCents: 50_000, paidCents: 20_000, outstandingCents: 30_000, state: "OVERDUE", invoice: { id: "inv9", invoiceNumber: "TI-9" } },
      { id: "s10", kind: "TERMINATION", dueDate: "2027-04-01", totalCents: 80_000, paidCents: 0, outstandingCents: 80_000, state: "PENDING", invoice: { id: "inv10", invoiceNumber: "TI-10" } },
    ])
    expect(view?.arrearsCents).toBe(100_000)
    expect(view?.defaultCharges).toEqual({ outstandingCents: 7_000, lines: [{ label: "Default interest", amount: 5_000 }, { label: "Letter fee", amount: 2_000 }] })
    // 100 000 overdue rental + 30 000 overdue end-of-term charge + 7 000 default charges; the termination charge is not yet due.
    expect(view?.overdueInclChargesCents).toBe(137_000)
  })

  it("says whether the end of term has been inspected", async () => {
    mocks.loan.mockResolvedValue(baseLoan({ leaseEndOfTerm: { outcome: "RETURN", status: "INSPECTED", origin: "EXPIRY", inspectedOn: new Date("2029-12-31T00:00:00Z") } }))
    expect((await loadPortalLease("t1", "c1", "L1", at("2030-01-05")))?.endOfTerm.chosen).toEqual({ outcome: "RETURN", status: "INSPECTED", early: false, inspected: true })
    mocks.loan.mockResolvedValue(baseLoan({ leaseEndOfTerm: { outcome: "RETURN", status: "ELECTED", origin: "EARLY_TERMINATION", inspectedOn: null } }))
    expect((await loadPortalLease("t1", "c1", "L1", at("2030-01-05")))?.endOfTerm.chosen).toEqual({ outcome: "RETURN", status: "ELECTED", early: true, inspected: false })
  })
})
