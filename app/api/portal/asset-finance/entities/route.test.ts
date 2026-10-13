import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createHash } from "node:crypto"

// Portal entity routes. The gate (lib/asset-finance/portal-route.ts), the
// authority rule and the access-log writer run for real; session, Prisma,
// storage and audit are stubbed. The real-database proof of the SURETY
// exclusion is lib/asset-finance/portal-access.integration.test.ts.
const m = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
  flag: { on: true },
  relFindFirst: vi.fn(),
  relFindMany: vi.fn(),
  entityFindMany: vi.fn(),
  docFindFirst: vi.fn(),
  accessLogCreate: vi.fn(),
  readFile: vi.fn(),
  saveFile: vi.fn(),
  logAudit: vi.fn(),
  tx: { entityDocument: { create: vi.fn() } },
}))

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => m.session.current) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    entityRelationship: { findFirst: m.relFindFirst, findMany: m.relFindMany },
    businessEntity: { findMany: m.entityFindMany },
    entityDocument: { findFirst: m.docFindFirst },
    documentAccessLog: { create: m.accessLogCreate },
    $transaction: (fn: (tx: unknown) => unknown) => fn(m.tx),
  },
}))
vi.mock("@/lib/storage", () => ({ saveFile: m.saveFile, readFile: m.readFile, deleteFile: vi.fn() }))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAudit: m.logAudit,
  logAuditStrict: vi.fn(),
}))

import { GET as list } from "./route"
import { POST as upload } from "./[id]/documents/route"
import { GET as download } from "./[id]/documents/[documentId]/route"

const PDF = Buffer.from("%PDF-1.4 synthetic portal document")
const BASE = "http://localhost/api/portal/asset-finance/entities"
const docParams = { params: Promise.resolve({ id: "ent-1", documentId: "doc-1" }) }
const signInClient = () => {
  m.session.current = { user: { id: "client-1", email: "director@client.test", role: "CLIENT", tenantId: "tenant-1" } }
}

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  signInClient()
  m.relFindFirst.mockResolvedValue({ id: "rel-1" })
  m.docFindFirst.mockResolvedValue({
    id: "doc-1", fileName: "loa.pdf", mimeType: "application/pdf", storagePath: "/uploads/y.pdf",
    contentSha256: createHash("sha256").update(PDF).digest("hex"),
  })
  m.readFile.mockResolvedValue(PDF)
})

describe("portal asset-finance routes", () => {
  it("answer 401 to staff and to no session", async () => {
    m.session.current = { user: { id: "user-1", email: "s@lender.test", role: "ADMIN", tenantId: "tenant-1" } }
    expect((await list(new NextRequest(BASE))).status).toBe(401)
    m.session.current = null
    expect((await download(new NextRequest(`${BASE}/ent-1/documents/doc-1`), docParams)).status).toBe(401)
    expect(m.accessLogCreate).not.toHaveBeenCalled()
  })

  it("answer 404 when the tenant has not enabled asset finance", async () => {
    m.flag.on = false
    expect((await list(new NextRequest(BASE))).status).toBe(404)
  })

  it("answer 404 to a client with no authorising role, log no access, and audit the refusal", async () => {
    m.relFindFirst.mockResolvedValue(null)
    const res = await download(new NextRequest(`${BASE}/ent-1/documents/doc-1`), docParams)
    expect(res.status).toBe(404)
    expect(m.relFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ clientId: "client-1", entityId: "ent-1", active: true, role: { in: ["DIRECTOR", "TRUSTEE", "AUTHORISED_SIGNATORY"] } }),
    }))
    expect(m.docFindFirst).not.toHaveBeenCalled()
    expect(m.accessLogCreate).not.toHaveBeenCalled()
    expect(m.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "DOCUMENT_ACCESS_REFUSED", entity: "EntityDocument", entityId: "doc-1", tenantId: "tenant-1",
    }))
  })

  it("serve an authorised client the document and write the access-log row as the client", async () => {
    const res = await download(new NextRequest(`${BASE}/ent-1/documents/doc-1`), docParams)
    expect(res.status).toBe(200)
    expect(m.accessLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ documentId: "doc-1", accessorType: "client", accessorId: "client-1", action: "view" }),
    })
  })

  it("refuse a portal upload of a staff-only type 400", async () => {
    const f = new FormData()
    f.set("docType", "SUPPLIER_INVOICE")
    f.set("file", new File([new Uint8Array(PDF)], "inv.pdf", { type: "application/pdf" }))
    const res = await upload(new NextRequest(`${BASE}/ent-1/documents`, { method: "POST", body: f }), { params: Promise.resolve({ id: "ent-1" }) })
    expect(res.status).toBe(400)
    expect(m.saveFile).not.toHaveBeenCalled()
  })

  it("list only the entities the client may act for", async () => {
    m.relFindMany.mockResolvedValue([{ entityId: "ent-1" }])
    m.entityFindMany.mockResolvedValue([{ id: "ent-1", type: "COMPANY", legalName: "TEST Co", tradingName: null, registrationNumber: "2015/123456/07" }])
    const res = await list(new NextRequest(BASE))
    expect(res.status).toBe(200)
    expect(m.entityFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1", id: { in: ["ent-1"] } } }))
  })
})
