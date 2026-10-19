import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Deal actions through the real guard and the real dealer libraries, Prisma
// stubbed: a document of another dealer (or not uploaded by a dealer) is 404
// and every read is filtered on the caller's dealer; an upload answering a
// request must match its type; a preview prices only the dealer's own asset;
// a consent needs the explicit attestation.
const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true }) },
    assetFinanceDeal: { findFirst: vi.fn() },
    entityDocument: { findFirst: vi.fn(), findMany: vi.fn() },
    dealerDocumentRequest: { findFirst: vi.fn() },
    financedAsset: { findFirst: vi.fn() },
  },
  store: vi.fn(),
  serve: vi.fn(),
  preview: vi.fn(),
  attest: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }))
vi.mock("@/lib/tenant", () => ({
  getTenantFromRequest: async () => ({ id: "tenant-1", slug: "lender", name: "Lender", domain: null, status: "ACTIVE" }),
  withTenantContext: async (_req: Request, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/asset-finance/entity-document-io", () => ({
  parseEntityDocumentForm: async () => ({ upload: { file: new File(["%PDF"], "statement.pdf", { type: "application/pdf" }), docType: "BANK_STATEMENT", dealId: null } }),
  storeDealEvidenceDocument: h.store,
  serveEntityDocument: h.serve,
}))
vi.mock("@/lib/asset-finance/deal-preview", () => ({ previewDealStructure: h.preview }))
vi.mock("@/lib/dealer/consent", () => ({ attestDealerConsent: h.attest }))

import { GET as GET_DOC } from "./documents/[docId]/route"
import { GET as LIST_DOCS, POST as UPLOAD } from "./documents/route"
import { POST as ATTEST } from "./consents/route"
import { POST as PREVIEW } from "../preview/route"

const DEALER = { id: "du-1", email: "sales@dealer.example", role: "DEALER", tenantId: "tenant-1", dealerId: "dealer-1", dealerRole: "DEALER_SALES" }
const req = (url: string, method = "GET", body?: unknown) => new NextRequest(`https://dealers.lender.example${url}`, {
  method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { host: "dealers.lender.example", "sec-fetch-site": "same-origin", "content-type": "application/json" },
})
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) })

beforeEach(() => {
  vi.clearAllMocks()
  h.session = { user: { ...DEALER } }
  h.prisma.assetFinanceDeal.findFirst.mockResolvedValue({ id: "deal-1", status: "DRAFT", entityId: "e-1", clientId: null })
  h.store.mockResolvedValue({ id: "doc-9", docType: "BANK_STATEMENT", fileName: "statement.pdf", createdAt: "2026-10-19T10:00:00.000Z", verifiedById: "staff-1", entityId: "e-1" })
})

describe("dealer documents", () => {
  it("serves a document only through the caller's dealer, dealer uploads only; anything else is 404", async () => {
    h.prisma.entityDocument.findFirst.mockResolvedValue(null)
    const res = await GET_DOC(req("/api/dealer/deals/deal-1/documents/doc-x"), ctx({ id: "deal-1", docId: "doc-x" }))
    expect(res.status).toBe(404)
    expect(h.prisma.entityDocument.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "doc-x", tenantId: "tenant-1", dealId: "deal-1", uploadedByType: "dealer", deletedAt: null, deal: { dealerId: "dealer-1" } }),
    }))
    expect(h.serve).not.toHaveBeenCalled()
  })

  it("logs the access as the dealer user when serving its own document", async () => {
    h.prisma.entityDocument.findFirst.mockResolvedValue({ id: "doc-1", fileName: "c.pdf", mimeType: "application/pdf", storagePath: "p", contentSha256: "h" })
    h.serve.mockResolvedValue(new Response("bytes"))
    expect((await GET_DOC(req("/api/dealer/deals/deal-1/documents/doc-1"), ctx({ id: "deal-1", docId: "doc-1" }))).status).toBe(200)
    expect(h.serve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "doc-1" }), { type: "dealer", id: "du-1" })
  })

  it("lists nothing for another dealer's deal (404)", async () => {
    h.prisma.assetFinanceDeal.findFirst.mockResolvedValue(null)
    expect((await LIST_DOCS(req("/api/dealer/deals/deal-2/documents"), ctx({ id: "deal-2" }))).status).toBe(404)
    expect(h.prisma.assetFinanceDeal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "deal-2", tenantId: "tenant-1", dealerId: "dealer-1" } }))
  })

  it("stores an upload as the dealer user and answers with the dealer's view of it only", async () => {
    const res = await UPLOAD(req("/api/dealer/deals/deal-1/documents", "POST"), ctx({ id: "deal-1" }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: "doc-9", docType: "BANK_STATEMENT", fileName: "statement.pdf", uploadedAt: "2026-10-19T10:00:00.000Z" })
    expect(h.store).toHaveBeenCalledWith(expect.objectContaining({ uploader: { type: "dealer", id: "du-1", email: "sales@dealer.example", dealerId: "dealer-1" } }))
  })

  it("refuses an upload answering a request for another document type (422), storing nothing", async () => {
    h.prisma.dealerDocumentRequest.findFirst.mockResolvedValue({ docType: "AFS", fulfilledAt: null })
    const res = await UPLOAD(req("/api/dealer/deals/deal-1/documents?requestId=req-1", "POST"), ctx({ id: "deal-1" }))
    expect(res.status).toBe(422)
    expect(h.prisma.dealerDocumentRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "req-1", tenantId: "tenant-1", dealId: "deal-1" } }))
    expect(h.store).not.toHaveBeenCalled()
  })

  it("refuses an upload on another dealer's deal (404)", async () => {
    h.prisma.assetFinanceDeal.findFirst.mockResolvedValue(null)
    expect((await UPLOAD(req("/api/dealer/deals/deal-2/documents", "POST"), ctx({ id: "deal-2" }))).status).toBe(404)
    expect(h.store).not.toHaveBeenCalled()
  })
})

describe("dealer preview", () => {
  const structure = { assetId: "a-1", contractType: "INSTALMENT_SALE", firstDueDate: "2099-01-01", rateBasis: "FIXED", fixedRate: "0.15", preset: { kind: "MONTHLY", periods: 12 } }

  it("prices only an asset the dealer captured; any other is 404", async () => {
    h.prisma.financedAsset.findFirst.mockResolvedValue(null)
    expect((await PREVIEW(req("/api/dealer/deals/preview", "POST", structure))).status).toBe(404)
    expect(h.prisma.financedAsset.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a-1", tenantId: "tenant-1", createdByDealerId: "dealer-1" } }))
    expect(h.preview).not.toHaveBeenCalled()
  })

  it("runs the shared solver for the dealer's own asset", async () => {
    h.prisma.financedAsset.findFirst.mockResolvedValue({ cashPriceExclVatCents: 100_000_00, vatCents: 15_000_00 })
    h.preview.mockResolvedValue({ status: 200, body: { startDate: "2098-12-01" } })
    const res = await PREVIEW(req("/api/dealer/deals/preview", "POST", structure))
    expect(res.status).toBe(200)
    expect(h.preview).toHaveBeenCalledWith("tenant-1", expect.objectContaining({ assetId: "a-1" }), { cashPriceExclVatCents: 100_000_00, vatCents: 15_000_00 })
  })

  it("answers 400 with the field errors for a malformed structure", async () => {
    const res = await PREVIEW(req("/api/dealer/deals/preview", "POST", { assetId: "a-1" }))
    expect(res.status).toBe(400)
    expect(h.prisma.financedAsset.findFirst).not.toHaveBeenCalled()
  })
})

describe("dealer consent", () => {
  it("needs the explicit attestation", async () => {
    const res = await ATTEST(req("/api/dealer/deals/deal-1/consents", "POST", { documentId: "doc-1", clientIds: ["c-1"] }), ctx({ id: "deal-1" }))
    expect(res.status).toBe(400)
    expect(h.attest).not.toHaveBeenCalled()
  })

  it("attests as the dealer user", async () => {
    h.attest.mockResolvedValue({ kind: "attested", attestationIds: ["att-1"] })
    const res = await ATTEST(req("/api/dealer/deals/deal-1/consents", "POST", { attested: true, documentId: "doc-1", clientIds: ["c-1"] }), ctx({ id: "deal-1" }))
    expect(res.status).toBe(201)
    expect(h.attest).toHaveBeenCalledWith(expect.objectContaining({ dealerId: "dealer-1", dealerUserId: "du-1" }), "deal-1", { documentId: "doc-1", clientIds: ["c-1"] })
  })
})
