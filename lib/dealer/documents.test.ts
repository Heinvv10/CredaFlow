import { beforeEach, describe, expect, it, vi } from "vitest"

// Dealer uploads: free while the dealer still holds the draft; after the
// hand-over only an answer to an open document request; a request answered
// concurrently is a typed 409, not a thrown error.
const h = vi.hoisted(() => ({ deal: vi.fn(), request: vi.fn(), store: vi.fn(), fulfil: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { assetFinanceDeal: { findFirst: h.deal }, dealerDocumentRequest: { findFirst: h.request } } }))
vi.mock("@/lib/audit", () => ({ AuditAction: { DEALER_DOCUMENT_REQUEST_FULFILLED: "DEALER_DOCUMENT_REQUEST_FULFILLED" }, logAuditStrict: vi.fn() }))
vi.mock("@/lib/asset-finance/entity-document-io", () => ({ storeDealEvidenceDocument: h.store, serveEntityDocument: vi.fn() }))

import { uploadDealerDocument } from "./documents"

const actor = { tenantId: "tenant-1", dealerId: "dealer-1", dealerUserId: "du-1", email: "sales@dealer.invalid", dealerRole: "DEALER_SALES" as const }
const upload = { file: new File(["x"], "x.pdf"), docType: "OTHER", dealId: null } as unknown as Parameters<typeof uploadDealerDocument>[2]
const deal = (over: Record<string, unknown> = {}) => ({ id: "deal-1", status: "DRAFT", dealerSubmittedAt: null, entityId: null, clientId: "c-1", ...over })

beforeEach(() => {
  vi.clearAllMocks()
  h.request.mockResolvedValue({ docType: "OTHER", fulfilledAt: null })
  h.store.mockImplementation(async (params: { withinTransaction?: (tx: unknown, doc: { id: string; contentSha256: string }) => Promise<void> }) => {
    await params.withinTransaction?.({ dealerDocumentRequest: { updateMany: h.fulfil } }, { id: "doc-1", contentSha256: "a".repeat(64) })
    return { id: "doc-1" }
  })
  h.fulfil.mockResolvedValue({ count: 1 })
})

describe("uploadDealerDocument", () => {
  it("stores a free upload while the dealer holds the draft", async () => {
    h.deal.mockResolvedValue(deal())
    expect(await uploadDealerDocument(actor, "deal-1", upload)).toMatchObject({ kind: "stored" })
  })

  it.each([
    ["handed over", { dealerSubmittedAt: new Date("2026-10-19T10:00:00Z") }],
    ["approved", { status: "APPROVED", dealerSubmittedAt: new Date("2026-10-19T10:00:00Z") }],
    ["booked", { status: "BOOKED", dealerSubmittedAt: new Date("2026-10-19T10:00:00Z") }],
  ])("refuses a free upload once the deal is %s (409), and takes an answer to an open request", async (_label, over) => {
    h.deal.mockResolvedValue(deal(over))
    expect(await uploadDealerDocument(actor, "deal-1", upload)).toMatchObject({ kind: "refused", status: 409 })
    expect(h.store).not.toHaveBeenCalled()
    expect(await uploadDealerDocument(actor, "deal-1", upload, "req-1")).toMatchObject({ kind: "stored" })
  })

  it("answers a request another upload fulfilled first with 409", async () => {
    h.deal.mockResolvedValue(deal({ dealerSubmittedAt: new Date("2026-10-19T10:00:00Z") }))
    h.fulfil.mockResolvedValue({ count: 0 })
    expect(await uploadDealerDocument(actor, "deal-1", upload, "req-1")).toEqual({
      kind: "refused", status: 409, error: "This request has already been answered",
    })
  })
})
