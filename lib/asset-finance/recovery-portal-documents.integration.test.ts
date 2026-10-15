/**
 * The portal never shows a lender's legal-matter evidence (LEGAL_DOCUMENT) or
 * the document that verifies a surplus refund's bank account, through the real
 * routes (the entity's document list and the download) against a migrated
 * Postgres. An ordinary document of the same entity is listed and served, so
 * the 404s are the exclusions and not a broken route.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-portal-documents.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { GET as portalDownload } from "@/app/api/portal/asset-finance/entities/[id]/documents/[documentId]/route"
import { GET as portalDocuments } from "@/app/api/portal/asset-finance/entities/[id]/documents/route"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { deleteFile, saveFile } from "@/lib/storage"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { recoveryRoutes } from "./recovery-routes.integration-fixture"
import { ladderRecovery } from "./recovery-path.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
let entityId = ""
let recoveryId = ""
const docs = { plain: "", legal: "", bank: "" }
const storedPaths: string[] = []
const PDF = Buffer.from("%PDF-1.4 synthetic portal document")
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}

async function document(docType: "OTHER" | "LEGAL_DOCUMENT"): Promise<string> {
  const stored = await saveFile(PDF, "application/pdf")
  storedPaths.push(stored.storagePath)
  return (await database().entityDocument.create({ data: {
    tenantId: fx.tenantId, entityId, docType, fileName: `${docType.toLowerCase()}.pdf`, mimeType: "application/pdf", fileSize: stored.fileSize,
    storagePath: stored.storagePath, contentSha256: sha256DocumentBytes(PDF), uploadedByType: "staff", uploadedById: fx.officer,
  } })).id
}
const get = (path: string) => new NextRequest(`http://${fx.host}${path}`, { headers: { host: fx.host } })
const ids = (id: string) => ({ params: Promise.resolve({ id }) })

suite.sequential("portal documents: legal evidence and refund bank verification are staff-only (real Postgres)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createRecoveryFixture(database(), t)
    const { id, loan } = await ladderRecovery(database(), fx, false, "SURPLUS_HELD", { settlementCents: 50_000_000 })
    entityId = loan.entityId ?? ""
    recoveryId = id
    docs.plain = await document("OTHER")
    docs.legal = await document("LEGAL_DOCUMENT")
    docs.bank = await document("OTHER")
    const recovery = await database().recovery.findUniqueOrThrow({ where: { id } })
    await database().recoveryRefund.create({ data: {
      tenantId: fx.tenantId, recoveryId: id, amountCents: recovery.surplusCents ?? 0, accountHolder: "TEST Debtor", bankName: "TEST Bank", branchCode: "000001",
      accountNumber: "0000000001", bankVerifiedById: fx.adminA, bankVerificationDocumentId: docs.bank, createdById: fx.officer,
    } })
    session.current = { user: { id: fx.director, email: `${fx.director}@portal-it.test`, role: "CLIENT", tenantId: fx.tenantId } }
  }, 180_000)
  afterAll(async () => {
    if (!db) return
    for (const path of storedPaths) await deleteFile(path)
    await cleanupRecoveryFixture(db, recoveryFixtureTenantId(t))
    await db.$disconnect()
  }, 180_000)

  it("lists only the ordinary document", async () => {
    const response = await portalDocuments(get(`/api/portal/asset-finance/entities/${entityId}/documents`), ids(entityId))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { id: string }[]).map((d) => d.id)).toEqual([docs.plain])
  })

  it("serves the ordinary document and 404s the legal evidence and the bank-verification document", async () => {
    const download = (documentId: string) => portalDownload(get(`/api/portal/asset-finance/entities/${entityId}/documents/${documentId}`), { params: Promise.resolve({ id: entityId, documentId }) })
    const plain = await download(docs.plain)
    expect(plain.status).toBe(200)
    expect(Buffer.from(await plain.arrayBuffer()).equals(PDF)).toBe(true)
    expect((await download(docs.legal)).status).toBe(404)
    expect((await download(docs.bank)).status).toBe(404)
  })

  it("gives the refund's managers the bank details (last 4 digits only) and a staff-served, access-logged link to the verification document", async () => {
    const r = recoveryRoutes(fx.host)
    const staff = (id: string, role: string) => { session.current = { user: { id, email: `${id}@recovery-it.test`, role, tenantId: fx.tenantId } } }
    staff(fx.officer, "CREDIT_OFFICER")
    const view = await r.view(recoveryId)
    expect(view.body.refund).toMatchObject({
      status: "PENDING_APPROVAL",
      bank: { accountHolder: "TEST Debtor", bankName: "TEST Bank", branchCode: "000001", accountNumberLast4: "0001", verificationDocumentUrl: `/api/asset-finance/recoveries/${recoveryId}/refund/document` },
    })
    expect(JSON.stringify(view.body)).not.toContain("0000000001")
    const served = await r.refundDocument(recoveryId)
    expect(served.status).toBe(200)
    expect(Buffer.from(await served.arrayBuffer()).equals(PDF)).toBe(true)
    expect(await database().documentAccessLog.count({ where: { documentId: docs.bank, accessorType: "staff", accessorId: fx.officer } })).toBe(1)

    // A reader sees the refund without the account; the document needs the manage permission; another tenant gets 404.
    staff(fx.officer, "READONLY")
    expect((await r.view(recoveryId)).body.refund).toMatchObject({ bank: null })
    expect((await r.refundDocument(recoveryId)).status).toBe(403)
    const other = await createRecoveryFixture(database(), `${t}x`)
    try {
      session.current = { user: { id: other.adminA, email: "a@recovery-it.test", role: "LOAN_ADMIN", tenantId: other.tenantId } }
      expect((await recoveryRoutes(other.host).refundDocument(recoveryId)).status).toBe(404)
    } finally {
      await cleanupRecoveryFixture(database(), other.tenantId)
    }
    expect(await database().documentAccessLog.count({ where: { documentId: docs.bank } })).toBe(1)
  })
})
