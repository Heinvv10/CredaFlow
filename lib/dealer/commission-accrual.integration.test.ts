/**
 * Real-Postgres proof of dealer commission from approval to booking
 * (migration 20261019120100_dealer_portal): the snapshot the database takes
 * on the move into APPROVED (rate in force that day, base = the goods
 * advance: cash price incl. VAT less deposit and trade-in) and keeps however the rate table changes later; a caller cannot
 * supply or change it; the EARNED line accrueDealerCommission writes when the
 * deal is BOOKED (half-up rounding, VAT only for a VAT vendor, the tenant's
 * clawback months copied); none for a cancelled deal or a zero rate; and the
 * lines are immutable (guardDealerCommissionLine).
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/commission-accrual.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, insertRate, lit, newId, TODAY_SQL, type DealerFixture } from "./dealer.integration-fixture"
import {
  approve, approveSql, book, bookedDealerDeal, captureForDealer, commissionLines, dealerDeal, DEALER_DEAL_BASE_CENTS, submitSql,
} from "./dealer-booking.integration-fixture"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let rateA: string

const SNAPSHOT = `"dealerCommissionSource", "dealerCommissionRateId", "dealerCommissionBps", "dealerCommissionFlatCents", "dealerCommissionBaseCents"`
const snapshot = (dealId: string) => sql(`SELECT ${SNAPSHOT}, "dealerCommissionSnapshotAt" IS NOT NULL FROM "AssetFinanceDeal" WHERE "id" = ${lit(dealId)}`)
const newDeal = (dealerId: string, dealerUserId: string) => dealerDeal(fx, { dealerId, dealerUserId, ...captureForDealer(fx, dealerId) }).dealId

suite.sequential("dealer commission: snapshot at approval, accrual at booking (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t, { clawbackMonths: 12 })
    insertRate(fx, { dealerId: null, from: "'2020-01-01'", bps: 100, flatCents: 0 })
    rateA = insertRate(fx, { dealerId: fx.dealerA, from: "'2020-01-01'", bps: 250, flatCents: 150_000 })
    // not yet in force: never the snapshot
    insertRate(fx, { dealerId: fx.dealerA, from: `${TODAY_SQL} + 30`, bps: 900, flatCents: 0 })
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  describe("snapshot at approval", () => {
    it("takes the dealer's rate in force today and the goods advance (price less deposit and trade-in, not the financed fees)", () => {
      const dealId = newDeal(fx.dealerA, fx.salesUserA)
      sql(submitSql(dealId))
      expect(snapshot(dealId)).toBe("|||||f")
      sql(approveSql(fx, dealId))
      expect(snapshot(dealId)).toBe(`DEALER|${rateA}|250|150000|${DEALER_DEAL_BASE_CENTS}|t`)
    })

    it("keeps the snapshot when the rate table changes after approval (history)", () => {
      const dealId = newDeal(fx.dealerA, fx.salesUserA)
      approve(fx, dealId)
      const backdated = insertRate(fx, { dealerId: fx.dealerA, from: `${TODAY_SQL} - 1`, bps: 500, flatCents: 0 })
      expect(snapshot(dealId)).toBe(`DEALER|${rateA}|250|150000|${DEALER_DEAL_BASE_CENTS}|t`)
      const later = newDeal(fx.dealerA, fx.salesUserA)
      approve(fx, later)
      expect(snapshot(later)).toBe(`DEALER|${backdated}|500|0|${DEALER_DEAL_BASE_CENTS}|t`)
    })

    it("falls back to the tenant default for a dealer without its own rate", () => {
      const dealId = newDeal(fx.dealerB, fx.userB)
      approve(fx, dealId)
      expect(snapshot(dealId)).toMatch(/^TENANT_DEFAULT\|[^|]+\|100\|0\|150000020\|t$/)
    })

    it("refuses a caller-supplied snapshot on the move into APPROVED", () => {
      const dealId = newDeal(fx.dealerA, fx.salesUserA)
      sql(submitSql(dealId))
      expectRejected(approveSql(fx, dealId, `, "dealerCommissionBps" = 1000`), "The commission snapshot is the database's")
      expectRejected(approveSql(fx, dealId, `, "dealerCommissionSource" = 'NONE', "dealerCommissionBps" = 0, "dealerCommissionFlatCents" = 0,
        "dealerCommissionBaseCents" = 1, "dealerCommissionSnapshotAt" = CURRENT_TIMESTAMP`), "The commission snapshot is the database's")
      expect(snapshot(dealId)).toBe("|||||f")
    })

    it("refuses any later change to the snapshot", () => {
      const dealId = newDeal(fx.dealerA, fx.salesUserA)
      approve(fx, dealId)
      expectRejected(`UPDATE "AssetFinanceDeal" SET "dealerCommissionBps" = 1000 WHERE "id" = ${lit(dealId)}`, "The commission snapshot is the database's")
      expectRejected(`UPDATE "AssetFinanceDeal" SET "dealerCommissionBaseCents" = 1 WHERE "id" = ${lit(dealId)}`, "The commission snapshot is the database's")
    })

    it("takes no snapshot for a staff deal", () => {
      const staff = captureForDealer(fx, null)
      const { dealId } = dealerDeal(fx, { dealerId: null, dealerUserId: null, ...staff })
      approve(fx, dealId)
      expect(snapshot(dealId)).toBe("|||||f")
    })
  })

  describe("accrual at booking", () => {
    let vendorDeal: { dealId: string; loanId: string }

    beforeAll(() => {
      // dealer A's current rate is the backdated 500 bps row: book on a fresh dealer row set
      insertRate(fx, { dealerId: fx.dealerA, from: TODAY_SQL, bps: 250, flatCents: 150_000 })
      vendorDeal = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA)
    })

    it("writes one EARNED line on the move into BOOKED: half-up net, VAT for a vendor", () => {
      // 150 000 020 × 250 / 10 000 = 3 750 000.5 → 3 750 001, + R1 500 flat; VAT 15 % of 3 900 001 = 585 000.15 → 585 000
      expect(commissionLines(vendorDeal.dealId, `"kind", "dealerId", "loanId", "baseCents", "bps", "flatCents", "netCents", "vatRate", "vatCents",
        "grossCents", "dealerVatVendor", "clawbackMonths", "reversesLineId", "reason", "effectiveOn" = ${TODAY_SQL}`))
        .toEqual([`EARNED|${fx.dealerA}|${vendorDeal.loanId}|150000020|250|150000|3900001|0.1500|585000|4485001|t|12|||t`])
    })

    it("charges no VAT for a dealer that is not a VAT vendor", () => {
      const { dealId } = bookedDealerDeal(fx, fx.dealerB, fx.userB)
      // tenant default 100 bps: 150 000 020 × 100 / 10 000 = 1 500 000.2 → 1 500 000
      expect(commissionLines(dealId)).toEqual(["EARNED|1500000|0|1500000|"])
    })

    it("writes nothing for a cancelled deal", () => {
      const dealId = newDeal(fx.dealerA, fx.salesUserA)
      approve(fx, dealId)
      sql(`UPDATE "AssetFinanceDeal" SET "status" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP, "cancelledById" = ${lit(fx.adminA)},
        "cancelReason" = 'Synthetic: the buyer walked away' WHERE "id" = ${lit(dealId)}`)
      expect(commissionLines(dealId)).toEqual([])
    })

    it("writes nothing when the rate in force is zero", () => {
      const zero = insertRate(fx, { dealerId: fx.dealerB, from: TODAY_SQL, bps: 0, flatCents: 0 })
      const { dealId } = bookedDealerDeal(fx, fx.dealerB, fx.userB)
      expect(snapshot(dealId)).toBe(`DEALER|${zero}|0|0|${DEALER_DEAL_BASE_CENTS}|t`)
      expect(commissionLines(dealId)).toEqual([])
    })

    it("refuses a hand-written EARNED line on a deal that is not booked, or with forged amounts", () => {
      const approved = newDeal(fx.dealerA, fx.salesUserA)
      approve(fx, approved)
      const earned = (dealId: string, loanId: string, net: number) =>
        `INSERT INTO "DealerCommissionLine" ("id", "tenantId", "dealerId", "dealId", "loanId", "kind", "effectiveOn", "baseCents", "bps", "flatCents",
           "netCents", "vatRate", "vatCents", "grossCents", "dealerVatVendor", "clawbackMonths")
         VALUES ('${newId("dcl")}', ${lit(fx.tenantId)}, ${lit(fx.dealerA)}, ${lit(dealId)}, ${lit(loanId)}, 'EARNED', ${TODAY_SQL}, 150000020, 250,
           150000, ${net}, 0.15, 0, ${net}, false, 12)`
      expectRejected(earned(approved, vendorDeal.loanId, 3_900_001), "An EARNED commission line is written for a booked deal of that dealer and loan")
      expectRejected(earned(vendorDeal.dealId, vendorDeal.loanId, 9_999_999), "A commission line's amounts are the snapshot's")
    })

    it("refuses UPDATE, DELETE and TRUNCATE of a line", () => {
      const line = lit(sql(`SELECT "id" FROM "DealerCommissionLine" WHERE "dealId" = ${lit(vendorDeal.dealId)}`))
      expectRejected(`UPDATE "DealerCommissionLine" SET "netCents" = 1, "grossCents" = 1, "vatCents" = 0 WHERE "id" = ${line}`, "A commission line is immutable")
      expectRejected(`DELETE FROM "DealerCommissionLine" WHERE "id" = ${line}`, "A commission line is immutable")
      expectRejected(`BEGIN; TRUNCATE "DealerCommissionLine" CASCADE; ROLLBACK;`, "A commission line is immutable")
    })

    it("does not accrue twice when a booked deal is touched again", () => {
      sql(`UPDATE "AssetFinanceDeal" SET "status" = 'BOOKED' WHERE "id" = ${lit(vendorDeal.dealId)}`)
      expect(commissionLines(vendorDeal.dealId)).toHaveLength(1)
    })

    it("books a staff deal with no commission", () => {
      const staff = captureForDealer(fx, null)
      const { dealId } = dealerDeal(fx, { dealerId: null, dealerUserId: null, ...staff })
      approve(fx, dealId)
      book(fx, dealId)
      expect(commissionLines(dealId)).toEqual([])
    })
  })
})
