/**
 * Adversarial real-Postgres edges for the dealer follow-ups (consent v2, dealer
 * cancel, draft purge; migration 20261022100000_dealer_followups). Each test
 * asserts what SLICE5-FOLLOWUPS.md part D says should happen.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 TENANT_RLS=on DATABASE_URL=postgresql://... \
 *     npx vitest run --no-file-parallelism lib/dealer/edge-dealer-followups.integration.test.ts
 */
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealerFixture, cleanupDealerFixtureIfCreated, createDealerFixture, insertDealerUser, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { actorOf, assetBody, createdId, dealBody, dealerDraft, inTenant, personBody, type DealerDraft } from "./dealer-origination.integration-fixture"
import { bookedDealerDeal, captureForDealer, dealerDeal } from "./dealer-booking.integration-fixture"
import { createDealerDeal } from "./deals"
import { captureDealerAsset, captureDealerPerson } from "./capture"
import { attestDealerConsent } from "./consent"
import { cancelDealerDraft } from "./cancel"
import { purgeDealerDeal, purgeDealerDraftsOfTenant } from "./draft-purge"
import { age, storedDocument as storedDocumentOf } from "./draft-purge.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const t2 = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let fx2: DealerFixture
let secondProduct: string

const REASON = "The buyer chose another machine"
// The capture rate limit is per dealer user: every draft gets its own sales user.
const owners = new Map<string, ReturnType<typeof actorOf>>()
const freshActor = () => actorOf(fx, insertDealerUser(fx.tenantId, fx.dealerA, { role: "DEALER_SALES", byDealerUser: fx.adminUserA }), fx.dealerA)
async function mk(): Promise<DealerDraft> {
  const actor = freshActor()
  const draft = await dealerDraft(fx, actor)
  owners.set(draft.dealId, actor)
  owners.set(draft.entityId, actor)
  return draft
}
const ownerOf = (dealId: string) => owners.get(dealId)!
const reasonOf = (dealId: string) => sql(`SELECT coalesce("dealerDealPurgeReason"(${lit(fx.tenantId)}, ${lit(dealId)})::text, 'none')`)
const rowJson = (table: string, id: string) => sql(`SELECT to_jsonb(r) FROM "${table}" r WHERE "id" = ${lit(id)}`)
const dealStatus = (dealId: string) => sql(`SELECT "status" FROM "AssetFinanceDeal" WHERE "id" = ${lit(dealId)}`)

function consentDoc(dealId: string): string {
  const id = newId("doc")
  sql(`INSERT INTO "EntityDocument" ("id", "tenantId", "entityId", "dealId", "docType", "fileName", "mimeType", "fileSize", "storagePath",
      "contentSha256", "uploadedByType", "uploadedById")
    SELECT ${lit(id)}, ${lit(fx.tenantId)}, d."entityId", d."id", 'POPIA_CONSENT', 'consent.pdf', 'application/pdf', 1,
      '/nonexistent/consent.pdf', repeat('0', 64), 'dealer', ${lit(fx.salesUserA)}
    FROM "AssetFinanceDeal" d WHERE d."id" = ${lit(dealId)}`)
  return id
}
const attestSql = (draft: DealerDraft, documentId: string, over: { version?: string; method?: string | null; check?: string | null }) =>
  `INSERT INTO "DealerConsentAttestation" ("id", "tenantId", "dealId", "clientId", "documentId", "dealerUserId", "statementVersion",
     "statementText", "signingMethod", "remoteIdentityCheck")
   VALUES ('${newId("dca")}', ${lit(fx.tenantId)}, ${lit(draft.dealId)}, ${lit(draft.directorId)}, ${lit(documentId)},
     ${lit(fx.salesUserA)}, ${lit(over.version ?? "dealer-consent-v2")}, 'TEST statement',
     ${over.method === null ? "NULL" : `'${over.method ?? "REMOTE"}'`}, ${lit(over.check ?? null)})`
const attestCount = (dealId: string) => sql(`SELECT count(*) FROM "DealerConsentAttestation" WHERE "dealId" = ${lit(dealId)}`)

/** A second open deal of the same dealer on `entityId` (one open application per borrower and product: second product). */
async function secondDealOn(entityId: string): Promise<string> {
  const actor = owners.get(entityId)!
  return inTenant(fx, async () => {
    const assetId = createdId(await captureDealerAsset(actor, assetBody()))
    const deal = await createDealerDeal(actor, { ...dealBody(fx, { entityId }, assetId), productId: secondProduct })
    if (deal.kind !== "created") throw new Error(JSON.stringify(deal))
    return deal.dealId
  })
}

suite.sequential("dealer follow-ups: edges (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
    fx2 = await createDealerFixture(db, t2)
    secondProduct = (await db.loanProduct.create({
      data: {
        tenantId: fx.tenantId, code: `AF3-${t}`, name: "TEST plant instalment sale 3", productType: "ASSET_FINANCE",
        minAmount: 100, maxAmount: 1_000_000_000, minTermDays: 30, maxTermDays: 3650, interestRatePm: 1.0, interestModel: "DAILY_ACCRUAL",
      },
    })).id
  }, 120_000)

  afterAll(async () => {
    try { if (db) await cleanupDealerFixture(db, t2) }
    finally { await cleanupDealerFixtureIfCreated(db, t) }
  })

  describe("purge: what is linked elsewhere", () => {
    it("keeps a director who is also a director of another business; erases the purged business", async () => {
      const a = await mk()
      const b = await mk()
      sql(`INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "updatedAt")
        VALUES (${lit(newId("rel"))}, ${lit(fx.tenantId)}, ${lit(b.entityId)}, ${lit(a.directorId)}, 'DIRECTOR', CURRENT_TIMESTAMP)`)
      age(a.dealId, 91)
      const before = rowJson("Client", a.directorId)
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, a.dealId))).toMatchObject({ clientsErased: 0, clientsKept: 1, entitiesErased: 1 })
      expect(rowJson("Client", a.directorId)).toBe(before)
    })

    it("keeps the business and its director while the business has another open deal", async () => {
      const a = await mk()
      await secondDealOn(a.entityId)
      age(a.dealId, 91)
      const entityBefore = rowJson("BusinessEntity", a.entityId)
      const directorBefore = rowJson("Client", a.directorId)
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, a.dealId))).toMatchObject({ clientsKept: 1, clientsErased: 0, entitiesKept: 1, entitiesErased: 0 })
      expect(rowJson("BusinessEntity", a.entityId)).toBe(entityBefore)
      expect(rowJson("Client", a.directorId)).toBe(directorBefore)
    })

    it("keeps a business that a Loan names by entityId", async () => {
      const booked = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA)
      const entityId = sql(`SELECT "entityId" FROM "AssetFinanceDeal" WHERE "id" = ${lit(booked.dealId)}`)
      const assetId = captureForDealer(fx, fx.dealerA).assetId
      const draft = dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, entityId, assetId })
      age(draft.dealId, 91)
      const before = rowJson("BusinessEntity", entityId)
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, draft.dealId))).toMatchObject({ entitiesErased: 0, entitiesKept: 1 })
      expect(rowJson("BusinessEntity", entityId)).toBe(before)
    })
  })

  describe("purge: documents, boundary, re-run", () => {
    it("erases a staff-uploaded document of the deal too (spec: each document of the deal)", async () => {
      const draft = await mk()
      const doc = storedDocumentOf(fx, draft.dealId, "BANK_STATEMENT")
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE "EntityDocument" SET "uploadedByType" = 'staff', "uploadedById" = ${lit(fx.officer)} WHERE "id" = ${lit(doc.id)}; COMMIT;`)
      age(draft.dealId, 91)
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, draft.dealId))).toMatchObject({ documentsErased: 1 })
      expect(existsSync(doc.file)).toBe(false)
      expect(sql(`SELECT count(*) FROM "EntityDocument" WHERE "id" = ${lit(doc.id)}`)).toBe("0")
    })

    it("names a draft just past 90 days and not just short of it; the tombstone INSERT agrees", async () => {
      const draft = await mk()
      const insert = `INSERT INTO "DealerDealPurge" ("id", "tenantId", "dealId", "reason", "clientsErased", "clientsKept",
        "entitiesErased", "entitiesKept", "documentsErased", "documentsKept") VALUES ('${newId("ddp")}', ${lit(fx.tenantId)}, ${lit(draft.dealId)}, 'ABANDONED_DRAFT', 0, 0, 0, 0, 0, 0)`
      age(draft.dealId, 89.99)
      expect(reasonOf(draft.dealId)).toBe("none")
      expectRejected(insert, "This dealer deal may not be purged")
      age(draft.dealId, 0.02)
      expect(reasonOf(draft.dealId)).toBe("ABANDONED_DRAFT")
      sql(insert)
    })

    it("a re-run changes nothing: one tombstone, one audit row, no second purge", async () => {
      const draft = await mk()
      age(draft.dealId, 91)
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, draft.dealId))).not.toBeNull()
      const snapshot = rowJson("Client", draft.directorId)
      const run = await inTenant(fx, () => purgeDealerDraftsOfTenant(fx.tenantId))
      expect(run.failed).toBe(0)
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, draft.dealId))).toBeNull()
      expect(rowJson("Client", draft.directorId)).toBe(snapshot)
      expect(sql(`SELECT count(*) FROM "DealerDealPurge" WHERE "dealId" = ${lit(draft.dealId)}`)).toBe("1")
      expect(sql(`SELECT count(*) FROM "AuditLog" WHERE "action" = 'DEALER_DEAL_PURGED' AND "entityId" = ${lit(draft.dealId)}`)).toBe("1")
    })

    it("cancels with a document request open, then purges; the request stays, its deal's bytes go", async () => {
      const draft = await mk()
      const doc = storedDocumentOf(fx, draft.dealId, "BANK_STATEMENT")
      const open = newId("dr")
      sql(`INSERT INTO "DealerDocumentRequest" ("id", "tenantId", "dealId", "docType", "note", "requestedById")
        VALUES (${lit(open)}, ${lit(fx.tenantId)}, ${lit(draft.dealId)}, 'AFS', 'TEST please send', ${lit(fx.officer)})`)
      expect(await inTenant(fx, () => cancelDealerDraft(ownerOf(draft.dealId), draft.dealId, REASON))).toEqual({ kind: "cancelled" })
      age(draft.dealId, 91)
      expect(reasonOf(draft.dealId)).toBe("CANCELLED_DRAFT")
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, draft.dealId))).toMatchObject({ documentsErased: 1 })
      expect(existsSync(doc.file)).toBe(false)
      expect(sql(`SELECT count(*) FROM "DealerDocumentRequest" WHERE "id" = ${lit(open)}`)).toBe("1")
    })
  })

  describe("purge: collisions and tenant context", () => {
    it("erases a person although another client's email already looks like erased-<id>@erased.invalid", async () => {
      const draft = await mk()
      const other = await inTenant(fx, async () => createdId(await captureDealerPerson(freshActor(), personBody({ roles: undefined }))))
      sql(`UPDATE "Client" SET "email" = ${lit(`erased-${draft.directorId}@erased.invalid`)} WHERE "id" = ${lit(other)}`)
      age(draft.dealId, 91)
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, draft.dealId))).toMatchObject({ clientsErased: 1 })
    })

    it("erases a person although another client's idNumber already reads erased-<id>", async () => {
      const draft = await mk()
      const other = await inTenant(fx, async () => createdId(await captureDealerPerson(freshActor(), personBody({ roles: undefined }))))
      sql(`UPDATE "Client" SET "idNumber" = ${lit(`erased-${draft.directorId}`)} WHERE "id" = ${lit(other)}`)
      age(draft.dealId, 91)
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, draft.dealId))).toMatchObject({ clientsErased: 1 })
    })

    it("does not erase, tombstone or cancel across tenants, in either direction", async () => {
      const draft = await mk()
      age(draft.dealId, 91)
      const before = rowJson("Client", draft.directorId)
      // Tenant 2's scope asked to purge tenant 1's deal.
      await inTenant(fx2, () => purgeDealerDeal(fx.tenantId, draft.dealId)).catch(() => null)
      // Tenant 1's id asked of tenant 2's id.
      expect(await inTenant(fx, () => purgeDealerDeal(fx2.tenantId, draft.dealId)).catch(() => null)).toBeNull()
      expect(await inTenant(fx2, () => purgeDealerDeal(fx2.tenantId, draft.dealId)).catch(() => null)).toBeNull()
      expect(rowJson("Client", draft.directorId)).toBe(before)
      expect(sql(`SELECT count(*) FROM "DealerDealPurge" WHERE "dealId" = ${lit(draft.dealId)}`)).toBe("0")
      // A dealer user of tenant 2 cancelling tenant 1's draft.
      const foreign = await inTenant(fx2, () => cancelDealerDraft(actorOf(fx2, fx2.adminUserA, fx2.dealerA, "DEALER_ADMIN"), draft.dealId, REASON)).catch(() => null)
      expect(foreign === null || (foreign as { kind: string }).kind === "refused").toBe(true)
      expect(dealStatus(draft.dealId)).toBe("DRAFT")
    })
  })

  describe("dealer cancel", () => {
    it("refuses a deactivated creator and leaves the draft untouched; an admin can still cancel it", async () => {
      const gone = insertDealerUser(fx.tenantId, fx.dealerA, { role: "DEALER_SALES", byDealerUser: fx.adminUserA })
      const draft = await dealerDraft(fx, actorOf(fx, gone, fx.dealerA))
      sql(`UPDATE "DealerUser" SET "active" = false, "tokenVersion" = "tokenVersion" + 1 WHERE "id" = ${lit(gone)}`)
      const result = await inTenant(fx, () => cancelDealerDraft(actorOf(fx, gone, fx.dealerA), draft.dealId, REASON)).catch((e: Error) => e)
      expect(result).not.toEqual({ kind: "cancelled" })
      // SHOULD be a clean refusal, not a raw database error reaching the route as a 500.
      expect(result).not.toBeInstanceOf(Error)
      expect(dealStatus(draft.dealId)).toBe("DRAFT")
      expect(await inTenant(fx, () => cancelDealerDraft(actorOf(fx, fx.adminUserA, fx.dealerA, "DEALER_ADMIN"), draft.dealId, REASON))).toEqual({ kind: "cancelled" })
    })
  })

  describe("consent v2", () => {
    it("refuses by SQL an insert naming v1 with a signing method, and with none-method too", async () => {
      const draft = await mk()
      const doc = consentDoc(draft.dealId)
      expectRejected(attestSql(draft, doc, { version: "dealer-consent-v1", method: "IN_PERSON" }), "")
      expectRejected(attestSql(draft, doc, { version: "dealer-consent-v1", method: "REMOTE", check: "Video call with the ID document" }), "")
      expect(attestCount(draft.dealId)).toBe("0")
    })

    it("accepts a REMOTE identity check of exactly 10 and exactly 500 characters, refuses 9 and 501", async () => {
      const ten = await mk()
      const five = await mk()
      sql(attestSql(ten, consentDoc(ten.dealId), { check: "x".repeat(10) }))
      sql(attestSql(five, consentDoc(five.dealId), { check: "y".repeat(500) }))
      const draft = await mk()
      const doc = consentDoc(draft.dealId)
      expectRejected(attestSql(draft, doc, { check: "x".repeat(9) }), "DealerConsentAttestation_signing_method")
      expectRejected(attestSql(draft, doc, { check: "x".repeat(501) }), "DealerConsentAttestation_signing_method")
      expectRejected(attestSql(draft, doc, { check: ` ${"x".repeat(9)} ` }), "DealerConsentAttestation_signing_method")
      expect(attestCount(draft.dealId)).toBe("0")
    })

    it("accepts 500 and refuses 501 characters through the library", async () => {
      const ok = await mk()
      const bad = await mk()
      const run = (d: DealerDraft, check: string) => inTenant(fx, () => attestDealerConsent(ownerOf(d.dealId), d.dealId, {
        documentId: consentDoc(d.dealId), clientIds: [d.directorId], signingMethod: "REMOTE", remoteIdentityCheck: check,
      }))
      expect(await run(ok, "z".repeat(500))).toMatchObject({ kind: "attested" })
      expect(await run(bad, "z".repeat(501))).toMatchObject({ kind: "refused", status: 400 })
      expect(await run(bad, "z".repeat(10))).toMatchObject({ kind: "attested" })
    })

    it("refuses (400), not a database error, for a check the library and the CHECK count differently (5 emoji)", async () => {
      const draft = await mk()
      const result = await inTenant(fx, () => attestDealerConsent(ownerOf(draft.dealId), draft.dealId, {
        documentId: consentDoc(draft.dealId), clientIds: [draft.directorId], signingMethod: "REMOTE", remoteIdentityCheck: "\u{1F600}".repeat(5),
      })).catch((e: Error) => e)
      expect(result).not.toBeInstanceOf(Error)
      expect(result).toMatchObject({ kind: "refused", status: 400 })
    })

    it("refuses by SQL a REMOTE check that is ten tabs (blank once trimmed)", async () => {
      const draft = await mk()
      expectRejected(attestSql(draft, consentDoc(draft.dealId), { check: "\t".repeat(10) }), "DealerConsentAttestation_signing_method")
    })
  })
})
