import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The staff lease panel's loader on a mocked Prisma (the style of
// lib/asset-finance/portal-lease.test.ts): what it derives from the rows, and
// that every read is the tenant's lease.
const mocks = vi.hoisted(() => ({ loan: vi.fn(), config: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { loan: { findFirst: mocks.loan }, tenantConfig: { findUnique: mocks.config } } }))
// The window and expiry constants live in modules with server-only imports (see portal-lease-view.test.ts).
vi.mock("@/lib/audit", () => ({ AuditAction: {}, logAuditStrict: vi.fn() }))
vi.mock("@/lib/asset-finance/lease-portal-route", () => ({ clientLeaseRefusal: vi.fn() }))
vi.mock("@/lib/asset-finance/meter-readings", () => ({ recordMeterReading: vi.fn() }))
vi.mock("@/lib/asset-finance/reprice-notice", () => ({ alertLoanAdmins: vi.fn() }))

import { loadLeaseStaffData } from "./lease-staff-data"

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
/** SAST midnight of a calendar day: 22:00Z the day before, as loan dates are stored. */
const sastMidnight = (iso: string) => new Date(`${iso}T00:00:00+02:00`)

const rental = (periodNo: number, due: string, over: Record<string, unknown> = {}) => ({
  periodNo, dueDate: day(due), rentalExclVatCents: 100_000, maintenanceExclVatCents: 0, vatCents: 15_000, totalCents: 115_000,
  cancelledAt: null, taxInvoice: null, schedule: { status: "PENDING" }, ...over,
})
// Twelve monthly rentals from Feb 2030 to Jan 2031, and a thirteenth cancelled by an early termination.
const RENTALS = [
  ...Array.from({ length: 12 }, (_, i) => rental(i + 1, `${2030 + Math.floor((i + 1) / 12)}-${String(((i + 1) % 12) + 1).padStart(2, "0")}-01`)),
  rental(13, "2031-02-01", { cancelledAt: new Date("2030-07-01T08:00:00Z") }),
]

const deal = (over: Record<string, unknown> = {}) => ({
  id: "deal-1", rentalTiming: "ARREARS", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1",
  usageUnit: "HOURS", usageAllowancePerYear: 1_200, excessRateCents: 4_500, ...over,
})

const loanRow = (over: Record<string, unknown> = {}) => ({
  id: "loan-1", status: "ACTIVE", contractType: "FULL_MAINTENANCE_LEASE", cpaApplies: false, assetId: "asset-1",
  startDate: sastMidnight("2030-01-01"), maturityDate: sastMidnight("2031-01-01"),
  asset: { registrationNumber: "TEST-REG-1" },
  assetFinanceDeal: deal(),
  leaseRentals: RENTALS,
  meterReadings: [
    { id: "r-2", readingDate: day("2030-07-02"), value: 1_000, source: "PORTAL" },
    { id: "r-1", readingDate: day("2030-01-01"), value: 100, source: "STAFF" },
  ],
  maintenanceFund: {
    riskModel: "LENDER_RISK", leaseEndDate: day("2031-01-01"), settledAt: null,
    movements: [
      { id: "m-4", kind: "SETTLEMENT_BILLED", amountCents: 1_000, occurredOn: day("2030-06-01"), leaseRental: null },
      { id: "m-3", kind: "CLAIM", amountCents: 4_000, occurredOn: day("2030-05-09"), leaseRental: null },
      { id: "m-2", kind: "CONTRIBUTION", amountCents: 10_000, occurredOn: day("2030-03-01"), leaseRental: { periodNo: 2 } },
      { id: "m-1", kind: "CONTRIBUTION", amountCents: 10_000, occurredOn: day("2030-02-01"), leaseRental: { periodNo: 1 } },
    ],
    claims: [],
  },
  leaseEndOfTerm: null,
  leaseExpiryNotice: null,
  leaseTerminationQuotes: [],
  ...over,
})

const endOfTerm = (outcome: string) => ({
  outcome, status: "INVOICED", origin: "EXPIRY", electedAt: new Date("2030-07-05T08:00:00Z"), extensionNoticeOn: null, extensionEndsOn: null,
  inspectedOn: null, inspectionCondition: null, finalReading: null, damageItems: [], purchasePriceExclVatCents: 5_000_000, excessUsageCents: null,
  fundSettlementCents: null, taxInvoice: { id: "inv-1", invoiceNumber: "INV-000001" }, natisTransferConfirmedAt: null, completedAt: null,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2030-07-15T10:00:00+02:00"))
  mocks.loan.mockResolvedValue(loanRow())
  mocks.config.mockResolvedValue(null)
})
afterEach(() => vi.useRealTimers())

describe("loadLeaseStaffData", () => {
  it("reads the tenant's lease and the tenant's settings only", async () => {
    await loadLeaseStaffData("t-1", "loan-1")
    expect(mocks.loan.mock.calls[0][0].where).toEqual({ id: "loan-1", tenantId: "t-1", contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } })
    expect(mocks.config.mock.calls[0][0].where).toEqual({ tenantId: "t-1" })
  })

  it.each([
    ["no deal", { assetFinanceDeal: null }],
    ["no rental timing", { assetFinanceDeal: deal({ rentalTiming: null }) }],
    ["no escalation", { assetFinanceDeal: deal({ escalationRate: null }) }],
    ["no penalty", { assetFinanceDeal: deal({ earlyTerminationPenaltyRate: null }) }],
  ])("is null without the lease's deal terms (%s), and for a loan that is not the tenant's lease", async (_name, over) => {
    mocks.loan.mockResolvedValue(loanRow(over))
    expect(await loadLeaseStaffData("t-1", "loan-1")).toBeNull()
    mocks.loan.mockResolvedValue(null)
    expect(await loadLeaseStaffData("t-1", "loan-1")).toBeNull()
  })

  it("reads the stored maturity timestamp as its SAST day, and dates the election window from it", async () => {
    const data = await loadLeaseStaffData("t-1", "loan-1")
    expect(data?.today).toBe("2030-07-15")
    expect(data?.maturityDate).toBe("2031-01-01") // stored as 2030-12-31T22:00Z
    expect(data?.expiryDate).toBe("2031-01-01")
    expect(data?.electionOpensOn).toBe("2030-07-01")
  })

  it("sums the fund's balance, contributions and claims from its movements, with the default dual-approval threshold", async () => {
    // A billed settlement adds to the balance but is neither a contribution nor a claim.
    const fund = (await loadLeaseStaffData("t-1", "loan-1"))?.fund
    expect(fund).toMatchObject({ balanceCents: 17_000, contributedCents: 20_000, claimedCents: 4_000, dualApprovalCents: 5_000_000, leaseEndDate: "2031-01-01" })
    expect(fund?.movements.map((m) => m.periodNo)).toEqual([null, null, 2, 1])
    mocks.config.mockResolvedValue({ maintenanceClaimDualApprovalCents: 1_000_000, leasePurchaseValuationMaxAgeDays: 14 })
    const configured = await loadLeaseStaffData("t-1", "loan-1")
    expect(configured?.fund?.dualApprovalCents).toBe(1_000_000)
    expect(configured?.purchaseMaxAgeDays).toBe(14)
  })

  it("projects the usage per day to the term's end over the rentals not cancelled", async () => {
    // 900 hours in 182 days → 1 805 by the 365th day; 12 rentals (the cancelled 13th excluded) allow 1 200.
    // Excess 605 hours at R45.00 = R27 225.00.
    const usage = (await loadLeaseStaffData("t-1", "loan-1"))?.usage
    // The tile shows the usage the excess is priced on (1 805), not the meter reading (1 905, which includes the 100 h start).
    expect(usage).toEqual({ usedUnits: 900, projectedFinalReading: 1_905, projectedUsedUnits: 1_805, excessCents: 2_722_500, allowedUnits: 1_200 })
  })

  it("projects nothing from a single reading or without contracted usage", async () => {
    mocks.loan.mockResolvedValue(loanRow({ meterReadings: [{ id: "r-1", readingDate: day("2030-01-01"), value: 100, source: "STAFF" }] }))
    expect((await loadLeaseStaffData("t-1", "loan-1"))?.usage).toBeNull()
    mocks.loan.mockResolvedValue(loanRow({ assetFinanceDeal: deal({ usageUnit: null, usageAllowancePerYear: null, excessRateCents: null }) }))
    const data = await loadLeaseStaffData("t-1", "loan-1")
    expect(data?.usage).toBeNull()
    expect(data?.deal.usage).toBeNull()
  })

  it("asks for the eNaTIS change only on the purchase of a registered vehicle", async () => {
    mocks.loan.mockResolvedValue(loanRow({ leaseEndOfTerm: endOfTerm("PURCHASE") }))
    expect((await loadLeaseStaffData("t-1", "loan-1"))?.endOfTerm?.natisRequired).toBe(true)
    mocks.loan.mockResolvedValue(loanRow({ leaseEndOfTerm: endOfTerm("PURCHASE"), asset: { registrationNumber: "  " } }))
    expect((await loadLeaseStaffData("t-1", "loan-1"))?.endOfTerm?.natisRequired).toBe(false)
    mocks.loan.mockResolvedValue(loanRow({ leaseEndOfTerm: endOfTerm("RETURN") }))
    expect((await loadLeaseStaffData("t-1", "loan-1"))?.endOfTerm?.natisRequired).toBe(false)
  })

  it("states the expiry notice once queued", async () => {
    expect((await loadLeaseStaffData("t-1", "loan-1"))?.expiryNotice).toBeNull()
    mocks.loan.mockResolvedValue(loanRow({ leaseExpiryNotice: { queuedOn: day("2030-09-01") } }))
    expect((await loadLeaseStaffData("t-1", "loan-1"))?.expiryNotice).toEqual({ queuedOn: "2030-09-01" })
  })
})
