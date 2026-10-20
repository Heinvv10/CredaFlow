/**
 * Real-Postgres proof that a person a dealer captured, with contact details
 * staff have not verified, is linked to a business only while that business
 * has no deal beyond the same dealer's own unsubmitted draft
 * (EntityRelationship_dealer_contact_link, migration 20261019120600; review
 * round 3). Any other live deal on it, a staff one, another dealer's, or the
 * dealer's own deal once handed over, refuses the link: the person would
 * receive that deal's messages. captureDealerPerson answers 409 first, in the
 * same transaction.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-entity-people.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { captureForDealer, dealerDeal } from "./dealer-booking.integration-fixture"
import { actorOf, inTenant, personBody } from "./dealer-origination.integration-fixture"
import { captureDealerPerson } from "./capture"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
const RULE = "contact details staff have not verified"

function client(dealerId: string | null, verified = false): string {
  const id = newId("cli")
  sql(`INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "createdByDealerId", "updatedAt")
    VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(id)}, ${lit(syntheticSaIdNumber())}, 'TEST', 'Person', ${lit(`${id}@client.invalid`)}, '+27820000000',
      ${lit(dealerId)}, CURRENT_TIMESTAMP)`)
  if (verified) sql(`UPDATE "Client" SET "dealerContactVerifiedAt" = CURRENT_TIMESTAMP, "dealerContactVerifiedById" = ${lit(fx.officer)} WHERE "id" = ${lit(id)}`)
  return id
}
const link = (entityId: string, clientId: string) => `INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "active", "updatedAt")
  VALUES (${lit(newId("rel"))}, ${lit(fx.tenantId)}, ${lit(entityId)}, ${lit(clientId)}, 'DIRECTOR', true, CURRENT_TIMESTAMP)`
const sales = () => actorOf(fx, fx.salesUserA, fx.dealerA)
const capture = (entityId: string) => inTenant(fx, () => captureDealerPerson(sales(), personBody(), entityId))

suite.sequential("linking dealer-captured people to a business (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("allows the link while the business has only the same dealer's unsubmitted draft (or no deal)", async () => {
    const own = captureForDealer(fx, fx.dealerA)
    sql(link(own.entityId, client(fx.dealerA)))
    dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...own })
    sql(link(own.entityId, client(fx.dealerA)))
    expect(await capture(own.entityId)).toMatchObject({ kind: "created" })
  })

  it("refuses it once the dealer's own deal is handed over", async () => {
    const own = captureForDealer(fx, fx.dealerA)
    const { dealId } = dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...own })
    sql(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(dealId)}`)
    expectRejected(link(own.entityId, client(fx.dealerA)), RULE)
    expect(await capture(own.entityId)).toMatchObject({ kind: "refused", status: 409 })
  })

  it("refuses it for a business with a staff deal on it", async () => {
    const own = captureForDealer(fx, fx.dealerA)
    dealerDeal(fx, { dealerId: null, dealerUserId: null, ...own })
    expectRejected(link(own.entityId, client(fx.dealerA)), RULE)
    expect(await capture(own.entityId)).toMatchObject({ kind: "refused", status: 409 })
  })

  it("refuses a person of one dealer on a business with another dealer's draft", () => {
    const theirs = captureForDealer(fx, fx.dealerB)
    dealerDeal(fx, { dealerId: fx.dealerB, dealerUserId: fx.userB, ...theirs })
    expectRejected(link(theirs.entityId, client(fx.dealerA)), RULE)
  })

  it("refuses re-activating or re-pointing a link to such a person, and allows a verified or lender-captured one", () => {
    const own = captureForDealer(fx, fx.dealerA)
    const unverified = client(fx.dealerA)
    const rel = newId("rel")
    sql(`INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "active", "updatedAt")
      VALUES (${lit(rel)}, ${lit(fx.tenantId)}, ${lit(own.entityId)}, ${lit(unverified)}, 'DIRECTOR', false, CURRENT_TIMESTAMP)`)
    dealerDeal(fx, { dealerId: null, dealerUserId: null, ...own })
    expectRejected(`UPDATE "EntityRelationship" SET "active" = true WHERE "id" = ${lit(rel)}`, RULE)
    const lenders = client(null)
    sql(link(own.entityId, lenders))
    const staffRel = sql(`SELECT "id" FROM "EntityRelationship" WHERE "clientId" = ${lit(lenders)}`)
    expectRejected(`UPDATE "EntityRelationship" SET "clientId" = ${lit(client(fx.dealerA))} WHERE "id" = ${lit(staffRel)}`, RULE)
    sql(link(own.entityId, client(fx.dealerA, true)))
  })
})
