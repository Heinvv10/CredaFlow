/**
 * Real-Postgres proof of a dealer cancelling its own draft (migration
 * 20261022100000_dealer_followups, SLICE5-FOLLOWUPS.md part D):
 * cancelDealerDraft through the dealer's 404 rule, and the database's own
 * line (guardAssetDealDealerCancel, AssetFinanceDeal_cancellation_shape):
 * only DRAFT → CANCELLED of a deal never handed to the lender, by its creator
 * or an admin of its dealer, naming one canceller.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-cancel.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, insertDealerUser, lit, type DealerFixture } from "./dealer.integration-fixture"
import { actorOf, dealerDraft, inTenant } from "./dealer-origination.integration-fixture"
import { captureForDealer, dealerDeal, dealerDealInsert, submitSql } from "./dealer-booking.integration-fixture"
import { cancelDealerDraft } from "./cancel"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const REASON = "The buyer chose another machine"
let fx: DealerFixture
let salesA2: string

const state = (dealId: string) => sql(`SELECT d."status", d."cancelledByDealerUserId", d."cancelledById" IS NULL, a."status", f."releasedAt" IS NOT NULL
  FROM "AssetFinanceDeal" d JOIN "LoanApplication" a ON a."id" = d."applicationId" JOIN "FinancedAsset" f ON f."id" = d."assetId"
  WHERE d."id" = ${lit(dealId)}`)
const cancelSql = (dealId: string, dealerUserId: string) =>
  `UPDATE "AssetFinanceDeal" SET "status" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP, "cancelledByDealerUserId" = ${lit(dealerUserId)},
     "cancelReason" = ${lit(REASON)} WHERE "id" = ${lit(dealId)}`
const salesDraft = () => dealerDraft(fx, actorOf(fx, fx.salesUserA, fx.dealerA))

suite.sequential("a dealer cancels its own draft (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
    salesA2 = insertDealerUser(fx.tenantId, fx.dealerA, { role: "DEALER_SALES", byDealerUser: fx.adminUserA })
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("is 404 for another dealer's draft and for a sales colleague's, and changes nothing", async () => {
    const { dealId } = await salesDraft()
    const before = state(dealId)
    expect(await inTenant(fx, () => cancelDealerDraft(actorOf(fx, fx.userB, fx.dealerB, "DEALER_ADMIN"), dealId, REASON)))
      .toEqual({ kind: "refused", status: 404, error: "Deal not found" })
    expect(await inTenant(fx, () => cancelDealerDraft(actorOf(fx, salesA2, fx.dealerA), dealId, REASON)))
      .toEqual({ kind: "refused", status: 404, error: "Deal not found" })
    expect(state(dealId)).toBe(before)
  })

  it("cancels the creator's own draft: the deal, its application, the asset released, audited as the dealer", async () => {
    const { dealId } = await salesDraft()
    expect(await inTenant(fx, () => cancelDealerDraft(actorOf(fx, fx.salesUserA, fx.dealerA), dealId, REASON))).toEqual({ kind: "cancelled" })
    expect(state(dealId)).toBe(`CANCELLED|${fx.salesUserA}|t|CANCELLED|t`)
    expect(sql(`SELECT "userId" IS NULL, "newValue"->'actor'->>'dealerUserId', "newValue"->>'reason' FROM "AuditLog"
      WHERE "action" = 'DEALER_DEAL_CANCELLED' AND "entityId" = ${lit(dealId)}`)).toBe(`t|${fx.salesUserA}|${REASON}`)
  })

  it("lets the dealer's admin cancel a sales user's draft", async () => {
    const { dealId } = await salesDraft()
    expect(await inTenant(fx, () => cancelDealerDraft(actorOf(fx, fx.adminUserA, fx.dealerA, "DEALER_ADMIN"), dealId, REASON))).toEqual({ kind: "cancelled" })
    expect(state(dealId)).toBe(`CANCELLED|${fx.adminUserA}|t|CANCELLED|t`)
  })

  it("refuses a deal handed to the lender, DRAFT or SUBMITTED, with 409", async () => {
    const handedOver = await salesDraft()
    sql(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(handedOver.dealId)}`)
    const submitted = await salesDraft()
    sql(submitSql(submitted.dealId))
    for (const { dealId } of [handedOver, submitted]) {
      expect(await inTenant(fx, () => cancelDealerDraft(actorOf(fx, fx.salesUserA, fx.dealerA), dealId, REASON)))
        .toMatchObject({ kind: "refused", status: 409 })
    }
    expect(sql(`SELECT string_agg("status"::text, ',' ORDER BY "status") FROM "AssetFinanceDeal"
      WHERE "id" IN (${lit(handedOver.dealId)}, ${lit(submitted.dealId)})`)).toBe("DRAFT,SUBMITTED")
  })

  describe("the database's own line", () => {
    const message = "A dealer cancels only its own draft, before handing it to the lender"

    it("refuses a dealer cancellation once handed over or past DRAFT", async () => {
      const handedOver = await salesDraft()
      sql(`UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(handedOver.dealId)}`)
      expectRejected(cancelSql(handedOver.dealId, fx.salesUserA), message)
      const submitted = await salesDraft()
      sql(submitSql(submitted.dealId))
      expectRejected(cancelSql(submitted.dealId, fx.salesUserA), message)
    })

    it("refuses another dealer's user, a sales colleague and an inactive creator", async () => {
      const { dealId } = await salesDraft()
      const who = "A dealer draft is cancelled by the user who created it or an admin of its dealer"
      expectRejected(cancelSql(dealId, fx.userB), who)
      expectRejected(cancelSql(dealId, salesA2), who)
      sql(`UPDATE "DealerUser" SET "active" = false, "tokenVersion" = "tokenVersion" + 1 WHERE "id" = ${lit(salesA2)}`)
      const colleagues = await dealerDraft(fx, actorOf(fx, fx.adminUserA, fx.dealerA, "DEALER_ADMIN"))
      expectRejected(cancelSql(colleagues.dealId, salesA2), who)
    })

    it("refuses an inactive creator or an inactive admin, through the library as a refusal", async () => {
      const creator = insertDealerUser(fx.tenantId, fx.dealerA, { role: "DEALER_SALES", byDealerUser: fx.adminUserA })
      const admin = insertDealerUser(fx.tenantId, fx.dealerA, { role: "DEALER_ADMIN", byDealerUser: fx.adminUserA })
      const { dealId } = await dealerDraft(fx, actorOf(fx, creator, fx.dealerA))
      for (const id of [creator, admin]) sql(`UPDATE "DealerUser" SET "active" = false, "tokenVersion" = "tokenVersion" + 1 WHERE "id" = ${lit(id)}`)
      expectRejected(cancelSql(dealId, creator), "A dealer draft is cancelled by the user who created it or an admin of its dealer")
      expectRejected(cancelSql(dealId, admin), "A dealer draft is cancelled by the user who created it or an admin of its dealer")
      expect(await inTenant(fx, () => cancelDealerDraft(actorOf(fx, creator, fx.dealerA), dealId, REASON)))
        .toEqual({ kind: "refused", status: 409, error: "The lender's system refused the cancellation" })
      expect(state(dealId)).toMatch(/^DRAFT\|/)
    })

    it("refuses a dealer canceller on a staff deal and on a new deal, and a reason under ten characters", async () => {
      const staffDeal = dealerDeal(fx, { dealerId: null, dealerUserId: null, ...captureForDealer(fx, null) })
      expectRejected(cancelSql(staffDeal.dealId, fx.adminUserA), message)
      const insert = dealerDealInsert(fx, { dealerId: fx.dealerA, dealerUserId: fx.salesUserA, ...captureForDealer(fx, fx.dealerA) }).insert
        .replace('"dealerUserId", "updatedAt")', '"dealerUserId", "cancelledByDealerUserId", "updatedAt")')
        .replace(/, CURRENT_TIMESTAMP\)$/, `, ${lit(fx.salesUserA)}, CURRENT_TIMESTAMP)`)
      expectRejected(insert, "A deal is created uncancelled")
      const { dealId } = await salesDraft()
      expectRejected(cancelSql(dealId, fx.salesUserA).replace(lit(REASON), "'Too short'"), "AssetFinanceDeal_cancellation_shape")
      expect(await inTenant(fx, () => cancelDealerDraft(actorOf(fx, fx.salesUserA, fx.dealerA), dealId, "😀😀😀😀😀")))
        .toMatchObject({ kind: "refused", status: 400 })
    })

    it("refuses a cancellation naming both a staff and a dealer canceller, or none", async () => {
      const { dealId } = await salesDraft()
      expectRejected(`UPDATE "AssetFinanceDeal" SET "status" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP, "cancelledById" = ${lit(fx.officer)},
        "cancelledByDealerUserId" = ${lit(fx.salesUserA)}, "cancelReason" = ${lit(REASON)} WHERE "id" = ${lit(dealId)}`,
      "AssetFinanceDeal_cancellation_shape")
      expectRejected(`UPDATE "AssetFinanceDeal" SET "status" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP, "cancelReason" = ${lit(REASON)}
        WHERE "id" = ${lit(dealId)}`, "AssetFinanceDeal_cancellation_shape")
    })

    it("keeps a dealer-cancelled deal terminal", async () => {
      // A fresh creator: a dealer user may capture 30 records in 15 minutes.
      const creator = insertDealerUser(fx.tenantId, fx.dealerA, { role: "DEALER_SALES", byDealerUser: fx.adminUserA })
      const { dealId } = await dealerDraft(fx, actorOf(fx, creator, fx.dealerA))
      sql(cancelSql(dealId, creator))
      expectRejected(`UPDATE "AssetFinanceDeal" SET "cancelledByDealerUserId" = ${lit(fx.adminUserA)} WHERE "id" = ${lit(dealId)}`, message)
      expectRejected(`UPDATE "AssetFinanceDeal" SET "cancelReason" = 'Another reason entirely' WHERE "id" = ${lit(dealId)}`,
        "A cancelled, declined or NCA-refused deal is terminal")
    })
  })
})
