/**
 * Real-Postgres proof of the dealer, dealer-user and commission-rate rules
 * (migration 20261019120100_dealer_portal): VAT vendor shape; tenant and
 * creator fixed, never deleted (guardDealer, guardDealerUser); exactly one
 * creator, a dealer-user creator of the same dealer; tokenVersion only rises;
 * rate bounds, one row per date, history never edited and only future rows
 * withdrawn (guardDealerCommissionRate); and dealerCommissionRateAt's
 * fallback dealer → tenant default → NONE.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-rows.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import {
  cleanupDealerFixtureIfCreated, createDealerFixture, insertDealer, insertDealerUser, insertRate, lit, newId, TODAY_SQL, type DealerFixture,
} from "./dealer.integration-fixture"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture

const rateAt = (dealerId: string, on: string) =>
  sql(`SELECT "rateId", "source", "bps", "flatCents" FROM "dealerCommissionRateAt"(${lit(fx.tenantId)}, ${lit(dealerId)}, ${on})`)

suite.sequential("dealer rows and commission rates (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  describe("Dealer", () => {
    it("is a VAT vendor exactly when it has a VAT number", () => {
      expectRejected(`INSERT INTO "Dealer" ("id", "tenantId", "name", "kind", "vatVendor", "contactEmail", "createdById", "updatedAt")
        VALUES ('${newId("dlr")}', ${lit(fx.tenantId)}, 'TEST Shape', 'BROKER', true, 'x@dealer.invalid', ${lit(fx.adminA)}, CURRENT_TIMESTAMP)`,
        "Dealer_vat_vendor_shape")
      expectRejected(`UPDATE "Dealer" SET "vatNumber" = NULL WHERE "id" = ${lit(fx.dealerA)}`, "Dealer_vat_vendor_shape")
    })

    it("keeps its tenant and creator, and is never deleted", () => {
      expectRejected(`UPDATE "Dealer" SET "createdById" = ${lit(fx.adminB)} WHERE "id" = ${lit(fx.dealerA)}`, "A dealer's tenant and creator are fixed")
      expectRejected(`DELETE FROM "Dealer" WHERE "id" = ${lit(fx.dealerB)}`, "A dealer is never deleted")
      expectRejected(`BEGIN; TRUNCATE "Dealer" CASCADE; ROLLBACK;`, "A dealer is never deleted")
      sql(`UPDATE "Dealer" SET "contactPhone" = '+27110000009' WHERE "id" = ${lit(fx.dealerB)}`)
    })
  })

  describe("DealerUser", () => {
    it("has exactly one creator", () => {
      const insert = (byUser: string | null, byDealerUser: string | null) =>
        `INSERT INTO "DealerUser" ("id", "tenantId", "dealerId", "email", "name", "role", "createdByUserId", "createdByDealerUserId", "updatedAt")
         VALUES ('${newId("dlu")}', ${lit(fx.tenantId)}, ${lit(fx.dealerA)}, '${newId("e")}@dealer.invalid', 'TEST', 'DEALER_SALES',
         ${lit(byUser)}, ${lit(byDealerUser)}, CURRENT_TIMESTAMP)`
      expectRejected(insert(null, null), "DealerUser_creator_xor")
      expectRejected(insert(fx.adminA, fx.adminUserA), "DealerUser_creator_xor")
    })

    it("is created by a user of the same dealer when a dealer user creates it", () => {
      expectRejected(
        `INSERT INTO "DealerUser" ("id", "tenantId", "dealerId", "email", "name", "role", "createdByDealerUserId", "updatedAt")
         VALUES ('${newId("dlu")}', ${lit(fx.tenantId)}, ${lit(fx.dealerB)}, '${newId("e")}@dealer.invalid', 'TEST', 'DEALER_SALES',
         ${lit(fx.adminUserA)}, CURRENT_TIMESTAMP)`,
        "A dealer user creates users of its own dealer only")
    })

    it("keeps its dealer and creator, is never deleted, and its tokenVersion only rises", () => {
      const user = lit(fx.salesUserA)
      expectRejected(`UPDATE "DealerUser" SET "dealerId" = ${lit(fx.dealerB)} WHERE "id" = ${user}`, "A dealer user's tenant, dealer and creator are fixed")
      expectRejected(`UPDATE "DealerUser" SET "createdByDealerUserId" = NULL, "createdByUserId" = ${lit(fx.adminA)} WHERE "id" = ${user}`,
        "A dealer user's tenant, dealer and creator are fixed")
      sql(`UPDATE "DealerUser" SET "tokenVersion" = "tokenVersion" + 1, "active" = false WHERE "id" = ${user}`)
      expectRejected(`UPDATE "DealerUser" SET "tokenVersion" = 0 WHERE "id" = ${user}`, "A dealer user's tokenVersion only increases")
      expectRejected(`DELETE FROM "DealerUser" WHERE "id" = ${user}`, "A dealer user is never deleted")
      expectRejected(`BEGIN; TRUNCATE "DealerUser" CASCADE; ROLLBACK;`, "A dealer user is never deleted")
    })
  })

  describe("DealerCommissionRate", () => {
    it("keeps bps within 0..1000 and the flat amount within 0..R100k", () => {
      expect(() => insertRate(fx, { dealerId: fx.dealerA, from: "'2021-01-01'", bps: 1001, flatCents: 0 })).toThrow(/DealerCommissionRate_bounds/)
      expect(() => insertRate(fx, { dealerId: fx.dealerA, from: "'2021-01-01'", bps: 0, flatCents: 10_000_001 })).toThrow(/DealerCommissionRate_bounds/)
      expect(() => insertRate(fx, { dealerId: fx.dealerA, from: "'2021-01-01'", bps: -1, flatCents: 0 })).toThrow(/DealerCommissionRate_bounds/)
    })

    it("has one row per dealer and date, and one tenant default per date", () => {
      insertRate(fx, { dealerId: fx.dealerA, from: "'2020-01-01'", bps: 250, flatCents: 150_000 })
      expect(() => insertRate(fx, { dealerId: fx.dealerA, from: "'2020-01-01'", bps: 300, flatCents: 0 })).toThrow(/unique/i)
      insertRate(fx, { dealerId: null, from: "'2020-01-01'", bps: 100, flatCents: 0 })
      expect(() => insertRate(fx, { dealerId: null, from: "'2020-01-01'", bps: 120, flatCents: 0 })).toThrow(/DealerCommissionRate_one_default_per_date/)
    })

    it("resolves the dealer's row, else the tenant default, else NONE", () => {
      const dealerRow = sql(`SELECT "id" FROM "DealerCommissionRate" WHERE "dealerId" = ${lit(fx.dealerA)} AND "effectiveFrom" = '2020-01-01'`)
      const defaultRow = sql(`SELECT "id" FROM "DealerCommissionRate" WHERE "tenantId" = ${lit(fx.tenantId)} AND "dealerId" IS NULL`)
      expect(rateAt(fx.dealerA, TODAY_SQL)).toBe(`${dealerRow}|DEALER|250|150000`)
      expect(rateAt(fx.dealerB, TODAY_SQL)).toBe(`${defaultRow}|TENANT_DEFAULT|100|0`)
      expect(rateAt(fx.dealerA, "'2019-12-31'")).toBe("|NONE|0|0")
      // a later dealer row takes over from its date; the earlier one still answers before it
      const later = insertRate(fx, { dealerId: fx.dealerA, from: "'2025-06-01'", bps: 400, flatCents: 0 })
      expect(rateAt(fx.dealerA, TODAY_SQL)).toBe(`${later}|DEALER|400|0`)
      expect(rateAt(fx.dealerA, "'2025-05-31'")).toBe(`${dealerRow}|DEALER|250|150000`)
    })

    it("never edits a row, and withdraws only one not yet in force", () => {
      const past = insertRate(fx, { dealerId: fx.dealerB, from: `${TODAY_SQL}`, bps: 50, flatCents: 0 })
      const future = insertRate(fx, { dealerId: fx.dealerB, from: `${TODAY_SQL} + 30`, bps: 60, flatCents: 0 })
      expectRejected(`UPDATE "DealerCommissionRate" SET "bps" = 70 WHERE "id" = ${lit(future)}`, "A commission rate is never edited")
      expectRejected(`DELETE FROM "DealerCommissionRate" WHERE "id" = ${lit(past)}`, "Only a commission rate not yet in force may be withdrawn")
      sql(`DELETE FROM "DealerCommissionRate" WHERE "id" = ${lit(future)}`)
      expect(sql(`SELECT count(*) FROM "DealerCommissionRate" WHERE "id" = ${lit(future)}`)).toBe("0")
      expectRejected(`BEGIN; TRUNCATE "DealerCommissionRate" CASCADE; ROLLBACK;`, "A commission rate is never edited")
    })

    it("a dealer created without a rate falls back to the default", () => {
      const fresh = insertDealer(fx.tenantId, fx.adminA, { name: `TEST Fresh ${t}` })
      insertDealerUser(fx.tenantId, fresh, { byUser: fx.adminA })
      expect(rateAt(fresh, TODAY_SQL)).toMatch(/\|TENANT_DEFAULT\|100\|0$/)
    })
  })
})
