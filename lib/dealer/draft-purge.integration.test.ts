/**
 * Real-Postgres proof of the dealer draft purge (migration
 * 20261022100000_dealer_followups, lib/dealer/draft-purge.ts,
 * SLICE5-FOLLOWUPS.md part D): which deal is purged (dealerDealPurgeReason),
 * what is erased (dealer-captured people and business not linked elsewhere,
 * the deal's documents and their bytes), what stays (the deal, the tombstone,
 * the audit, a shared person, and everything of a booked deal), and the
 * database's own refusals (guardDealerDealPurge, guardDealerPurgedParty).
 * Dates are moved back with the triggers off, as history.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/draft-purge.integration.test.ts
 */
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, insertDealerUser, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { actorOf, assetBody, createdId, dealBody, dealerDraft, inTenant, personBody, type DealerDraft } from "./dealer-origination.integration-fixture"
import { bookedDealerDeal, submitSql } from "./dealer-booking.integration-fixture"
import { createDealerDeal } from "./deals"
import { captureDealerAsset, captureDealerPerson } from "./capture"
import { attestDealerConsent } from "./consent"
import { cancelDealerDraft } from "./cancel"
import { purgeDealerDeal, purgeDealerDraftsOfTenant } from "./draft-purge"
import { age, storedDocument as storedDocumentOf } from "./draft-purge.integration-fixture"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
const storedDocument = (dealId: string, docType?: string) => storedDocumentOf(fx, dealId, docType)

const reasonOf = (dealId: string) => sql(`SELECT coalesce("dealerDealPurgeReason"(${lit(fx.tenantId)}, ${lit(dealId)})::text, 'none')`)
const rowJson = (table: string, id: string) => sql(`SELECT to_jsonb(r) FROM "${table}" r WHERE "id" = ${lit(id)}`)
// A fresh sales user per draft: a dealer user may capture 30 records in 15 minutes.
const salesActor = () => actorOf(fx, insertDealerUser(fx.tenantId, fx.dealerA, { role: "DEALER_SALES", byDealerUser: fx.adminUserA }), fx.dealerA)

async function attested(draft: DealerDraft): Promise<{ id: string; file: string }> {
  const doc = storedDocument(draft.dealId)
  const result = await inTenant(fx, () => attestDealerConsent(salesActor(), draft.dealId, {
    documentId: doc.id, clientIds: [draft.directorId], signingMethod: "IN_PERSON",
  }))
  expect(result).toMatchObject({ kind: "attested" })
  return doc
}

suite.sequential("dealer draft purge (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  describe("which deal", () => {
    it("leaves a draft active within 90 days, and names it at 91", async () => {
      const draft = await dealerDraft(fx, salesActor())
      age(draft.dealId, 89)
      expect(reasonOf(draft.dealId)).toBe("none")
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, draft.dealId))).toBeNull()
      // A document uploaded yesterday is activity: aging the deal alone does not make it old.
      age(draft.dealId, 2)
      storedDocument(draft.dealId, "BANK_STATEMENT")
      expect(reasonOf(draft.dealId)).toBe("none")
    })

    it("counts every kind of activity on the draft, its people, business and asset", async () => {
      const draft = await dealerDraft(fx, salesActor())
      // Edits go through Prisma, as the app's do (it sets updatedAt).
      const touches: Array<[string, () => Promise<unknown>]> = [
        ["person", () => db!.client.update({ where: { id: draft.directorId }, data: { phone: "+27820000001" } })],
        ["business", () => db!.businessEntity.update({ where: { id: draft.entityId }, data: { tradingName: "TEST Trading" } })],
        ["asset", () => db!.financedAsset.update({ where: { id: draft.assetId }, data: { insurer: "TEST Insurer" } })],
        ["relationship", async () => sql(`BEGIN; SET LOCAL session_replication_role = replica;
          UPDATE "EntityRelationship" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "entityId" = ${lit(draft.entityId)}; COMMIT;`)],
        ["request", async () => sql(`INSERT INTO "DealerDocumentRequest" ("id", "tenantId", "dealId", "docType", "note", "requestedById")
          VALUES ('${newId("ddr")}', ${lit(fx.tenantId)}, ${lit(draft.dealId)}, 'BANK_STATEMENT', 'TEST latest statement', ${lit(fx.officer)})`)],
      ]
      for (const [what, touch] of touches) {
        age(draft.dealId, 91)
        expect(reasonOf(draft.dealId), what).toBe("ABANDONED_DRAFT")
        await touch()
        expect(reasonOf(draft.dealId), what).toBe("none")
      }
      age(draft.dealId, 91)
      await attested(draft)
      expect(reasonOf(draft.dealId)).toBe("none")
    })

    it("never names a deal handed to the lender, however old (its retention is the lender's, NCA Regulation 55)", async () => {
      const declined = await dealerDraft(fx, salesActor())
      sql(submitSql(declined.dealId))
      sql(`UPDATE "AssetFinanceDeal" SET "status" = 'DECLINED', "decision" = 'DECLINE', "decidedById" = ${lit(fx.adminA)},
        "decidedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(declined.dealId)}`)
      const waiting = await dealerDraft(fx, salesActor())
      sql(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(waiting.dealId)}`)
      const cancelled = await dealerDraft(fx, salesActor())
      sql(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(cancelled.dealId)}`)
      sql(`UPDATE "AssetFinanceDeal" SET "status" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP, "cancelledById" = ${lit(fx.officer)},
        "cancelReason" = 'The lender cancelled the deal' WHERE "id" = ${lit(cancelled.dealId)}`)
      for (const { dealId } of [declined, waiting, cancelled]) {
        age(dealId, 5 * 366)
        expect(reasonOf(dealId)).toBe("none")
      }
    })

    it("names a cancelled draft 90 days after the cancellation, not before", async () => {
      const actor = salesActor()
      const draft = await dealerDraft(fx, actor)
      expect(await inTenant(fx, () => cancelDealerDraft(actor, draft.dealId, "The buyer chose another machine"))).toEqual({ kind: "cancelled" })
      age(draft.dealId, 89)
      expect(reasonOf(draft.dealId)).toBe("none")
      age(draft.dealId, 2)
      expect(reasonOf(draft.dealId)).toBe("CANCELLED_DRAFT")
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, draft.dealId))).toMatchObject({ clientsErased: 1, entitiesErased: 1 })
    })

    it("holds a draft while a person on it has an open DSAR or complaint", async () => {
      const draft = await dealerDraft(fx, salesActor())
      age(draft.dealId, 91)
      const dsar = newId("dsar")
      sql(`INSERT INTO "DataSubjectRequest" ("id", "tenantId", "clientId", "reference", "type", "status", "dueDate", "updatedAt")
        VALUES (${lit(dsar)}, ${lit(fx.tenantId)}, ${lit(draft.directorId)}, ${lit(dsar)}, 'ACCESS', 'RECEIVED', CURRENT_TIMESTAMP + INTERVAL '30 days', CURRENT_TIMESTAMP)`)
      expect(reasonOf(draft.dealId)).toBe("none")
      sql(`UPDATE "DataSubjectRequest" SET "status" = 'COMPLETED' WHERE "id" = ${lit(dsar)}`)
      age(draft.dealId, 1)
      expect(reasonOf(draft.dealId)).toBe("ABANDONED_DRAFT")
      const complaint = newId("cmp")
      sql(`INSERT INTO "Complaint" ("id", "tenantId", "clientId", "reference", "category", "description", "status", "createdById", "updatedAt")
        VALUES (${lit(complaint)}, ${lit(fx.tenantId)}, ${lit(draft.directorId)}, ${lit(complaint)}, 'OTHER', 'TEST complaint', 'OPEN', ${lit(fx.officer)}, CURRENT_TIMESTAMP)`)
      expect(reasonOf(draft.dealId)).toBe("none")
      sql(`UPDATE "Complaint" SET "status" = 'RESOLVED' WHERE "id" = ${lit(complaint)}`)
      age(draft.dealId, 1)
      expect(reasonOf(draft.dealId)).toBe("ABANDONED_DRAFT")
    })

    it("refuses a tombstone for a deal it does not name, and never changes or deletes one", async () => {
      const draft = await dealerDraft(fx, salesActor())
      const insert = (reason: string) => `INSERT INTO "DealerDealPurge" ("id", "tenantId", "dealId", "reason", "clientsErased", "clientsKept",
        "entitiesErased", "entitiesKept", "documentsErased", "documentsKept")
        VALUES ('${newId("ddp")}', ${lit(fx.tenantId)}, ${lit(draft.dealId)}, '${reason}', 0, 0, 0, 0, 0, 0)`
      expectRejected(insert("ABANDONED_DRAFT"), "This dealer deal may not be purged (or not for that reason)")
      age(draft.dealId, 91)
      expectRejected(insert("CANCELLED_DRAFT"), "This dealer deal may not be purged (or not for that reason)")
      sql(insert("ABANDONED_DRAFT"))
      expectRejected(`UPDATE "DealerDealPurge" SET "clientsKept" = 1 WHERE "dealId" = ${lit(draft.dealId)}`, "never changed or deleted")
      expectRejected(`DELETE FROM "DealerDealPurge" WHERE "dealId" = ${lit(draft.dealId)}`, "never changed or deleted")
    })
  })

  describe("what is erased and what stays", () => {
    it("erases an abandoned draft's people, business and documents; keeps the deal, attestation, tombstone and audit", async () => {
      const draft = await dealerDraft(fx, salesActor())
      const consent = await attested(draft)
      const loose = storedDocument(draft.dealId, "BANK_STATEMENT")
      age(draft.dealId, 91)
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, draft.dealId))).toEqual({
        clientsErased: 1, clientsKept: 0, entitiesErased: 1, entitiesKept: 0, documentsErased: 2, documentsKept: 0, filesNotDeleted: 0,
      })
      expect(sql(`SELECT "firstName", "lastName", "idNumber" LIKE 'erased-' || "id" || '-%', "email" LIKE 'erased-' || "id" || '-%@erased.invalid', "phone",
        "addressLine1" IS NULL, "dealerPurgedAt" IS NOT NULL FROM "Client" WHERE "id" = ${lit(draft.directorId)}`)).toBe("Erased|Erased|t|t||t|t")
      expect(sql(`SELECT "legalName", "registrationNumber" LIKE 'erased-' || "id" || '-%', "addressLine1" IS NULL FROM "BusinessEntity"
        WHERE "id" = ${lit(draft.entityId)}`)).toBe("Erased|t|t")
      expect(existsSync(consent.file) || existsSync(loose.file)).toBe(false)
      // The attested form is referred to: kept, soft-deleted, renamed. The loose one is gone.
      expect(sql(`SELECT "fileName", "deletedAt" IS NOT NULL FROM "EntityDocument" WHERE "id" = ${lit(consent.id)}`)).toBe("erased|t")
      expect(sql(`SELECT count(*) FROM "EntityDocument" WHERE "id" = ${lit(loose.id)}`)).toBe("0")
      expect(sql(`SELECT count(*) FROM "DealerConsentAttestation" WHERE "dealId" = ${lit(draft.dealId)}`)).toBe("1")
      expect(sql(`SELECT "status", "reason" FROM "AssetFinanceDeal" d JOIN "DealerDealPurge" p ON p."dealId" = d."id" WHERE d."id" = ${lit(draft.dealId)}`))
        .toBe("DRAFT|ABANDONED_DRAFT")
      expect(sql(`SELECT "userId" IS NULL, "newValue"->>'clientsErased', "newValue"->>'documentsErased' FROM "AuditLog"
        WHERE "action" = 'DEALER_DEAL_PURGED' AND "entityId" = ${lit(draft.dealId)}`)).toBe("t|1|2")
      // Run again: nothing happens.
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, draft.dealId))).toBeNull()
    })

    it("keeps a person who is also a sole proprietor on another live deal", async () => {
      const actor = salesActor()
      const deals = await inTenant(fx, async () => {
        const soleId = createdId(await captureDealerPerson(actor, personBody({ roles: undefined })))
        const ids: string[] = []
        // One open application per person and product: the second deal is on a second product.
        const secondProduct = (await db!.loanProduct.create({
          data: {
            tenantId: fx.tenantId, code: `AF2-${t}`, name: "TEST plant instalment sale 2", productType: "ASSET_FINANCE",
            minAmount: 100, maxAmount: 1_000_000_000, minTermDays: 30, maxTermDays: 3650, interestRatePm: 1.0, interestModel: "DAILY_ACCRUAL",
          },
        })).id
        for (const productId of [fx.product, secondProduct]) {
          const assetId = createdId(await captureDealerAsset(actor, assetBody()))
          const deal = await createDealerDeal(actor, { ...dealBody(fx, { clientId: soleId }, assetId), productId })
          if (deal.kind !== "created") throw new Error(JSON.stringify(deal))
          ids.push(deal.dealId)
        }
        return { soleId, ids }
      })
      const soleId = deals.soleId
      age(deals.ids[0], 91)
      const before = rowJson("Client", soleId)
      expect(await inTenant(fx, () => purgeDealerDeal(fx.tenantId, deals.ids[0]))).toMatchObject({ clientsErased: 0, clientsKept: 1 })
      expect(rowJson("Client", soleId)).toBe(before)
      expectRejected(`UPDATE "Client" SET "dealerPurgedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(soleId)}`,
        "This dealer capture is linked to more than a purged dealer deal: it is kept")
    })

    it("never touches a booked deal: its people, business and documents stay byte-identical", async () => {
      const { dealId } = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA)
      const entityId = sql(`SELECT "entityId" FROM "AssetFinanceDeal" WHERE "id" = ${lit(dealId)}`)
      // A director the dealer captured, linked as history (a booked deal's business takes no new dealer people).
      const directorId = newId("cli")
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
        INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "createdByDealerId", "updatedAt")
        VALUES (${lit(directorId)}, ${lit(fx.tenantId)}, ${lit(directorId)}, ${lit(directorId)}, 'TEST', 'Booked', ${lit(`${directorId}@client.invalid`)},
          '+27820000000', ${lit(fx.dealerA)}, CURRENT_TIMESTAMP);
        INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "updatedAt")
        VALUES (${lit(newId("rel"))}, ${lit(fx.tenantId)}, ${lit(entityId)}, ${lit(directorId)}, 'DIRECTOR', CURRENT_TIMESTAMP);
        COMMIT;`)
      const doc = storedDocument(dealId, "BANK_STATEMENT")
      age(dealId, 4 * 366)
      const snapshot = () => [rowJson("BusinessEntity", entityId), rowJson("EntityDocument", doc.id),
        sql(`SELECT string_agg(to_jsonb(c)::text, ',' ORDER BY c."id") FROM "Client" c JOIN "EntityRelationship" r ON r."clientId" = c."id"
          WHERE r."entityId" = ${lit(entityId)}`), rowJson("Client", directorId)]
      const before = snapshot()
      expect(reasonOf(dealId)).toBe("none")
      await inTenant(fx, () => purgeDealerDraftsOfTenant(fx.tenantId))
      expect(snapshot()).toEqual(before)
      expect(existsSync(doc.file)).toBe(true)
      expect(sql(`SELECT count(*) FROM "DealerDealPurge" WHERE "dealId" = ${lit(dealId)}`)).toBe("0")
      expectRejected(`UPDATE "BusinessEntity" SET "dealerPurgedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(entityId)}`,
        "This dealer capture is linked to more than a purged dealer deal: it is kept")
    })

    it("refuses erasing a staff-captured person, and erasing twice", async () => {
      expectRejected(`UPDATE "Client" SET "dealerPurgedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(fx.director)}`,
        "Only a dealer-captured person or business is purged")
      const draft = await dealerDraft(fx, salesActor())
      age(draft.dealId, 91)
      await inTenant(fx, () => purgeDealerDeal(fx.tenantId, draft.dealId))
      expectRejected(`UPDATE "Client" SET "dealerPurgedAt" = NULL WHERE "id" = ${lit(draft.directorId)}`, "A purged dealer capture stays purged")
    })
  })
})
