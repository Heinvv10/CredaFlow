import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// GET /api/dealer/deals and /api/dealer/deals/[id] through the real guard and
// the real projection (lib/dealer/deal-view.ts). Prisma hands back a deal row
// with a sentinel in every column a careless select could reach: the JSON the
// dealer receives must carry none of them, and every query must filter on the
// caller's lender and dealer (another dealer's deal is a miss, 404).
const S = "SENTINEL-LEAK"
const h = vi.hoisted(() => ({ findFirst: vi.fn(), findMany: vi.fn(), session: null as null | { user: Record<string, unknown> } }))

vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true }) },
    assetFinanceDeal: { findFirst: h.findFirst, findMany: h.findMany },
  },
}))
vi.mock("@/lib/tenant", () => ({
  getTenantFromRequest: async () => ({ id: "tenant-1", slug: "lender", name: "Lender", domain: null, status: "ACTIVE" }),
  withTenantContext: async (_req: Request, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "tenant-1" }),
}))

import { GET } from "./route"
import { GET as LIST } from "../route"

const person = (id: string, by: string | null) => ({ id, firstName: `First-${id}`, lastName: `Last-${id}`, createdByDealerId: by, idNumber: S, email: S })
const row = (over: Record<string, unknown> = {}) => ({
  id: "deal-1", createdAt: new Date("2026-10-01T08:00:00Z"), status: "DECLINED", dealerSubmittedAt: new Date("2026-10-02T08:00:00Z"),
  contractType: "INSTALMENT_SALE", baseInstalmentCents: 1_000_000, clientId: null,
  decision: S, decisionReasons: [S], approvalExceptions: [{ reason: S }], dealerCommissionBps: S, dealerCommissionSource: S,
  application: { reference: "AF-0001", appliedAmount: 150_000_000, approvedAmount: S, ncaRegime: S, decisionReason: S, creditScore: S },
  entity: { legalName: "TEST Plant Hire (Pty) Ltd", annualTurnover: S, relationships: [{ client: person("p1", "dealer-1") }, { client: person("p2", null) }] },
  client: null,
  asset: { make: "TEST", model: "TLB-1", year: 2025, serialNumber: "TESTSER1", cashPriceExclVatCents: S },
  loan: null, signers: [], checklist: [],
  dealerConsentAttestations: [{ clientId: "p1", verifiedAt: null, statementText: S }],
  dealerDocumentRequests: [], documents: [{ id: "doc-1", docType: "POPIA_CONSENT", fileName: "c.pdf", createdAt: new Date(), storagePath: S }],
  dealerCommissionLines: [], payout: { amountCents: S }, financials: { s: S }, bureauChecks: [{ s: S }], screening: { s: S },
  ...over,
})

const DEALER = { id: "du-1", email: "sales@dealer.example", role: "DEALER", tenantId: "tenant-1", dealerId: "dealer-1", dealerRole: "DEALER_SALES" }
const req = () => new NextRequest("https://dealers.lender.example/api/dealer/deals/deal-1", { headers: { host: "dealers.lender.example" } })
const ctx = { params: Promise.resolve({ id: "deal-1" }) }

beforeEach(() => {
  h.findFirst.mockReset()
  h.findMany.mockReset()
  h.session = { user: { ...DEALER } }
})

describe("GET /api/dealer/deals/[id]", () => {
  it("returns the projection only: no decision, reasons, bureau, regime, payout or financials", async () => {
    h.findFirst.mockResolvedValue(row())
    const res = await GET(req(), ctx)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(S)
    expect(text).not.toContain("First-p2")
    const body = JSON.parse(text)
    expect(body).toMatchObject({ id: "deal-1", reference: "AF-0001", status: "Declined", financedAmountCents: 150_000_000 })
    for (const key of ["decision", "decisionReasons", "approvalExceptions", "payout", "financials", "bureauChecks", "screening", "dealerCommissionBps"]) {
      expect(body, key).not.toHaveProperty(key)
    }
    expect(body.people).toEqual([
      { clientId: "p1", name: "First-p1 Last-p1", consentAttested: true },
      { clientId: "p2", name: "A person added by the lender", consentAttested: false },
    ])
  })

  it("looks the deal up on the caller's lender and dealer; another dealer's deal is 404", async () => {
    h.findFirst.mockResolvedValue(null)
    const res = await GET(req(), ctx)
    expect(res.status).toBe(404)
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "deal-1", tenantId: "tenant-1", dealerId: "dealer-1" } }))
  })

  it("is 404 for another lender's dealer session, without a query", async () => {
    h.session = { user: { ...DEALER, tenantId: "tenant-2" } }
    expect((await GET(req(), ctx)).status).toBe(404)
    expect(h.findFirst).not.toHaveBeenCalled()
  })
})

describe("GET /api/dealer/deals", () => {
  it("lists only the caller's dealer's deals, as summaries", async () => {
    h.findMany.mockResolvedValue([row()])
    const res = await LIST(req())
    const text = await res.text()
    expect(text).not.toContain(S)
    expect(JSON.parse(text)).toEqual([expect.objectContaining({ id: "deal-1", status: "Declined", borrower: "TEST Plant Hire (Pty) Ltd" })])
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1", dealerId: "dealer-1" } }))
  })
})
