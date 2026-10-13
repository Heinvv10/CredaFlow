/**
 * Real-Postgres proof of portal authority over a BusinessEntity (goal §4.5,
 * decision 2a.2) and of the entity-document rules:
 *   - an ACTIVE director sees the entity, uploads and downloads its documents,
 *     and every download writes a DocumentAccessLog row;
 *   - a SURETY-only client, a surety + beneficial owner, an unrelated client
 *     and a deactivated director all get 404 — on the entity, its documents
 *     and the download — and leave no access-log row;
 *   - financialsEvidenceIds refuses another entity's document and an
 *     unverified one, and accepts this entity's verified AFS;
 *   - the classifier's trustee evidence is the verified Letters of Authority.
 *
 * Only the session is stubbed. Routes, role guard, tenant resolution (by
 * host), feature flag, storage, audit and access-log writers are real.
 *
 *   RUN_ASSET_FINANCE_PORTAL_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/portal-access.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { unlink } from "node:fs/promises"
import { PrismaClient, type EntityRole } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

import { GET as portalEntity } from "@/app/api/portal/asset-finance/entities/[id]/route"
import { GET as portalDocuments, POST as portalUpload } from "@/app/api/portal/asset-finance/entities/[id]/documents/route"
import { GET as portalDownload } from "@/app/api/portal/asset-finance/entities/[id]/documents/[documentId]/route"
import { POST as staffUpload } from "@/app/api/asset-finance/entities/[id]/documents/route"
import { POST as staffVerify } from "@/app/api/asset-finance/entities/[id]/documents/[documentId]/verify/route"
import { PUT as setEvidence } from "@/app/api/asset-finance/entities/[id]/financials-evidence/route"
import { prisma as appPrisma } from "@/lib/prisma"
import { requirePortalEntityAccess } from "./portal-access"
import { verifiedTrusteeEvidenceIds } from "./entity-documents"

const RUN = process.env.RUN_ASSET_FINANCE_PORTAL_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null

const t = randomUUID().replaceAll("-", "").slice(0, 12)
const tenantId = `t_af_portal_${t}`
const host = `af-portal-${t}.portal-it.test`
const ids = { staff: "", entityA: "", entityB: "", director: "", surety: "", suretyOwner: "", unrelated: "", formerDirector: "" }
const docs = { portalAfs: "", staffAfsA: "", staffAfsB: "", unverifiedAfsA: "", loaA: "" }
const PDF = Buffer.from("%PDF-1.4 synthetic integration-test document")

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_PORTAL_IT=1 is required")
  return db
}
const asClient = (clientId: string) => {
  session.current = { user: { id: clientId, email: `${clientId}@portal-it.test`, role: "CLIENT", tenantId } }
}
const asStaff = () => {
  session.current = { user: { id: ids.staff, email: `staff-${t}@portal-it.test`, role: "CREDIT_OFFICER", tenantId } }
}
const url = (path: string) => `http://${host}${path}`
const req = (path: string, init?: { method?: string; body?: BodyInit; json?: unknown }) =>
  new NextRequest(url(path), {
    method: init?.method ?? "GET",
    headers: { host, ...(init?.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  })
const pdfForm = (docType: string, name: string) => {
  const form = new FormData()
  form.set("docType", docType)
  form.set("file", new File([new Uint8Array(PDF)], name, { type: "application/pdf" }))
  return form
}
const p1 = (id: string) => ({ params: Promise.resolve({ id }) })
const p2 = (id: string, documentId: string) => ({ params: Promise.resolve({ id, documentId }) })

async function staffUploadVerified(entityId: string, docType: string, verify: boolean): Promise<string> {
  asStaff()
  const res = await staffUpload(req(`/api/asset-finance/entities/${entityId}/documents`, { method: "POST", body: pdfForm(docType, `${docType}.pdf`) }), p1(entityId))
  expect(res.status).toBe(201)
  const { id } = (await res.json()) as { id: string }
  if (verify) {
    const v = await staffVerify(req(`/api/asset-finance/entities/${entityId}/documents/${id}/verify`, { method: "POST" }), p2(entityId, id))
    expect(v.status).toBe(200)
  }
  return id
}

suite.sequential("portal entity access and entity documents (real Postgres, real routes)", () => {
  beforeAll(async () => {
    const prisma = database()
    await prisma.tenant.create({ data: { id: tenantId, slug: `af-portal-${t}`, name: "Portal IT", domain: host } })
    await prisma.tenantConfig.create({ data: { tenantId, featureAssetFinance: true } })
    ids.staff = (await prisma.user.create({ data: { tenantId, email: `staff-${t}@staff.invalid`, password: "x", role: "CREDIT_OFFICER" } })).id
    const entity = (n: string) =>
      prisma.businessEntity.create({
        data: { tenantId, type: "COMPANY", legalName: `TEST Portal Co ${n} (Pty) Ltd`, registrationNumber: `2099/${t.slice(0, 5)}${n}/07`, annualTurnover: 200_000_000, financialYearEnd: new Date("2026-02-28") },
      })
    ids.entityA = (await entity("1")).id
    ids.entityB = (await entity("2")).id
    let seq = 0
    const client = async (label: string) =>
      (await prisma.client.create({
        data: {
          tenantId, firstName: "TEST", lastName: label, email: `${label}-${t}@client.invalid`, phone: `0000${t.slice(0, 4)}${seq}`,
          idNumber: `99${t.replace(/\D/g, "0").slice(0, 9)}${String(++seq).padStart(2, "0")}`,
        },
      })).id
    const relate = (clientId: string, role: EntityRole, active = true) =>
      prisma.entityRelationship.create({ data: { tenantId, entityId: ids.entityA, clientId, role, active } })
    ids.director = await client("director")
    ids.surety = await client("surety")
    ids.suretyOwner = await client("suretyowner")
    ids.unrelated = await client("unrelated")
    ids.formerDirector = await client("formerdirector")
    await relate(ids.director, "DIRECTOR")
    await relate(ids.surety, "SURETY")
    await relate(ids.suretyOwner, "SURETY")
    await relate(ids.suretyOwner, "BENEFICIAL_OWNER")
    await relate(ids.formerDirector, "DIRECTOR", false)
  })

  afterAll(async () => {
    if (!db) return
    const rows = await db.entityDocument.findMany({ where: { tenantId }, select: { id: true, storagePath: true } })
    await Promise.all(rows.map((r) => unlink(r.storagePath).catch(() => undefined)))
    await db.documentAccessLog.deleteMany({ where: { documentId: { in: rows.map((r) => r.id) } } })
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.entityDocument.deleteMany({ where: { tenantId } })
    await db.entityRelationship.deleteMany({ where: { tenantId } })
    await db.businessEntity.deleteMany({ where: { tenantId } })
    await db.client.deleteMany({ where: { tenantId } })
    await db.tenantConfig.deleteMany({ where: { tenantId } })
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("an active director sees the entity and uploads a document to it", async () => {
    asClient(ids.director)
    expect(await requirePortalEntityAccess(tenantId, ids.director, ids.entityA)).toBeNull()
    const view = await portalEntity(req(`/api/portal/asset-finance/entities/${ids.entityA}`), p1(ids.entityA))
    expect(view.status).toBe(200)
    expect((await view.json()).entity).toMatchObject({ id: ids.entityA })
    const up = await portalUpload(req(`/api/portal/asset-finance/entities/${ids.entityA}/documents`, { method: "POST", body: pdfForm("AFS", "afs.pdf") }), p1(ids.entityA))
    expect(up.status).toBe(201)
    docs.portalAfs = ((await up.json()) as { id: string }).id
    expect(await database().entityDocument.findUniqueOrThrow({ where: { id: docs.portalAfs } })).toMatchObject({
      tenantId, entityId: ids.entityA, uploadedByType: "client", uploadedById: ids.director, verifiedAt: null,
    })
  })

  it("the director's download writes a DocumentAccessLog row", async () => {
    asClient(ids.director)
    const res = await portalDownload(req(`/api/portal/asset-finance/entities/${ids.entityA}/documents/${docs.portalAfs}?download=1`), p2(ids.entityA, docs.portalAfs))
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true)
    const rows = await database().documentAccessLog.findMany({ where: { documentId: docs.portalAfs } })
    expect(rows).toEqual([expect.objectContaining({ accessorType: "client", accessorId: ids.director, action: "download" })])
  })

  it.each([
    ["a SURETY-only client", () => ids.surety],
    ["a surety who is also a beneficial owner", () => ids.suretyOwner],
    ["an unrelated client", () => ids.unrelated],
    ["a deactivated director", () => ids.formerDirector],
  ])("%s gets 404 on the entity, its documents and the download, and leaves no access row", async (_label, who) => {
    const clientId = who()
    asClient(clientId)
    expect((await requirePortalEntityAccess(tenantId, clientId, ids.entityA))?.status).toBe(404)
    expect((await portalEntity(req(`/api/portal/asset-finance/entities/${ids.entityA}`), p1(ids.entityA))).status).toBe(404)
    expect((await portalDocuments(req(`/api/portal/asset-finance/entities/${ids.entityA}/documents`), p1(ids.entityA))).status).toBe(404)
    const upload = await portalUpload(req(`/api/portal/asset-finance/entities/${ids.entityA}/documents`, { method: "POST", body: pdfForm("AFS", "x.pdf") }), p1(ids.entityA))
    expect(upload.status).toBe(404)
    const dl = await portalDownload(req(`/api/portal/asset-finance/entities/${ids.entityA}/documents/${docs.portalAfs}`), p2(ids.entityA, docs.portalAfs))
    expect(dl.status).toBe(404)
    expect(await database().documentAccessLog.count({ where: { documentId: docs.portalAfs, accessorId: clientId } })).toBe(0)
    expect(await database().auditLog.count({
      where: { tenantId, action: "DOCUMENT_ACCESS_REFUSED", entity: "EntityDocument", entityId: docs.portalAfs, userEmail: `${clientId}@portal-it.test` },
    })).toBe(1)
  })

  it("financialsEvidenceIds refuses another entity's and an unverified document, and accepts this entity's verified AFS", async () => {
    docs.staffAfsA = await staffUploadVerified(ids.entityA, "AFS", true)
    docs.staffAfsB = await staffUploadVerified(ids.entityB, "AFS", true)
    docs.unverifiedAfsA = await staffUploadVerified(ids.entityA, "AFS", false)
    asStaff()
    const put = (documentIds: string[]) =>
      setEvidence(req(`/api/asset-finance/entities/${ids.entityA}/financials-evidence`, { method: "PUT", json: { documentIds } }), p1(ids.entityA))

    const foreign = await put([docs.staffAfsB])
    expect(foreign.status).toBe(400)
    expect((await foreign.json()).invalidDocumentIds).toEqual([docs.staffAfsB])
    const unverified = await put([docs.staffAfsA, docs.unverifiedAfsA])
    expect(unverified.status).toBe(400)
    expect((await unverified.json()).invalidDocumentIds).toEqual([docs.unverifiedAfsA])
    expect((await database().businessEntity.findUniqueOrThrow({ where: { id: ids.entityA } })).financialsEvidenceIds).toEqual([])

    expect((await put([docs.staffAfsA])).status).toBe(200)
    expect((await database().businessEntity.findUniqueOrThrow({ where: { id: ids.entityA } })).financialsEvidenceIds).toEqual([docs.staffAfsA])
  })

  it("the classifier's trustee evidence is only the verified, live Letters of Authority", async () => {
    docs.loaA = await staffUploadVerified(ids.entityA, "LETTERS_OF_AUTHORITY", true)
    await staffUploadVerified(ids.entityA, "LETTERS_OF_AUTHORITY", false)
    expect(await verifiedTrusteeEvidenceIds(appPrisma, tenantId, ids.entityA)).toEqual([docs.loaA])
    expect(await verifiedTrusteeEvidenceIds(appPrisma, tenantId, ids.entityB)).toEqual([])
  })
})
