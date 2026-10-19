/**
 * Real-Postgres proof of the provenance hardening (migration
 * 20261019120200_dealer_portal_hardening):
 *
 *  - `createdByDealerId` on Client, BusinessEntity and FinancedAsset is
 *    written once, at INSERT: an UPDATE that sets, clears or changes it is
 *    refused (guardCreatedByDealerFixed), so a staff-captured row can never be
 *    re-badged as a dealer's to pass the dealer-deal provenance check.
 *  - A dealer deal's borrower and asset are fixed after insert
 *    (guardDealerDealParties): the INSERT-time provenance check is never
 *    sidestepped by an UPDATE. A staff deal keeps its existing rules.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-provenance.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { captureForDealer, dealerDeal } from "./dealer-booking.integration-fixture"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture

const FIXED = "createdByDealerId is set when the row is created and never changed"
const PARTIES_FIXED = "A dealer deal's borrower and asset are the ones its dealer captured: they are fixed"

function person(dealerId: string | null): string {
  const id = newId("cli")
  sql(`INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "createdByDealerId", "updatedAt")
    VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(id)}, ${lit(syntheticSaIdNumber())}, 'TEST', 'Person', ${lit(`${id}@client.invalid`)}, '+27820000000',
      ${lit(dealerId)}, CURRENT_TIMESTAMP)`)
  return id
}
const setDealer = (table: string, id: string, dealerId: string | null) =>
  `UPDATE "${table}" SET "createdByDealerId" = ${lit(dealerId)} WHERE "id" = ${lit(id)}`

suite.sequential("dealer provenance is written once (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("refuses badging a staff-captured client, entity or asset as a dealer's", () => {
    const staff = captureForDealer(fx, null)
    const client = person(null)
    expectRejected(setDealer("Client", client, fx.dealerA), `Client.${FIXED}`)
    expectRejected(setDealer("BusinessEntity", staff.entityId, fx.dealerA), `BusinessEntity.${FIXED}`)
    expectRejected(setDealer("FinancedAsset", staff.assetId, fx.dealerA), `FinancedAsset.${FIXED}`)
  })

  it("refuses moving a dealer's row to another dealer, or clearing it", () => {
    const mine = captureForDealer(fx, fx.dealerA)
    const client = person(fx.dealerA)
    expectRejected(setDealer("Client", client, fx.dealerB), `Client.${FIXED}`)
    expectRejected(setDealer("Client", client, null), `Client.${FIXED}`)
    expectRejected(setDealer("BusinessEntity", mine.entityId, fx.dealerB), `BusinessEntity.${FIXED}`)
    expectRejected(setDealer("BusinessEntity", mine.entityId, null), `BusinessEntity.${FIXED}`)
    expectRejected(setDealer("FinancedAsset", mine.assetId, fx.dealerB), `FinancedAsset.${FIXED}`)
    expectRejected(setDealer("FinancedAsset", mine.assetId, null), `FinancedAsset.${FIXED}`)
  })

  it("lets every other column of those rows change, and an UPDATE that leaves it as it is", () => {
    const mine = captureForDealer(fx, fx.dealerA)
    const client = person(fx.dealerA)
    sql(`UPDATE "Client" SET "firstName" = 'TESTER', "createdByDealerId" = ${lit(fx.dealerA)} WHERE "id" = ${lit(client)}`)
    sql(`UPDATE "BusinessEntity" SET "tradingName" = 'TEST Trading' WHERE "id" = ${lit(mine.entityId)}`)
    sql(`UPDATE "FinancedAsset" SET "model" = 'TLB-2' WHERE "id" = ${lit(mine.assetId)}`)
    expect(sql(`SELECT "createdByDealerId" FROM "Client" WHERE "id" = ${lit(client)}`)).toBe(fx.dealerA)
  })

  it("fixes a dealer deal's borrower and asset after insert", () => {
    const mine = captureForDealer(fx, fx.dealerA)
    const other = captureForDealer(fx, fx.dealerA)
    const staff = captureForDealer(fx, null)
    const { dealId } = dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...mine })
    const update = (set: string) => `UPDATE "AssetFinanceDeal" SET ${set} WHERE "id" = ${lit(dealId)}`
    expectRejected(update(`"assetId" = ${lit(staff.assetId)}`), PARTIES_FIXED)
    expectRejected(update(`"assetId" = ${lit(other.assetId)}`), PARTIES_FIXED)
    expectRejected(update(`"entityId" = ${lit(staff.entityId)}`), PARTIES_FIXED)
    expectRejected(update(`"entityId" = ${lit(other.entityId)}`), PARTIES_FIXED)
    expectRejected(update(`"entityId" = NULL, "clientId" = ${lit(person(fx.dealerA))}`), PARTIES_FIXED)
    expect(sql(`SELECT "entityId", "assetId" FROM "AssetFinanceDeal" WHERE "id" = ${lit(dealId)}`)).toBe(`${mine.entityId}|${mine.assetId}`)
  })

  it("leaves a staff deal's draft asset change to the existing rules", () => {
    const staff = captureForDealer(fx, null)
    const swap = captureForDealer(fx, null)
    const { dealId } = dealerDeal(fx, { dealerId: null, dealerUserId: null, ...staff })
    sql(`UPDATE "AssetFinanceDeal" SET "assetId" = ${lit(swap.assetId)} WHERE "id" = ${lit(dealId)}`)
    expect(sql(`SELECT "assetId" FROM "AssetFinanceDeal" WHERE "id" = ${lit(dealId)}`)).toBe(swap.assetId)
  })
})
