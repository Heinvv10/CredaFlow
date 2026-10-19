import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ findFirst: vi.fn(), loadDealExceptions: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { assetFinanceDeal: { findFirst: m.findFirst }, entityRelationship: { findMany: vi.fn() } } }))
vi.mock("./deal-exceptions", () => ({ loadDealExceptions: m.loadDealExceptions }))
vi.mock("./deal-bureau-results", () => ({ loadDealBureauResults: vi.fn(async () => []) }))
vi.mock("./deal-terms", () => ({
  DEAL_STRUCTURE_SELECT: {},
  solveStoredDeal: vi.fn(async () => null),
  termsFromDeal: vi.fn(() => ({})),
}))
vi.mock("./lease-structure", () => ({ isLeaseTerms: () => false }))

import { loadDealDetail } from "./deal-detail"

const deal = {
  id: "deal-1", status: "CONTRACTED", contractType: "INSTALMENT_SALE", createdAt: new Date("2026-01-01T00:00:00Z"),
  baseInstalmentCents: 1000, entityId: null, loanId: "loan-booked", decision: null, decisionReasons: [],
  decidedById: null, decidedAt: null, plannedStartDate: null,
  application: { id: "app-1", reference: "APP-1", status: "APPROVED", ncaRegime: "NCA", ncaClassificationRule: null,
    decisionReason: null, appliedAmount: 1, appliedTermDays: 1, product: { id: "p", name: "P" }, ncaRegimeOverrides: [] },
  entity: null, client: { id: "client-1", firstName: "Test", lastName: "Person", idNumber: "0000000000000" },
  asset: { id: "a", make: "M", model: "X", year: 2026, serialNumber: "S", cashPriceExclVatCents: 1, vatCents: 0 },
  supplier: null, financials: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  m.findFirst.mockResolvedValue(deal)
  m.loadDealExceptions.mockResolvedValue({})
})

describe("loadDealDetail", () => {
  it("passes the deal's own booked loan to loadDealExceptions so it is not counted as existing exposure", async () => {
    await loadDealDetail("tenant-1", "deal-1")
    expect(m.loadDealExceptions).toHaveBeenCalledWith(expect.anything(), "tenant-1", {
      applicationId: "app-1", entityId: null, clientId: "client-1", loanId: "loan-booked",
    })
  })
})
