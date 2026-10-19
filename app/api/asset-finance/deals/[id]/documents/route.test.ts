import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { DEAL_EVIDENCE_DOC_TYPES } from "@/lib/asset-finance/payout-checklist"

// Deal-scoped evidence upload. The route, role guard, flag gate and form
// validation run for real; session, Prisma and the storage call are stubbed.
const m = vi.hoisted(() => ({
  dealFindFirst: vi.fn(),
  store: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }))
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "user-1", email: "officer@lender.test", role: "CREDIT_OFFICER", tenantId: "tenant-1" } })),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: true }) },
    assetFinanceDeal: { findFirst: m.dealFindFirst },
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/asset-finance/entity-document-io", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-finance/entity-document-io")>()),
  storeDealEvidenceDocument: m.store,
}))

import { POST } from "./route"

const PDF = Buffer.from("%PDF-1.4 synthetic test document")

function upload(docType: string) {
  const f = new FormData()
  f.set("docType", docType)
  f.set("file", new File([new Uint8Array(PDF)], "evidence.pdf", { type: "application/pdf" }))
  return POST(new NextRequest("http://localhost/api/asset-finance/deals/deal-1/documents", { method: "POST", body: f }), {
    params: Promise.resolve({ id: "deal-1" }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  m.dealFindFirst.mockResolvedValue({ id: "deal-1", entityId: null, clientId: "client-1" })
  m.store.mockResolvedValue({ id: "doc-1" })
})

describe("POST /deals/[id]/documents", () => {
  it.each([...DEAL_EVIDENCE_DOC_TYPES])("accepts %s, every type the evidence dropdown offers", async (docType) => {
    expect((await upload(docType)).status).toBe(201)
  })

  it("accepts LEGAL_DOCUMENT: a surety's consent letter is evidence only this upload can supply", async () => {
    expect(DEAL_EVIDENCE_DOC_TYPES).toContain("LEGAL_DOCUMENT")
    expect((await upload("LEGAL_DOCUMENT")).status).toBe(201)
  })

  it("accepts VALUATION: an individual lessee's valuation has no other upload path", async () => {
    expect(DEAL_EVIDENCE_DOC_TYPES).toContain("VALUATION")
    expect((await upload("VALUATION")).status).toBe(201)
  })

  it.each(["SIGNED_AGREEMENT", "PASSPORT", "CIPC_REGISTRATION"])("refuses %s with 400 and stores nothing", async (docType) => {
    expect((await upload(docType)).status).toBe(400)
    expect(m.store).not.toHaveBeenCalled()
  })

  it("files an entity lessee's document against the entity, not a client, and the deal", async () => {
    m.dealFindFirst.mockResolvedValue({ id: "deal-1", entityId: "ent-1", clientId: null })
    expect((await upload("SUPPLIER_INVOICE")).status).toBe(201)
    expect(m.store).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1", dealId: "deal-1", entityId: "ent-1", clientId: null,
      uploader: expect.objectContaining({ type: "staff", id: "user-1" }),
    }))
  })

  it("answers 404 for another tenant's deal, scoped by the caller's tenant, and stores nothing", async () => {
    m.dealFindFirst.mockResolvedValue(null)
    expect((await upload("SUPPLIER_INVOICE")).status).toBe(404)
    expect(m.dealFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "deal-1", tenantId: "tenant-1" } }))
    expect(m.store).not.toHaveBeenCalled()
  })
})
