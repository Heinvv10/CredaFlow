import { beforeEach, describe, expect, it, vi } from "vitest"

// The dealer projection never leaks. Prisma is stubbed to hand back a row
// holding every column a careless select could reach, each a sentinel; the
// projection must carry none of them, its select must ask for none of them,
// and every query must filter on the caller's dealer.
const h = vi.hoisted(() => ({ findFirst: vi.fn(), findMany: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { assetFinanceDeal: { findFirst: h.findFirst, findMany: h.findMany } } }))

import { DEALER_DEAL_SELECT, dealerStatus, listDealerDeals, loadDealerDealView, projectDealerDeal } from "./deal-view"

const S = "SENTINEL-LEAK"
const actor = { tenantId: "tenant-1", dealerId: "dealer-1", dealerUserId: "du-1", email: "sales@dealer.example", dealerRole: "DEALER_SALES" as const }
const person = (id: string, by: string | null) => ({ id, firstName: `First-${id}`, lastName: `Last-${id}`, createdByDealerId: by, idNumber: S, email: S, phone: S })

/** A deal row as an over-broad query would return it: the whitelisted columns plus sentinels in everything else. */
function fullRow(over: Record<string, unknown> = {}) {
  return {
    id: "deal-1", createdAt: new Date("2026-10-01T08:00:00Z"), status: "DRAFT", dealerSubmittedAt: null, contractType: "INSTALMENT_SALE",
    baseInstalmentCents: 1_234_500, clientId: null,
    decision: S, decisionReasons: [S], approvalExceptions: [{ reason: S }], decidedById: S, rateMargin: S, fixedRate: S,
    dealerCommissionBps: 999_999, dealerCommissionSource: S, isaCpaRule: S, cpaEvidenceIds: [S],
    application: {
      reference: "AF-0001", appliedAmount: 150_000_000, approvedAmount: 987_654_321, ncaRegime: S, ncaClassificationRule: S,
      ncaClassificationInputs: { s: S }, decisionReason: S, affordabilityResult: S, creditScore: S,
    },
    entity: {
      legalName: "TEST Plant Hire (Pty) Ltd", annualTurnover: S, financialsEvidenceIds: [S], registrationNumber: S,
      relationships: [{ client: person("p1", "dealer-1") }, { client: person("p2", null) }, { client: person("p1", "dealer-1") }],
    },
    client: null,
    asset: { make: "TEST", model: "TLB-1", year: 2025, serialNumber: "TESTSER1", cashPriceExclVatCents: S },
    loan: null,
    signers: [], checklist: [{ item: "SUPPLIER_INVOICE_MATCHES_ASSET", required: true, confirmedAt: null, note: S }],
    dealerConsentAttestations: [{ clientId: "p1", verifiedAt: null, statementText: S }],
    dealerDocumentRequests: [{ id: "r1", docType: "BANK_STATEMENT", note: "Latest three months", requestedAt: new Date("2026-10-02T08:00:00Z"), fulfilledAt: null, requestedById: S }],
    documents: [{ id: "doc-1", docType: "POPIA_CONSENT", fileName: "consent.pdf", createdAt: new Date("2026-10-01T09:00:00Z"), storagePath: S, contentSha256: S }],
    dealerCommissionLines: [],
    payout: { amountCents: S, supplierBankAccountId: S },
    financials: { s: S }, affordabilityAssessment: { s: S }, bureauChecks: [{ s: S }], screening: { s: S },
    ...over,
  }
}
type Row = Parameters<typeof projectDealerDeal>[0]

const FORBIDDEN_KEYS = [
  "decision", "decisionReasons", "decisionReason", "approvalExceptions", "approvedAmount", "financials", "affordabilityAssessment",
  "affordabilityResult", "payout", "ncaRegime", "ncaClassificationRule", "ncaClassificationInputs", "bureauChecks", "screening",
  "dealerCommissionBps", "dealerCommissionSource", "storagePath", "idNumber", "annualTurnover", "dealer", "dealerUser",
]
function keysOf(value: unknown, out: string[] = []): string[] {
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); keysOf(v, out) }
  return out
}

beforeEach(() => {
  h.findFirst.mockReset()
  h.findMany.mockReset()
})

describe("the dealer projection", () => {
  it("carries no sentinel of the decision, reasons, financials, bureau, regime or payout", async () => {
    h.findFirst.mockResolvedValue(fullRow())
    const view = await loadDealerDealView(actor, "deal-1")
    expect(JSON.stringify(view)).not.toContain(S)
    expect(view).toMatchObject({ reference: "AF-0001", financedAmountCents: 150_000_000, status: "Draft", borrower: "TEST Plant Hire (Pty) Ltd" })
  })

  it("asks the database for none of those columns", () => {
    const asked = keysOf(DEALER_DEAL_SELECT)
    for (const key of FORBIDDEN_KEYS) expect(asked, key).not.toContain(key)
  })

  it("filters every query on the caller's lender and dealer", async () => {
    h.findFirst.mockResolvedValue(null)
    expect(await loadDealerDealView(actor, "deal-1")).toBeNull()
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "deal-1", tenantId: "tenant-1", dealerId: "dealer-1" } }))
    h.findMany.mockResolvedValue([])
    await listDealerDeals(actor)
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1", dealerId: "dealer-1" } }))
  })

  it("names only the people this dealer captured, once each", () => {
    const view = projectDealerDeal(fullRow() as unknown as Row, "dealer-1")
    expect(view.people).toEqual([
      { clientId: "p1", name: "First-p1 Last-p1", consentAttested: true },
      { clientId: "p2", name: "A person added by the lender", consentAttested: false },
    ])
    expect(JSON.stringify(view)).not.toContain("First-p2")
  })

  it("lists what is missing before signing (consents, requested documents), then the unconfirmed checklist", () => {
    expect(projectDealerDeal(fullRow() as unknown as Row, "dealer-1").missing).toEqual([
      "Consent: A person added by the lender", "Document: BANK_STATEMENT",
    ])
    expect(projectDealerDeal(fullRow({ status: "CONTRACTED" }) as unknown as Row, "dealer-1").missing).toEqual(["Checklist: SUPPLIER_INVOICE_MATCHES_ASSET"])
    expect(projectDealerDeal(fullRow({ status: "BOOKED" }) as unknown as Row, "dealer-1").missing).toEqual([])
  })

  it("shows a declined deal as Declined, with nothing of why", () => {
    const view = projectDealerDeal(fullRow({ status: "REFUSED_NCA" }) as unknown as Row, "dealer-1")
    expect(view.status).toBe("Declined")
    expect(JSON.stringify(view)).not.toContain(S)
  })

  it("shows the booking and the dealer's commission lines", () => {
    const view = projectDealerDeal(fullRow({
      status: "BOOKED",
      loan: { reference: "LN-1", startDate: new Date("2026-10-05T00:00:00Z") },
      dealerCommissionLines: [{ kind: "EARNED", effectiveOn: new Date("2026-10-05T00:00:00Z"), netCents: 100, vatCents: 15, grossCents: 115, reason: null }],
    }) as unknown as Row, "dealer-1")
    expect(view.booking).toEqual({ loanReference: "LN-1", bookedOn: "2026-10-05" })
    expect(view.commission).toEqual([{ kind: "EARNED", effectiveOn: "2026-10-05", netCents: 100, vatCents: 15, grossCents: 115, reason: null }])
  })
})

describe("dealerStatus", () => {
  it.each([
    ["DRAFT", null, "Draft"], ["DRAFT", new Date(), "In review"], ["SUBMITTED", null, "In review"], ["REFERRED", null, "In review"],
    ["APPROVED", null, "Approved"], ["CONTRACTED", null, "Signed"], ["BOOKED", null, "Booked"], ["DECLINED", null, "Declined"],
    ["REFUSED_NCA", null, "Declined"], ["CANCELLED", null, "Cancelled"],
  ] as const)("%s (submitted %s) → %s", (status, at, label) => {
    expect(dealerStatus(status, at)).toBe(label)
  })
})
