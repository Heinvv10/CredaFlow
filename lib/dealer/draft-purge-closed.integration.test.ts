/**
 * Real-Postgres proof that a purged dealer draft is closed
 * (guardPurgedDealerDeal; lib/dealer/{submit,consent,documents}.ts refuse it
 * first): the dealer can no longer submit, attest or upload, SQL cannot add a
 * document, attestation or request or change the deal, and staff can still
 * cancel it. Also one whole run of purgeDealerDrafts (the cron's entry point).
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/draft-purge-closed.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, insertDealerUser, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { actorOf, dealerDraft, inTenant, pdfUpload, type DealerDraft } from "./dealer-origination.integration-fixture"
import { submitDealerDeal } from "./submit"
import { attestDealerConsent } from "./consent"
import { uploadDealerDocument } from "./documents"
import { purgeDealerDeal, purgeDealerDrafts } from "./draft-purge"
import { age, storedDocument } from "./draft-purge.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const CLOSED = { kind: "refused", status: 409, error: "This draft was closed and its details erased: start a new deal" }
let fx: DealerFixture
let purged: DealerDraft
let sales: ReturnType<typeof actorOf>

suite.sequential("a purged dealer draft is closed (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
    sales = actorOf(fx, insertDealerUser(fx.tenantId, fx.dealerA, { role: "DEALER_SALES", byDealerUser: fx.adminUserA }), fx.dealerA)
    purged = await dealerDraft(fx, sales)
    storedDocument(fx, purged.dealId)
    age(purged.dealId, 91)
    expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, purged.dealId))).toMatchObject({ clientsErased: 1 })
  }, 120_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("refuses the dealer's submit, attestation and upload", async () => {
    expect(await inTenant(fx, () => submitDealerDeal(sales, purged.dealId))).toEqual(CLOSED)
    expect(await inTenant(fx, () => attestDealerConsent(sales, purged.dealId, {
      documentId: "doc-any", clientIds: [purged.directorId], signingMethod: "IN_PERSON",
    }))).toEqual(CLOSED)
    expect(await inTenant(fx, () => uploadDealerDocument(sales, purged.dealId, pdfUpload("BANK_STATEMENT")))).toEqual(CLOSED)
  })

  it("refuses by SQL a new document, attestation or request, and any change to the deal but its cancellation", () => {
    const message = "A purged dealer deal is closed: nothing is added to it"
    expectRejected(`INSERT INTO "EntityDocument" ("id", "tenantId", "dealId", "docType", "fileName", "mimeType", "fileSize", "storagePath",
        "contentSha256", "uploadedByType", "uploadedById")
      VALUES ('${newId("doc")}', ${lit(fx.tenantId)}, ${lit(purged.dealId)}, 'OTHER', 'x.pdf', 'application/pdf', 1, '/nonexistent/x.pdf',
        repeat('0', 64), 'staff', ${lit(fx.officer)})`, message)
    expectRejected(`INSERT INTO "DealerDocumentRequest" ("id", "tenantId", "dealId", "docType", "note", "requestedById")
      VALUES ('${newId("ddr")}', ${lit(fx.tenantId)}, ${lit(purged.dealId)}, 'BANK_STATEMENT', 'TEST statement', ${lit(fx.officer)})`, message)
    // The deal's documents are gone; the closed-deal trigger fires first, before the document check would.
    expectRejected(`INSERT INTO "DealerConsentAttestation" ("id", "tenantId", "dealId", "clientId", "documentId", "dealerUserId",
        "statementVersion", "statementText", "signingMethod")
      VALUES ('${newId("dca")}', ${lit(fx.tenantId)}, ${lit(purged.dealId)}, ${lit(purged.directorId)}, 'doc-none', ${lit(fx.salesUserA)},
        'dealer-consent-v2', 'TEST', 'IN_PERSON')`, message)
    expectRejected(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(purged.dealId)}`,
      "A purged dealer deal is closed: it is only cancelled")
    sql(`UPDATE "AssetFinanceDeal" SET "status" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP, "cancelledById" = ${lit(fx.officer)},
      "cancelReason" = 'Closed after the dealer purge' WHERE "id" = ${lit(purged.dealId)}`)
    expect(sql(`SELECT "status" FROM "AssetFinanceDeal" WHERE "id" = ${lit(purged.dealId)}`)).toBe("CANCELLED")
  })

  it("purges every eligible draft of the lender in one run, and the next run finds nothing of it", async () => {
    const actor = actorOf(fx, insertDealerUser(fx.tenantId, fx.dealerA, { role: "DEALER_SALES", byDealerUser: fx.adminUserA }), fx.dealerA)
    const stale = [await dealerDraft(fx, actor), await dealerDraft(fx, actor)]
    const fresh = await dealerDraft(fx, actor)
    for (const draft of stale) age(draft.dealId, 91)
    const run = await purgeDealerDrafts()
    expect(run.ok).toBe(true)
    expect(run.deals).toBeGreaterThanOrEqual(2)
    const tombstones = (ids: string[]) => sql(`SELECT count(*) FROM "DealerDealPurge" WHERE "dealId" IN (${ids.map(lit).join(", ")})`)
    expect(tombstones(stale.map((d) => d.dealId))).toBe("2")
    expect(tombstones([fresh.dealId])).toBe("0")
    expect(sql(`SELECT count(*) FROM "DealerDealPurge" WHERE "tenantId" = ${lit(fx.tenantId)}`)).toBe("3")
    await purgeDealerDrafts()
    expect(sql(`SELECT count(*) FROM "DealerDealPurge" WHERE "tenantId" = ${lit(fx.tenantId)}`)).toBe("3")
  })
})
