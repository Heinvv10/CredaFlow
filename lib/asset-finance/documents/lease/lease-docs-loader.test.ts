import { beforeEach, describe, expect, it, vi } from "vitest"

// EXTENSION_NOTICE_MONTHS lives in a module with server-only imports (see portal-lease-view.test.ts).
vi.mock("@/lib/audit", () => ({ AuditAction: {}, logAuditStrict: vi.fn() }))
vi.mock("../../lease-portal-route", () => ({ clientLeaseRefusal: vi.fn() }))
vi.mock("../../meter-readings", () => ({ recordMeterReading: vi.fn() }))

import { loadExpiryNotice, loadInspectionReport, loadTerminationQuote, type LeaseDocsDb } from "./lease-docs-loader"
import { END_ROW, LOAN_ROW, NOTICE, NOTICE_ROW, QUOTE, QUOTE_ROW, REPORT, START_READING_ROW } from "./lease-docs.fixture"

// The loaders behind the lease servicing documents (C9), on a mocked
// transaction: what each passes to its renderer, how every read is scoped,
// and the DRAFT decision (the watermark comes off only once the lender's
// legal team has approved the wording).

const m = {
  notice: vi.fn(),
  quote: vi.fn(),
  end: vi.fn(),
  reading: vi.fn(),
  config: vi.fn(),
}
const db = {
  leaseExpiryNotice: { findFirst: m.notice },
  leaseTerminationQuote: { findFirst: m.quote },
  leaseEndOfTerm: { findFirst: m.end },
  assetMeterReading: { findFirst: m.reading },
  tenantConfig: { findUnique: m.config },
} as unknown as LeaseDocsDb

const LEASES = { contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } }
const whereOf = (mock: ReturnType<typeof vi.fn>) => (mock.mock.calls[0][0] as { where: unknown }).where

beforeEach(() => {
  vi.clearAllMocks()
  m.notice.mockResolvedValue(NOTICE_ROW)
  m.quote.mockResolvedValue(QUOTE_ROW)
  m.end.mockResolvedValue(END_ROW)
  m.reading.mockResolvedValue(START_READING_ROW)
  m.config.mockResolvedValue({ assetFinanceLegalWordingApproved: false })
})

const LOADERS = [
  ["expiry notice", () => loadExpiryNotice(db, "t-1", "loan-1")],
  ["termination quote", () => loadTerminationQuote(db, "t-1", "loan-1", "quote-1")],
  ["inspection report", () => loadInspectionReport(db, "t-1", "loan-1")],
] as const

describe("the DRAFT watermark decision", () => {
  it.each(LOADERS)("the %s is a draft unless the tenant's legal wording is approved", async (_name, load) => {
    for (const config of [{ assetFinanceLegalWordingApproved: false }, null, {}]) {
      m.config.mockResolvedValueOnce(config)
      expect((await load())?.draft, JSON.stringify(config)).toBe(true)
    }
    m.config.mockResolvedValueOnce({ assetFinanceLegalWordingApproved: true })
    expect((await load())?.draft).toBe(false)
    expect(m.config).toHaveBeenCalledWith({ where: { tenantId: "t-1" }, select: { assetFinanceLegalWordingApproved: true } })
  })
})

describe("loadExpiryNotice", () => {
  it("passes the lessee, goods, notice dates and the extension notice, read from the tenant's lease", async () => {
    expect(await loadExpiryNotice(db, "t-1", "loan-1")).toEqual(NOTICE)
    expect(whereOf(m.notice)).toEqual({ tenantId: "t-1", loanId: "loan-1", loan: LEASES })
  })

  it("names a sole proprietor lessee and says when no asset is recorded", async () => {
    m.notice.mockResolvedValue({ ...NOTICE_ROW, loan: { ...LOAN_ROW, entity: null, client: { firstName: "Test", lastName: "Trader" }, asset: null } })
    expect(await loadExpiryNotice(db, "t-1", "loan-1")).toMatchObject({ lessee: "Test Trader", asset: "—" })
  })

  it("is null when the lease has no notice", async () => {
    m.notice.mockResolvedValue(null)
    expect(await loadExpiryNotice(db, "t-1", "loan-1")).toBeNull()
    expect(m.config).not.toHaveBeenCalled()
  })
})

describe("loadTerminationQuote", () => {
  it("passes every figure of the quote and its dates, read by the quote id within the tenant's lease", async () => {
    expect(await loadTerminationQuote(db, "t-1", "loan-1", "quote-1")).toEqual(QUOTE)
    expect(whereOf(m.quote)).toEqual({ id: "quote-1", tenantId: "t-1", loanId: "loan-1", loan: LEASES })
  })

  it("is null for a quote of another lease or tenant", async () => {
    m.quote.mockResolvedValue(null)
    expect(await loadTerminationQuote(db, "t-1", "loan-1", "quote-9")).toBeNull()
  })
})

describe("loadInspectionReport", () => {
  it("passes the inspection, damage, excess and both readings; the start reading is the lease's earliest in the final reading's unit", async () => {
    expect(await loadInspectionReport(db, "t-1", "loan-1")).toEqual(REPORT)
    expect(whereOf(m.end)).toEqual({ tenantId: "t-1", loanId: "loan-1", inspectedOn: { not: null }, loan: LEASES })
    expect(m.reading).toHaveBeenCalledWith({
      where: { tenantId: "t-1", loanId: "loan-1", unit: "HOURS", voidedAt: null },
      orderBy: [{ readingDate: "asc" }, { value: "asc" }],
      select: { value: true, readingDate: true, unit: true },
    })
  })

  it("reads no start reading without a final one, and says when no condition was recorded", async () => {
    m.end.mockResolvedValue({ ...END_ROW, finalReading: null, inspectionCondition: null })
    expect(await loadInspectionReport(db, "t-1", "loan-1")).toMatchObject({ startReading: null, finalReading: null, condition: "Not recorded" })
    expect(m.reading).not.toHaveBeenCalled()
  })

  it("is null until an inspection has been recorded", async () => {
    m.end.mockResolvedValue(null)
    expect(await loadInspectionReport(db, "t-1", "loan-1")).toBeNull()
  })
})
