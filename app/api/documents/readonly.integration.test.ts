/**
 * Real-Postgres proof that READONLY views and lists client documents but
 * changes none (Hein, 2026-10-16): the list and the view still work and log
 * the view, while every document write route answers 403, files an audited
 * refusal and leaves the document, its extraction and the access register as
 * they were. A COLLECTIONS_OFFICER still uploads.
 *
 * Only the session is mocked: getDocumentCaller, requireApiRole,
 * withTenantContext, the access log and the refusal audit are the real ones.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/documents/readonly.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { PDFDocument } from "pdf-lib"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { syntheticSaId } from "@/lib/bureau-submission/bureau.integration-fixture"
import { deleteFile, saveFile } from "@/lib/storage"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> } }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))

import { POST as upload } from "./route"
import { POST as selfie } from "./selfie/route"
import { POST as sign } from "./[id]/sign/route"
import { POST as extract } from "./[id]/extract/route"
import { POST as requestSignature } from "./[id]/request-signature/route"
import { GET as view } from "./[id]/view/route"
import { GET as list } from "@/app/api/clients/[id]/documents/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `t_docro_${t}`
const domain = `docro-${t}.document-readonly-it.test`
const viewer = `user_docro_viewer_${t}`
const collector = `user_docro_collector_${t}`
let pdf: Buffer
let clientId = ""
let documentId = ""
const storagePaths: string[] = []

const signIn = (id: string, role: string) => {
  h.session = {
    user: { id, email: `${id}@test.invalid`, role, tenantId, totpVerified: true, totpEnrolmentRequired: false, tokenVersion: 0 },
  }
}
const url = (path: string) => `http://${domain}${path}`
const get = (path: string) => new NextRequest(url(path), { headers: { host: domain } })
const postJson = (path: string, body: unknown) =>
  new NextRequest(url(path), { method: "POST", headers: { host: domain, "content-type": "application/json" }, body: JSON.stringify(body) })
const postForm = (path: string, form: FormData) =>
  new NextRequest(url(path), { method: "POST", headers: { host: domain }, body: form })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

function uploadForm(docType: string): FormData {
  const form = new FormData()
  form.set("file", new File([new Uint8Array(pdf)], "synthetic.pdf", { type: "application/pdf" }))
  form.set("docType", docType)
  form.set("clientId", clientId)
  return form
}

async function documentState() {
  return db.clientDocument.findUniqueOrThrow({
    where: { id: documentId },
    select: {
      signatureState: true, signedAt: true, extractionStatus: true, extractionGeneration: true,
      extractionStartedAt: true, extractionResult: true, extractionError: true, verified: true,
    },
  })
}

async function refusals(entityId: string) {
  const rows = await db.auditLog.findMany({
    where: { tenantId, action: "DOCUMENT_ACCESS_REFUSED", entityId, userId: viewer },
    select: { newValue: true },
  })
  return rows.map((r) => r.newValue as Record<string, unknown>)
}

suite("READONLY document access (real database)", () => {
  beforeAll(async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    pdf = Buffer.from(await doc.save())

    await db.tenant.create({ data: { id: tenantId, slug: `docro-${t}`, name: "Document read-only IT", domain } })
    const staff = (id: string, role: "READONLY" | "COLLECTIONS_OFFICER") =>
      ({ id, tenantId, role, email: `${id}@test.invalid`, name: "Synthetic Staff", password: "not-a-login-credential" })
    await db.user.createMany({ data: [staff(viewer, "READONLY"), staff(collector, "COLLECTIONS_OFFICER")] })
    const client = await db.client.create({
      data: { tenantId, idNumber: syntheticSaId(), firstName: "Doc", lastName: "Fixture", email: `docro-${t}@client.invalid`, phone: "0820000000" },
    })
    clientId = client.id
    const stored = await saveFile(pdf, "application/pdf")
    storagePaths.push(stored.storagePath)
    documentId = (await db.clientDocument.create({ data: {
      tenantId, clientId, docType: "OTHER", fileUrl: "/synthetic", fileName: "synthetic.pdf",
      mimeType: "application/pdf", fileSize: stored.fileSize, storagePath: stored.storagePath,
      extractionStatus: "failed", signatureState: "pending",
    } })).id
  })

  afterAll(async () => {
    const created = await db.clientDocument.findMany({ where: { tenantId }, select: { storagePath: true } })
    for (const p of new Set([...storagePaths, ...created.map((d) => d.storagePath).filter((p): p is string => !!p)])) {
      await deleteFile(p)
    }
    await db.$disconnect()
  })

  it("lists the client's documents for READONLY", async () => {
    signIn(viewer, "READONLY")
    const res = await list(get(`/api/clients/${clientId}/documents`), params(clientId))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { id: string }[]).map((d) => d.id)).toEqual([documentId])
  })

  it("serves the document to READONLY and logs one staff view", async () => {
    signIn(viewer, "READONLY")
    const res = await view(get(`/api/documents/${documentId}/view`), params(documentId))
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(pdf)).toBe(true)
    expect(await db.documentAccessLog.count({ where: { documentId, accessorType: "staff", accessorId: viewer, action: "view" } })).toBe(1)
  })

  it("refuses every READONLY write with 403, an audited refusal and no state change", async () => {
    signIn(viewer, "READONLY")
    const before = await documentState()
    const documentsBefore = await db.clientDocument.count({ where: { tenantId } })
    const accessBefore = await db.documentAccessLog.count({ where: { documentId } })

    const attempts: [string, string, Response][] = [
      ["upload", "upload", await upload(postForm("/api/documents", uploadForm("PAYSLIP")))],
      ["selfie", "selfie", await selfie(postForm("/api/documents/selfie", (() => {
        const form = new FormData()
        form.set("image", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "selfie.jpg", { type: "image/jpeg" }))
        form.set("clientId", clientId)
        return form
      })()))],
      [documentId, "sign", await sign(postJson(`/api/documents/${documentId}/sign`, { method: "branch" }), params(documentId))],
      [documentId, "extract", await extract(postJson(`/api/documents/${documentId}/extract`, {}), params(documentId))],
      [documentId, "request_signature", await requestSignature(postJson(`/api/documents/${documentId}/request-signature`, {}), params(documentId))],
    ]

    for (const [, , res] of attempts) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "Your role can view documents but not change them." })
    }
    for (const action of ["upload", "selfie"]) {
      expect(await refusals(action)).toEqual([
        expect.objectContaining({ refused: true, reason: "document_write_read_only_role", httpStatus: 403, action, role: "READONLY" }),
      ])
    }
    const onDocument = await refusals(documentId)
    expect(onDocument.map((r) => r.action).sort()).toEqual(["extract", "request_signature", "sign"])
    for (const row of onDocument) expect(row).toEqual(expect.objectContaining({ reason: "document_write_read_only_role", httpStatus: 403 }))

    expect(await documentState()).toEqual(before)
    expect(await db.clientDocument.count({ where: { tenantId } })).toBe(documentsBefore)
    expect(await db.documentAccessLog.count({ where: { documentId } })).toBe(accessBefore)
  })

  it("still lets a COLLECTIONS_OFFICER upload", async () => {
    signIn(collector, "COLLECTIONS_OFFICER")
    const res = await upload(postForm("/api/documents", uploadForm("PAYSLIP")))
    expect(res.status).toBe(201)
    const created = (await res.json()) as { id: string }
    expect(await db.clientDocument.findFirst({ where: { id: created.id, tenantId, clientId, uploadedById: collector } })).not.toBeNull()
    expect(await db.auditLog.count({ where: { tenantId, action: "DOCUMENT_ACCESS_REFUSED", userId: collector } })).toBe(0)
  })
})
