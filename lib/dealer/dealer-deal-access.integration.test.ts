/**
 * Real-Postgres proof that a dealer reaches only its own deals, through the
 * lib functions the portal routes call: another dealer of the same lender, or
 * any dealer of another lender, gets "not found" for every read and write; a
 * dealer reads only its own users' uploads (each read in DocumentAccessLog as
 * accessorType 'dealer'); staff document requests are answered once, by an
 * upload of the requested type.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-deal-access.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"
import { cleanupDealerFixtureIfCreated, createDealerFixture, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { captureForDealer, dealerDeal } from "./dealer-booking.integration-fixture"
import { actorOf, dealerDraft, inTenant, pdfUpload, staffOf, type DealerDraft } from "./dealer-origination.integration-fixture"
import { listDealerDocuments, serveDealerDocument, uploadDealerDocument } from "./documents"
import { requestDealerDocument } from "./document-requests"
import { attestDealerConsent } from "./consent"
import { submitDealerDeal } from "./submit"
import { listDealerDeals, loadDealerDealView } from "./deal-view"
import type { DealerActor } from "./actor"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let mine: DealerActor
let theirs: DealerActor
let draft: DealerDraft
let docId: string

const req = (path: string) => new Request(`https://dealers.lender.example${path}`, { headers: { "user-agent": "vitest" } })

suite.sequential("dealer deal access (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
    mine = actorOf(fx, fx.salesUserA, fx.dealerA)
    theirs = actorOf(fx, fx.userB, fx.dealerB, "DEALER_ADMIN")
    draft = await dealerDraft(fx, mine)
    const stored = await inTenant(fx, () => uploadDealerDocument(mine, draft.dealId, pdfUpload("POPIA_CONSENT")))
    if (stored.kind !== "stored") throw new Error(stored.error)
    docId = stored.document.id
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("shows the deal and its documents to its own dealer, and lists only its own deals", async () => {
    await inTenant(fx, async () => {
      expect(await loadDealerDealView(mine, draft.dealId)).toMatchObject({ id: draft.dealId, status: "Draft" })
      expect((await listDealerDocuments(mine, draft.dealId))?.map((d) => d.id)).toEqual([docId])
      expect((await listDealerDeals(mine)).map((d) => d.id)).toContain(draft.dealId)
      expect((await listDealerDeals(theirs)).map((d) => d.id)).not.toContain(draft.dealId)
    })
  })

  it("answers not found to another dealer of the lender, for every read and write", async () => {
    await inTenant(fx, async () => {
      expect(await loadDealerDealView(theirs, draft.dealId)).toBeNull()
      expect(await listDealerDocuments(theirs, draft.dealId)).toBeNull()
      expect((await serveDealerDocument(req("/x"), theirs, draft.dealId, docId)).status).toBe(404)
      expect(await uploadDealerDocument(theirs, draft.dealId, pdfUpload("OTHER"))).toMatchObject({ status: 404 })
      expect(await attestDealerConsent(theirs, draft.dealId, { documentId: docId, clientIds: [draft.directorId] , signingMethod: "IN_PERSON" })).toMatchObject({ status: 404 })
      expect(await submitDealerDeal(theirs, draft.dealId)).toMatchObject({ status: 404 })
    })
    expect(sql(`SELECT count(*) FROM "EntityDocument" WHERE "dealId" = ${lit(draft.dealId)}`)).toBe("1")
  })

  it("answers not found to the same dealer id under another lender", async () => {
    const elsewhere = { ...mine, tenantId: `t_other_${t}` }
    await runWithTenant(elsewhere.tenantId, async () => {
      expect(await loadDealerDealView(elsewhere, draft.dealId)).toBeNull()
      expect(await listDealerDocuments(elsewhere, draft.dealId)).toBeNull()
      expect(await submitDealerDeal(elsewhere, draft.dealId)).toMatchObject({ status: 404 })
      expect(await uploadDealerDocument(elsewhere, draft.dealId, pdfUpload("OTHER"))).toMatchObject({ status: 404 })
    })
  })

  it("serves the dealer its own upload, logged as a dealer access first", async () => {
    const res = await inTenant(fx, () => serveDealerDocument(req("/x?download=1"), mine, draft.dealId, docId))
    expect(res.status).toBe(200)
    expect(sql(`SELECT "accessorType", "accessorId", "action" FROM "DocumentAccessLog" WHERE "documentId" = ${lit(docId)}`))
      .toBe(`dealer|${fx.salesUserA}|download`)
  })

  it("never shows the dealer a staff upload on its own deal", async () => {
    const staffDoc = newId("doc")
    sql(`INSERT INTO "EntityDocument" ("id", "tenantId", "entityId", "dealId", "docType", "fileName", "mimeType", "fileSize", "storagePath",
        "contentSha256", "uploadedByType", "uploadedById")
      VALUES (${lit(staffDoc)}, ${lit(fx.tenantId)}, ${lit(draft.entityId)}, ${lit(draft.dealId)}, 'LEGAL_DOCUMENT', 'memo.pdf', 'application/pdf', 1,
        '/nonexistent/memo.pdf', repeat('0', 64), 'staff', ${lit(fx.officer)})`)
    await inTenant(fx, async () => {
      expect((await serveDealerDocument(req("/x"), mine, draft.dealId, staffDoc)).status).toBe(404)
      expect((await listDealerDocuments(mine, draft.dealId))?.map((d) => d.id)).toEqual([docId])
      expect(JSON.stringify(await loadDealerDealView(mine, draft.dealId))).not.toContain("memo.pdf")
    })
  })

  it("lets staff request a document on a dealer deal only, answered once by an upload of that type", async () => {
    const staff = staffOf(fx)
    await inTenant(fx, async () => {
      const staffDeal = dealerDeal(fx, { dealerId: null, dealerUserId: null, ...captureForDealer(fx, null) }).dealId
      expect(await requestDealerDocument(staff, staffDeal, { docType: "BANK_STATEMENT", note: "Three months" })).toMatchObject({ status: 409 })
      expect(await requestDealerDocument(staff, draft.dealId, { docType: "LEGAL_DOCUMENT", note: "x" })).toMatchObject({ status: 400 })
      expect(await requestDealerDocument(staff, draft.dealId, { docType: "BANK_STATEMENT", note: "x".repeat(501) })).toMatchObject({ status: 400 })
      const requested = await requestDealerDocument(staff, draft.dealId, { docType: "BANK_STATEMENT", note: "The latest three months" })
      if (requested.kind !== "requested") throw new Error(requested.error)
      expect((await loadDealerDealView(mine, draft.dealId))?.missing).toContain("Document: BANK_STATEMENT")
      expect(await uploadDealerDocument(mine, draft.dealId, pdfUpload("AFS"), requested.requestId)).toMatchObject({ status: 422 })
      expect(await uploadDealerDocument(theirs, draft.dealId, pdfUpload("BANK_STATEMENT"), requested.requestId)).toMatchObject({ status: 404 })
      const answered = await uploadDealerDocument(mine, draft.dealId, pdfUpload("BANK_STATEMENT"), requested.requestId)
      expect(answered).toMatchObject({ kind: "stored" })
      expect(sql(`SELECT "fulfilledDocumentId" IS NOT NULL FROM "DealerDocumentRequest" WHERE "id" = ${lit(requested.requestId)}`)).toBe("t")
      expect(await uploadDealerDocument(mine, draft.dealId, pdfUpload("BANK_STATEMENT"), requested.requestId)).toMatchObject({ status: 409 })
      expect((await loadDealerDealView(mine, draft.dealId))?.documentRequests).toEqual([expect.objectContaining({ fulfilled: true, note: "The latest three months" })])
    })
    expect(sql(`SELECT "userId" IS NULL FROM "AuditLog" WHERE "action" = 'DEALER_DOCUMENT_REQUEST_FULFILLED' AND "tenantId" = ${lit(fx.tenantId)}`)).toBe("t")
  })
})
