import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createHash } from "node:crypto"

// Staff entity-document routes. Route, role guard, flag gate, upload checks
// and the access-log writer run for real; session, Prisma, storage and the
// audit writer are stubbed.
const m = vi.hoisted(() => ({
  session: { role: "CREDIT_OFFICER" as string },
  flag: { on: true },
  tx: {
    $queryRaw: vi.fn(),
    entityDocument: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), findFirstOrThrow: vi.fn() },
    businessEntity: { findFirst: vi.fn(), update: vi.fn() },
  },
  entityFindFirst: vi.fn(),
  dealFindFirst: vi.fn(),
  docFindFirst: vi.fn(),
  accessLogCreate: vi.fn(),
  saveFile: vi.fn(),
  readFile: vi.fn(),
  deleteFile: vi.fn(),
  logAuditStrict: vi.fn(),
  order: [] as string[],
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }))
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "user-1", email: "officer@lender.test", role: m.session.role, tenantId: "tenant-1" } })),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    businessEntity: { findFirst: m.entityFindFirst },
    assetFinanceDeal: { findFirst: m.dealFindFirst },
    entityDocument: { findFirst: m.docFindFirst },
    documentAccessLog: { create: m.accessLogCreate },
    $transaction: (fn: (tx: unknown) => unknown) => fn(m.tx),
  },
}))
vi.mock("@/lib/storage", () => ({ saveFile: m.saveFile, readFile: m.readFile, deleteFile: m.deleteFile }))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))

import { POST as upload } from "./route"
import { DELETE as remove, GET as download } from "./[documentId]/route"
import { POST as verify } from "./[documentId]/verify/route"

const PDF = Buffer.from("%PDF-1.4 synthetic test document")
const SHA = createHash("sha256").update(PDF).digest("hex")
const BASE = "http://localhost/api/asset-finance/entities/ent-1/documents"
const params = { params: Promise.resolve({ id: "ent-1" }) }
const docParams = { params: Promise.resolve({ id: "ent-1", documentId: "doc-1" }) }

function form(fields: { docType?: string; dealId?: string; bytes?: Buffer; type?: string; name?: string }) {
  const f = new FormData()
  if (fields.docType) f.set("docType", fields.docType)
  if (fields.dealId) f.set("dealId", fields.dealId)
  f.set("file", new File([new Uint8Array(fields.bytes ?? PDF)], fields.name ?? "afs.pdf", { type: fields.type ?? "application/pdf" }))
  return upload(new NextRequest(BASE, { method: "POST", body: f }), params)
}

const view = { id: "doc-1", entityId: "ent-1", dealId: null, docType: "AFS", fileName: "afs.pdf", mimeType: "application/pdf",
  fileSize: PDF.length, uploadedByType: "staff", verifiedAt: null, verifiedById: null, createdAt: new Date("2026-10-13T08:00:00Z") }

beforeEach(() => {
  vi.clearAllMocks()
  m.order = []
  m.session.role = "CREDIT_OFFICER"
  m.flag.on = true
  m.entityFindFirst.mockResolvedValue({ id: "ent-1" })
  m.dealFindFirst.mockResolvedValue(null)
  m.saveFile.mockResolvedValue({ storagePath: "/uploads/x.pdf", fileSize: PDF.length })
  m.tx.entityDocument.create.mockResolvedValue(view)
  m.tx.$queryRaw.mockResolvedValue([{ id: "ent-1" }])
  m.docFindFirst.mockResolvedValue({ id: "doc-1", fileName: "afs.pdf", mimeType: "application/pdf", storagePath: "/uploads/x.pdf", contentSha256: SHA })
  m.accessLogCreate.mockImplementation(async () => { m.order.push("log") })
  m.readFile.mockImplementation(async () => { m.order.push("read"); return PDF })
})

describe("POST …/documents (upload)", () => {
  it("answers 404 when the flag is off", async () => {
    m.flag.on = false
    expect((await form({ docType: "AFS" })).status).toBe(404)
    expect(m.saveFile).not.toHaveBeenCalled()
  })

  it("refuses READONLY 403", async () => {
    m.session.role = "READONLY"
    expect((await form({ docType: "AFS" })).status).toBe(403)
    expect(m.saveFile).not.toHaveBeenCalled()
  })

  it.each([
    [{ docType: "SIGNED_AGREEMENT" }],
    [{ docType: "PASSPORT" }],
    [{ docType: "AFS", type: "text/plain" }],
    [{ docType: "AFS", bytes: Buffer.from("not a pdf at all") }],
    [{ docType: "AFS", dealId: "deal-of-another-entity" }],
  ])("answers 400 for %j and stores nothing", async (fields) => {
    expect((await form(fields)).status).toBe(400)
    expect(m.saveFile).not.toHaveBeenCalled()
  })

  it("stores the bytes, the row (with its digest) and the audit entry", async () => {
    const res = await form({ docType: "AFS" })
    expect(res.status).toBe(201)
    expect(await res.json()).not.toHaveProperty("storagePath")
    expect(m.tx.entityDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: "tenant-1", entityId: "ent-1", docType: "AFS", contentSha256: SHA, uploadedByType: "staff", uploadedById: "user-1",
      }),
    }))
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "ENTITY_DOCUMENT_UPLOADED", entityId: "doc-1" }), m.tx)
  })

  it("removes the stored bytes when the row cannot be written", async () => {
    m.tx.entityDocument.create.mockRejectedValue(new Error("db down"))
    await expect(form({ docType: "AFS" })).rejects.toThrow("db down")
    expect(m.deleteFile).toHaveBeenCalledWith("/uploads/x.pdf")
  })
})

describe("GET …/documents/[documentId] (download)", () => {
  it("writes the DocumentAccessLog row before reading the bytes", async () => {
    const res = await download(new NextRequest(`${BASE}/doc-1?download=1`, { headers: { "user-agent": "vitest" } }), docParams)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="afs.pdf"')
    expect(m.accessLogCreate).toHaveBeenCalledWith({
      data: { documentId: "doc-1", accessorType: "staff", accessorId: "user-1", action: "download", ipAddress: null, userAgent: "vitest" },
    })
    expect(m.order).toEqual(["log", "read"])
  })

  it("answers 404 for a deleted document or one of another entity, and logs nothing", async () => {
    m.docFindFirst.mockResolvedValue(null)
    expect((await download(new NextRequest(`${BASE}/doc-1`), docParams)).status).toBe(404)
    expect(m.docFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "doc-1", entityId: "ent-1", tenantId: "tenant-1", deletedAt: null },
    }))
    expect(m.accessLogCreate).not.toHaveBeenCalled()
  })

  it("refuses bytes that no longer match their digest", async () => {
    m.readFile.mockResolvedValue(Buffer.from("%PDF-tampered"))
    expect((await download(new NextRequest(`${BASE}/doc-1`), docParams)).status).toBe(422)
  })
})

describe("POST …/verify and DELETE", () => {
  it("verifies once, audited; a second verify is 409", async () => {
    m.tx.entityDocument.findFirst.mockResolvedValue({ id: "doc-1", docType: "AFS", verifiedAt: null })
    m.tx.entityDocument.updateMany.mockResolvedValue({ count: 1 })
    m.tx.entityDocument.findFirstOrThrow.mockResolvedValue({ ...view, verifiedAt: new Date(), verifiedById: "user-1" })
    expect((await verify(new NextRequest(`${BASE}/doc-1/verify`, { method: "POST" }), docParams)).status).toBe(200)
    expect(m.tx.entityDocument.updateMany).toHaveBeenCalledWith({
      where: { id: "doc-1", tenantId: "tenant-1", verifiedAt: null, deletedAt: null },
      data: { verifiedAt: expect.any(Date), verifiedById: "user-1" },
    })
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "ENTITY_DOCUMENT_VERIFIED" }), m.tx)

    m.tx.entityDocument.findFirst.mockResolvedValue({ id: "doc-1", docType: "AFS", verifiedAt: new Date() })
    expect((await verify(new NextRequest(`${BASE}/doc-1/verify`, { method: "POST" }), docParams)).status).toBe(409)
  })

  it("refuses READONLY 403 on verify and delete", async () => {
    m.session.role = "READONLY"
    expect((await verify(new NextRequest(`${BASE}/doc-1/verify`, { method: "POST" }), docParams)).status).toBe(403)
    expect((await remove(new NextRequest(`${BASE}/doc-1`, { method: "DELETE" }), docParams)).status).toBe(403)
    expect(m.tx.entityDocument.updateMany).not.toHaveBeenCalled()
  })

  it("soft-deletes and drops the document from the financials evidence in the same transaction", async () => {
    m.tx.entityDocument.updateMany.mockResolvedValue({ count: 1 })
    m.tx.businessEntity.findFirst.mockResolvedValue({ financialsEvidenceIds: ["doc-1", "doc-2"] })
    expect((await remove(new NextRequest(`${BASE}/doc-1`, { method: "DELETE" }), docParams)).status).toBe(200)
    expect(m.tx.entityDocument.updateMany).toHaveBeenCalledWith({
      where: { id: "doc-1", entityId: "ent-1", tenantId: "tenant-1", deletedAt: null },
      data: { deletedAt: expect.any(Date), deletedById: "user-1" },
    })
    expect(m.tx.businessEntity.update).toHaveBeenCalledWith({
      where: { id: "ent-1", tenantId: "tenant-1" },
      data: { financialsEvidenceIds: ["doc-2"] },
    })
  })
})
