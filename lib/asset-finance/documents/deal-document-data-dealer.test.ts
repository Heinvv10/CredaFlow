// loadDealDocumentData hands the deal's introducer to the documents: it selects
// the dealer's name and kind, and returns them (or none). The graph that solves
// the schedule is stubbed; this is the load's pass-through, which the document
// renderers' tests cannot see. The real-Postgres proof is
// templates/commission-reapproval.integration.test.ts.
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/config/identity", () => ({
  getLenderIdentity: vi.fn(async () => ({ legalName: "TEST Lender", tradingName: "TEST", companyRegNumber: "2000/000000/07", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road"] })),
}))
vi.mock("../deal-structure", () => ({
  resolveRate: vi.fn(async () => ({ annualRate: "0.1175", reference: null })),
  solveDealStructure: vi.fn(() => ({
    ok: true, termDays: 365, startDate: "2026-12-31", rate: { annualRate: "0.1175", reference: null },
    result: { financedAmountCents: 100, baseInstalmentCents: 10, totalInterestCents: 5, totalPayableCents: 105, rows: [] },
  })),
}))
vi.mock("../deal-terms", () => ({
  DEAL_STRUCTURE_SELECT: {},
  termsFromDeal: () => ({ rate: { basis: "FIXED", margin: null, fixedRate: "0.1175" } }),
}))
vi.mock("./lease/lease-document-data", () => ({ leaseDocumentTerms: vi.fn(async () => null), soleProprietorOf: vi.fn() }))

import { loadDealDocumentData, type DocumentDataDb } from "./deal-document-data"

const row = {
  decidedAt: new Date("2026-10-13T08:00:00Z"), entityId: "e1", contractType: "INSTALMENT_SALE", cpaApplies: false, isaCpaApplies: false, cpaRule: null,
  client: null, depositCents: 0, tradeInCents: 0, financedFeesCents: 0, balloonCents: 0, rateBasis: "FIXED", rateMargin: null, fixedRate: null, structurePreset: "MONTHLY",
  plannedStartDate: null, signedArrearsMarginRate: null, signedCollectionFeeCents: null, preparedSigners: null,
  application: { reference: "AF-TEST", approvedTermDays: 365, ncaRegime: "NON_NCA", product: { minTermDays: 30, maxTermDays: 3650, nonNcaDefaultInterestMargin: null, nonNcaCollectionFeeCents: 0 } },
  entity: { type: "COMPANY", legalName: "TEST Entity", tradingName: null, registrationNumber: "2099/000001/07", mastersReference: null, vatNumber: null, addressLine1: null, addressLine2: null, city: null, province: null, postalCode: null },
  asset: { assetClass: "TLB", make: "TEST", model: "TLB", year: 2026, serialNumber: "SN", vin: null, engineNumber: null, registrationNumber: null, cashPriceExclVatCents: 100, vatCents: 15 },
  supplier: { name: "TEST Supplier", registrationNumber: null, vatNumber: null },
}

function dbWith(dealer: { name: string; kind: "DEALER" | "BROKER" } | null) {
  const findFirst = vi.fn(async () => ({ ...row, dealer }))
  const db = {
    assetFinanceDeal: { findFirst }, entityRelationship: { findMany: vi.fn(async () => []) },
    tenantConfig: { findUnique: vi.fn(async () => ({ assetFinanceLegalWordingApproved: false })) },
  } as unknown as DocumentDataDb
  return { db, findFirst }
}
const load = (db: DocumentDataDb) => loadDealDocumentData(db, "t1", "d1", { plannedStartDate: "2026-12-31" })

describe("loadDealDocumentData: the introducer", () => {
  it.each([
    ["a dealer", { name: "SAMPLE Dealer Motors", kind: "DEALER" as const }],
    ["a broker", { name: "SAMPLE Broker Desk", kind: "BROKER" as const }],
  ])("selects the name and kind and returns %s", async (_, dealer) => {
    const { db, findFirst } = dbWith(dealer)
    const data = await load(db)
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ dealer: { select: { name: true, kind: true } } }) }))
    expect(data?.dealer).toEqual(dealer)
  })

  it("returns none for a deal no dealer introduced", async () => {
    expect((await load(dbWith(null).db))?.dealer).toBeNull()
  })
})
