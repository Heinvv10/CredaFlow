/**
 * Real-Postgres proof of the dealer columns on AssetFinanceDeal (migration
 * 20261019120100_dealer_portal, guardAssetDealDealer and CHECK
 * AssetFinanceDeal_dealer_pair): a dealer deal needs an active dealer of the
 * tenant, an active user of that dealer as its creator, the portal on, and a
 * borrower and asset the same dealer captured (provenance); the dealer is
 * fixed after insert; dealerSubmittedAt is set once, only while DRAFT.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-deal.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, insertDealer, insertDealerUser, lit, type DealerFixture } from "./dealer.integration-fixture"
import { captureForDealer, dealerDeal, dealerDealInsert, submitSql, type Captured } from "./dealer-booking.integration-fixture"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let mine: Captured

const refused = (input: Parameters<typeof dealerDealInsert>[1], message: string) => expectRejected(dealerDealInsert(fx, input).insert, message)
const config = (set: string) => sql(`UPDATE "TenantConfig" SET ${set} WHERE "tenantId" = ${lit(fx.tenantId)}`)

suite.sequential("dealer deals: provenance and the dealer columns (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
    mine = captureForDealer(fx, fx.dealerA)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("accepts a dealer deal on the dealer's own borrower and asset, created by its user", () => {
    const { dealId } = dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...captureForDealer(fx, fx.dealerA) })
    expect(sql(`SELECT "dealerId", "createdById" FROM "AssetFinanceDeal" WHERE "id" = ${lit(dealId)}`)).toBe(`${fx.dealerA}|${fx.salesUserA}`)
  })

  it("refuses a staff-captured borrower or asset, or another dealer's", () => {
    const base = { dealerId: fx.dealerA, dealerUserId: fx.salesUserA }
    const theirs = captureForDealer(fx, fx.dealerB)
    const staff = captureForDealer(fx, null)
    refused({ ...base, entityId: fx.evidenced, assetId: mine.assetId }, "A dealer deal's borrower was captured by that dealer")
    refused({ ...base, entityId: theirs.entityId, assetId: mine.assetId }, "A dealer deal's borrower was captured by that dealer")
    refused({ ...base, entityId: mine.entityId, assetId: staff.assetId }, "A dealer deal's asset was captured by that dealer")
    refused({ ...base, entityId: mine.entityId, assetId: theirs.assetId }, "A dealer deal's asset was captured by that dealer")
    refused({ ...base, clientId: fx.director, assetId: mine.assetId }, "A dealer deal's borrower was captured by that dealer")
  })

  it("refuses a user of another dealer, and a creator who is not the dealer user", () => {
    refused({ dealerId: fx.dealerA, dealerUserId: fx.userB, ...mine }, "A dealer deal is created by an active user of that dealer")
    refused({ dealerId: fx.dealerA, dealerUserId: fx.salesUserA, createdById: fx.officer, ...mine }, "AssetFinanceDeal_dealer_pair")
    refused({ dealerId: fx.dealerA, dealerUserId: null, ...mine }, "AssetFinanceDeal_dealer_pair")
  })

  it("refuses an inactive dealer or dealer user", () => {
    const dealer = insertDealer(fx.tenantId, fx.adminA, { name: `TEST Inactive ${t}` })
    const user = insertDealerUser(fx.tenantId, dealer, { byUser: fx.adminA })
    const theirs = captureForDealer(fx, dealer)
    sql(`UPDATE "DealerUser" SET "active" = false WHERE "id" = ${lit(user)}`)
    refused({ dealerId: dealer, dealerUserId: user, ...theirs }, "A dealer deal is created by an active user of that dealer")
    const second = insertDealerUser(fx.tenantId, dealer, { byUser: fx.adminA })
    sql(`UPDATE "Dealer" SET "active" = false, "deactivatedAt" = CURRENT_TIMESTAMP, "deactivatedById" = ${lit(fx.adminA)} WHERE "id" = ${lit(dealer)}`)
    refused({ dealerId: dealer, dealerUserId: second, ...theirs }, "A dealer deal names an active dealer of the lender")
  })

  it("refuses a dealer deal while the portal is off", () => {
    config(`"featureDealerPortal" = false`)
    try {
      refused({ dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...mine }, "The dealer portal is off for this lender")
    } finally {
      config(`"featureDealerPortal" = true`)
    }
  })

  it("refuses commission snapshot or submission values at insert", () => {
    const { insert } = dealerDealInsert(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...captureForDealer(fx, fx.dealerA) })
    expectRejected(insert.replace(`"dealerUserId", "updatedAt")`, `"dealerUserId", "dealerSubmittedAt", "updatedAt")`)
      .replace(/CURRENT_TIMESTAMP\)$/, "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"), "A dealer deal is created unsubmitted and without a commission snapshot")
    expectRejected(insert.replace(`"dealerUserId", "updatedAt")`, `"dealerUserId", "dealerCommissionSource", "dealerCommissionBps", "dealerCommissionFlatCents", "dealerCommissionBaseCents", "dealerCommissionSnapshotAt", "updatedAt")`)
      .replace(/CURRENT_TIMESTAMP\)$/, "'NONE', 0, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"), "A dealer deal is created unsubmitted and without a commission snapshot")
  })

  it("keeps a staff deal free of dealer columns", () => {
    const staff = captureForDealer(fx, null)
    const { dealId } = dealerDeal(fx, { dealerId: null, dealerUserId: null, ...staff })
    expectRejected(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(dealId)}`, "AssetFinanceDeal_dealer_pair")
  })

  describe("after insert", () => {
    let dealId: string
    beforeAll(() => {
      dealId = dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.adminUserA, ...captureForDealer(fx, fx.dealerA) }).dealId
    })

    it("fixes the dealer and its user", () => {
      expectRejected(`UPDATE "AssetFinanceDeal" SET "dealerId" = ${lit(fx.dealerB)}, "dealerUserId" = ${lit(fx.userB)}, "createdById" = ${lit(fx.userB)}
        WHERE "id" = ${lit(dealId)}`, "A deal's dealer is fixed when it is created")
      expectRejected(`UPDATE "AssetFinanceDeal" SET "dealerUserId" = ${lit(fx.salesUserA)}, "createdById" = ${lit(fx.salesUserA)} WHERE "id" = ${lit(dealId)}`,
        "A deal's dealer is fixed when it is created")
    })

    it("sets dealerSubmittedAt once, only while DRAFT", () => {
      const submit = `UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(dealId)}`
      sql(submit)
      expectRejected(submit, "A dealer submits a deal once, while it is DRAFT")
      expectRejected(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = NULL WHERE "id" = ${lit(dealId)}`, "A dealer submits a deal once, while it is DRAFT")
      const late = dealerDeal(fx, { dealerId: fx.dealerA, dealerUserId: fx.adminUserA, ...captureForDealer(fx, fx.dealerA) }).dealId
      sql(submitSql(late))
      expectRejected(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(late)}`,
        "A dealer submits a deal once, while it is DRAFT")
    })
  })
})
