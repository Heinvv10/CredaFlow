/**
 * Real-Postgres proof of the dealer draft purge's holds and set-once rules
 * (dealerDealPurgeReason, guardDealerPurgedParty, guardDealerPurgedPartyUse;
 * SLICE5-FOLLOWUPS.md part D): a staff deal is never named; every open DSAR
 * and complaint status holds a draft and every closed one releases it; a
 * sole proprietor is erased (and held like a director); an erased party is
 * erased once, never inserted erased, and never used again.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/draft-purge-holds.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, insertDealerUser, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { actorOf, assetBody, createdId, dealBody, dealerDraft, inTenant, personBody } from "./dealer-origination.integration-fixture"
import { captureForDealer, dealerDeal } from "./dealer-booking.integration-fixture"
import { captureDealerAsset, captureDealerPerson } from "./capture"
import { createDealerDeal } from "./deals"
import { purgeDealerDeal } from "./draft-purge"
import { age } from "./draft-purge.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
const salesActor = () => actorOf(fx, insertDealerUser(fx.tenantId, fx.dealerA, { role: "DEALER_SALES", byDealerUser: fx.adminUserA }), fx.dealerA)
const reasonOf = (dealId: string) => sql(`SELECT coalesce("dealerDealPurgeReason"(${lit(fx.tenantId)}, ${lit(dealId)})::text, 'none')`)
const purge = (dealId: string) => inTenant(fx, () => purgeDealerDeal(fx.tenantId, dealId))

async function soleDraft(): Promise<{ dealId: string; clientId: string }> {
  const actor = salesActor()
  return inTenant(fx, async () => {
    const clientId = createdId(await captureDealerPerson(actor, personBody({ roles: undefined })))
    const assetId = createdId(await captureDealerAsset(actor, assetBody()))
    const deal = await createDealerDeal(actor, dealBody(fx, { clientId }, assetId))
    if (deal.kind !== "created") throw new Error(JSON.stringify(deal))
    return { dealId: deal.dealId, clientId }
  })
}

suite.sequential("dealer draft purge holds (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("never names a staff deal, however old", async () => {
    const staff = dealerDeal(fx, { dealerId: null, dealerUserId: null, ...captureForDealer(fx, null) })
    age(staff.dealId, 400)
    expect(reasonOf(staff.dealId)).toBe("none")
    expect(await purge(staff.dealId)).toBeNull()
  })

  it("holds a draft for every open DSAR and complaint status, and releases it for every closed one", async () => {
    const draft = await dealerDraft(fx, salesActor())
    age(draft.dealId, 91)
    const dsar = newId("dsar")
    sql(`INSERT INTO "DataSubjectRequest" ("id", "tenantId", "clientId", "reference", "type", "status", "dueDate", "updatedAt")
      VALUES (${lit(dsar)}, ${lit(fx.tenantId)}, ${lit(draft.directorId)}, ${lit(dsar)}, 'ACCESS', 'RECEIVED', CURRENT_TIMESTAMP + INTERVAL '30 days', CURRENT_TIMESTAMP)`)
    for (const [status, held] of [["RECEIVED", true], ["IN_PROGRESS", true], ["OVERDUE", true], ["COMPLETED", false], ["REFUSED", false]] as const) {
      sql(`UPDATE "DataSubjectRequest" SET "status" = '${status}' WHERE "id" = ${lit(dsar)}`)
      age(draft.dealId, 1)
      expect(reasonOf(draft.dealId), status).toBe(held ? "none" : "ABANDONED_DRAFT")
    }
    const complaint = newId("cmp")
    sql(`INSERT INTO "Complaint" ("id", "tenantId", "clientId", "reference", "category", "description", "status", "createdById", "updatedAt")
      VALUES (${lit(complaint)}, ${lit(fx.tenantId)}, ${lit(draft.directorId)}, ${lit(complaint)}, 'OTHER', 'TEST complaint', 'OPEN', ${lit(fx.officer)}, CURRENT_TIMESTAMP)`)
    for (const [status, held] of [["OPEN", true], ["UNDER_INVESTIGATION", true], ["ESCALATED", true], ["ESCALATED_OMBUD", true], ["RESOLVED", false], ["CLOSED", false]] as const) {
      sql(`UPDATE "Complaint" SET "status" = '${status}' WHERE "id" = ${lit(complaint)}`)
      age(draft.dealId, 1)
      expect(reasonOf(draft.dealId), status).toBe(held ? "none" : "ABANDONED_DRAFT")
    }
  }, 30_000)

  it("erases a sole proprietor with no other link, and holds one with an open DSAR", async () => {
    const sole = await soleDraft()
    age(sole.dealId, 91)
    expect(await purge(sole.dealId)).toMatchObject({ clientsErased: 1, clientsKept: 0, entitiesErased: 0 })
    expect(sql(`SELECT "firstName", "dealerPurgedAt" IS NOT NULL FROM "Client" WHERE "id" = ${lit(sole.clientId)}`)).toBe("Erased|t")
    const held = await soleDraft()
    age(held.dealId, 91)
    sql(`INSERT INTO "DataSubjectRequest" ("id", "tenantId", "clientId", "reference", "type", "status", "dueDate", "updatedAt")
      VALUES ('${newId("dsar")}', ${lit(fx.tenantId)}, ${lit(held.clientId)}, '${newId("ref")}', 'ACCESS', 'IN_PROGRESS', CURRENT_TIMESTAMP + INTERVAL '30 days', CURRENT_TIMESTAMP)`)
    expect(reasonOf(held.dealId)).toBe("none")
  })

  it("erases once, never on insert, and never uses an erased party again", async () => {
    const draft = await dealerDraft(fx, salesActor())
    age(draft.dealId, 91)
    expect(await purge(draft.dealId)).toMatchObject({ clientsErased: 1, entitiesErased: 1 })
    expectRejected(`UPDATE "Client" SET "dealerPurgedAt" = CURRENT_TIMESTAMP + INTERVAL '1 day' WHERE "id" = ${lit(draft.directorId)}`,
      "A purged dealer capture stays purged")
    const id = newId("cli")
    expectRejected(`INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "createdByDealerId",
        "dealerPurgedAt", "updatedAt")
      VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(id)}, ${lit(id)}, 'TEST', 'New', ${lit(`${id}@client.invalid`)}, '+27820000000', ${lit(fx.dealerA)},
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, "A new row is not purged")
    // The dealer's lookups skip an erased party (404); the database refuses it underneath.
    const actor = salesActor()
    expect(await inTenant(fx, () => captureDealerPerson(actor, personBody(), draft.entityId))).toMatchObject({ kind: "refused", status: 404 })
    const assetId = createdId(await inTenant(fx, () => captureDealerAsset(actor, assetBody())))
    expect(await inTenant(fx, () => createDealerDeal(actor, dealBody(fx, { entityId: draft.entityId }, assetId)))).toMatchObject({ kind: "refused", status: 404 })
    const message = "An erased person or business is not used again"
    expectRejected(`INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "updatedAt")
      VALUES (${lit(newId("rel"))}, ${lit(fx.tenantId)}, ${lit(draft.entityId)}, ${lit(fx.director)}, 'DIRECTOR', CURRENT_TIMESTAMP)`, message)
    expectRejected(`UPDATE "LoanApplication" SET "clientId" = ${lit(draft.directorId)} WHERE "id" = (
      SELECT "applicationId" FROM "AssetFinanceDeal" WHERE "id" = ${lit(draft.dealId)})`, message)
  })
})
