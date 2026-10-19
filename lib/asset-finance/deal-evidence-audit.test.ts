import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ create: vi.fn(), logAuditStrict: vi.fn(), saveFile: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (fn: (tx: unknown) => unknown) => fn({ entityDocument: { create: m.create } }) },
}))
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/storage", () => ({ saveFile: m.saveFile, readFile: vi.fn(), deleteFile: vi.fn() }))
vi.mock("@/lib/audit", () => ({
  AuditAction: { ENTITY_DOCUMENT_UPLOADED: "ENTITY_DOCUMENT_UPLOADED" },
  logAuditStrict: m.logAuditStrict,
}))

import { storeDealEvidenceDocument } from "./entity-document-io"

const PDF = Buffer.from("%PDF-1.4 synthetic")
const upload = { file: new File([new Uint8Array(PDF)], "e.pdf", { type: "application/pdf" }), docType: "SUPPLIER_INVOICE" as const, dealId: "deal-1" }

beforeEach(() => {
  vi.clearAllMocks()
  m.saveFile.mockResolvedValue({ storagePath: "/uploads/x.pdf", fileSize: PDF.length })
  m.create.mockResolvedValue({
    id: "doc-1", entityId: "ent-1", clientId: null, dealId: "deal-1", docType: "SUPPLIER_INVOICE", fileName: "e.pdf",
    mimeType: "application/pdf", fileSize: PDF.length, uploadedByType: "staff", verifiedAt: null, verifiedById: null, createdAt: new Date(),
  })
})

describe("storeDealEvidenceDocument audit row", () => {
  it("keeps businessEntityId for an entity lessee, as the entity routes' audit rows do", async () => {
    await storeDealEvidenceDocument({
      tenantId: "tenant-1", dealId: "deal-1", entityId: "ent-1", clientId: null, upload,
      uploader: { type: "staff", id: "user-1", email: "o@lender.test" },
    })
    expect(m.logAuditStrict).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "AssetFinanceDeal", entityId: "deal-1", newValue: expect.objectContaining({ businessEntityId: "ent-1", docType: "SUPPLIER_INVOICE" }) }),
      expect.anything(),
    )
  })
})
