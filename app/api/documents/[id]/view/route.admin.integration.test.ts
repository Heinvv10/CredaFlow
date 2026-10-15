/**
 * Real-Postgres proof that an ADMIN reaches client documents like the other
 * staff roles: listed through GET /api/clients/[id]/documents and served
 * through GET /api/documents/[id]/view with a DocumentAccessLog row, while an
 * ADMIN of another tenant is still refused and the refusal is audited.
 *
 * Only the session is mocked: getDocumentCaller, withTenantContext, the
 * access log and the refusal audit are the real ones.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run "app/api/documents/[id]/view/route.admin.integration.test.ts"
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { syntheticSaId } from "@/lib/bureau-submission/bureau.integration-fixture"
import { deleteFile, saveFile } from "@/lib/storage"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> } }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))

import { GET as view } from "./route"
import { GET as list } from "@/app/api/clients/[id]/documents/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantA = `t_docadmin_a_${t}`
const tenantB = `t_docadmin_b_${t}`
const domainA = `docadmin-a-${t}.document-admin-it.test`
const adminA = `user_docadmin_a_${t}`
const adminB = `user_docadmin_b_${t}`
const PDF = Buffer.from("%PDF-1.4 synthetic admin document")
let clientId = ""
let documentId = ""
let storagePath = ""

const signIn = (id: string, tenantId: string) => {
  h.session = { user: { id, email: `${id}@test.invalid`, role: "ADMIN", tenantId, totpVerified: true, tokenVersion: 0 } }
}
const get = (path: string) => new NextRequest(`http://${domainA}${path}`, { headers: { host: domainA } })

suite("ADMIN document access (real database)", () => {
  beforeAll(async () => {
    await db.tenant.createMany({ data: [
      { id: tenantA, slug: `docadmin-a-${t}`, name: "Document admin IT A", domain: domainA },
      { id: tenantB, slug: `docadmin-b-${t}`, name: "Document admin IT B" },
    ] })
    const staff = (id: string, tenantId: string) =>
      ({ id, tenantId, role: "ADMIN" as const, email: `${id}@test.invalid`, name: "Synthetic Admin", password: "not-a-login-credential" })
    await db.user.createMany({ data: [staff(adminA, tenantA), staff(adminB, tenantB)] })
    const client = await db.client.create({
      data: { tenantId: tenantA, idNumber: syntheticSaId(), firstName: "Doc", lastName: "Fixture", email: `doc-${t}@client.invalid`, phone: "0820000000" },
    })
    clientId = client.id
    const stored = await saveFile(PDF, "application/pdf")
    storagePath = stored.storagePath
    documentId = (await db.clientDocument.create({ data: {
      tenantId: tenantA, clientId, docType: "OTHER", fileUrl: "/synthetic", fileName: "synthetic.pdf",
      mimeType: "application/pdf", fileSize: stored.fileSize, storagePath,
    } })).id
  })

  afterAll(async () => {
    if (storagePath) await deleteFile(storagePath)
    await db.$disconnect()
  })

  it("lists the client's documents for a same-tenant ADMIN", async () => {
    signIn(adminA, tenantA)
    const res = await list(get(`/api/clients/${clientId}/documents`), { params: Promise.resolve({ id: clientId }) })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { id: string }[]).map((d) => d.id)).toEqual([documentId])
  })

  it("serves the document to a same-tenant ADMIN and logs the view", async () => {
    signIn(adminA, tenantA)
    const res = await view(get(`/api/documents/${documentId}/view`), { params: Promise.resolve({ id: documentId }) })
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true)
    expect(await db.documentAccessLog.count({ where: { documentId, accessorType: "staff", accessorId: adminA, action: "view" } })).toBe(1)
  })

  it("refuses another tenant's ADMIN, audits the refusal and logs no access", async () => {
    signIn(adminB, tenantB)
    const res = await view(get(`/api/documents/${documentId}/view`), { params: Promise.resolve({ id: documentId }) })
    expect(res.status).toBe(403)
    expect(await db.auditLog.count({ where: { tenantId: tenantA, action: "DOCUMENT_ACCESS_REFUSED", entityId: documentId } })).toBe(1)
    expect(await db.auditLog.count({ where: { tenantId: tenantB, action: "DOCUMENT_ACCESS_REFUSED", entityId: adminB } })).toBe(1)
    expect(await db.documentAccessLog.count({ where: { documentId, accessorId: adminB } })).toBe(0)
  })
})
