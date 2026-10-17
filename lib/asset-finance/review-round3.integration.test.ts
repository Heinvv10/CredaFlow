/**
 * Real-Postgres proof of the review round-3 deal rules (migration
 * 20261013114500_asset_finance_review_round3), the breaker's repros:
 *  - the planned start date is from today (SAST) to 90 days ahead, refused by
 *    the prepare route (422, audited) and by the database;
 *  - booking after the planned start is refused (409 start_passed, audited);
 *  - an APPROVED or CONTRACTED deal's parties, asset, supplier, money,
 *    structure and rate are fixed (the deal-row asset swap);
 *  - an entity's agreement identity is fixed once documents are prepared;
 *  - a deal never names a released asset.
 * Deals A and B are CONTRACTED (./payout-booking.integration-fixture.ts);
 * deal C is APPROVED here. Database probes run in rolled-back transactions
 * (./review-gates.integration-fixture.ts refusedSql / acceptedSql).
 *
 *   RUN_ASSET_FINANCE_REVIEW_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/review-round3.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type PayoutChecklistItemKind } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { fromDayNumber, isoOfDbDate, toDayNumber } from "./dates"
import { dealFixtureTenantId } from "./deal.integration-fixture"
import { signingRoutes } from "./deal-signing.integration-fixture"
import {
  approveDeal, bookingRoutes, cleanupBookingFixture, createBookingFixture, dealDocument, type BookingFixture, type SessionUser,
} from "./payout-booking.integration-fixture"
import { acceptedSql, refusedSql, unsignAll } from "./review-gates.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_REVIEW_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: BookingFixture
let dealC = ""
let otherSupplier = ""

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_REVIEW_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const staff = (id: string, role: string) => setSession({ id, email: `${id}@round3-it.test`, role, tenantId: fx.tenantId })
const today = () => sastCalendarDate(new Date())
const plusDays = (n: number) => fromDayNumber(toDayNumber(today()) + n)
const deal = (id: string, set: string) => `UPDATE "AssetFinanceDeal" SET ${set} WHERE "id" = '${id}'`
const SAST_TODAY = `(now() AT TIME ZONE 'Africa/Johannesburg')::date`
const FROZEN = "An approved deal's parties, asset, supplier, money, structure and rate are what was approved: they are fixed"
const RELEASED = "The asset has been released and cannot be financed again"
const EVIDENCE: Partial<Record<PayoutChecklistItemKind, Parameters<typeof dealDocument>[3]>> = {
  SUPPLIER_INVOICE_MATCHES_ASSET: "SUPPLIER_INVOICE", SUPPLIER_BANK_VERIFIED: "BANK_STATEMENT", INSURANCE_NOTES_LENDER: "INSURANCE_NOTING",
  TRACKER_CONFIRMED: "TRACKER_CERTIFICATE", DELIVERY_AND_ACCEPTANCE: "DELIVERY_ACCEPTANCE", NATIS_TITLEHOLDER: "NATIS_DOCUMENT",
}
const refusals = (dealId: string, action: string, reason: string) =>
  database().auditLog.count({ where: { entityId: dealId, action, newValue: { path: ["reason"], equals: reason } } })

suite.sequential("review round 3: planned start, frozen deal terms, released assets (real Postgres, real routes)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    fx = await createBookingFixture(database(), t, setSession)
    // One approver (segregation of duties off): a payout is created APPROVED.
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { assetPayoutDualApprovalCents: 500_000_000, requireSegregationOfDuties: false } })
    otherSupplier = (await database().supplier.create({ data: { tenantId: fx.tenantId, name: "TEST Other Plant (Pty) Ltd" } })).id
    await database().financedAsset.update({
      where: { id: fx.assets[2] }, data: { trackerId: "TRK-R3C", trackerProvider: "TEST Tracking", lenderNotedConfirmed: true },
    })
    dealC = await approveDeal(fx, fx.assets[2], staff, database())
  }, 240_000)

  afterAll(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    if (!db) return
    await cleanupBookingFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  describe("the planned start date: today (SAST) to 90 days ahead", () => {
    it("the prepare route refuses a backdated start and one beyond 90 days (422 invalid_start, audited); nothing is fixed", async () => {
      staff(fx.officer, "CREDIT_OFFICER")
      for (const [start, error] of [
        ["2020-02-01", /may not be in the past/], [plusDays(-1), /may not be in the past/], [plusDays(91), /at most 90 days ahead/],
      ] as const) {
        const response = await signingRoutes(fx.host).prepare(dealC, { plannedStartDate: start })
        expect(response.status).toBe(422)
        expect((await response.json()).error).toMatch(error)
      }
      expect(await refusals(dealC, "ASSET_DEAL_SIGNING_REFUSED", "invalid_start")).toBe(3)
      const c = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealC } })
      expect(c.plannedStartDate).toBeNull()
      expect(await database().dealSigner.count({ where: { dealId: dealC } })).toBe(0)
    })

    it("the database refuses a start before today or beyond 90 days when it is set or changed", () => {
      // Deal A reopened for preparation: APPROVED, nothing signed.
      const reopened = `${deal(fx.dealId, `"status" = 'APPROVED'`)}; ${unsignAll(fx.dealId)}`
      const message = "A deal's planned start date must be from today"
      expect(refusedSql(reopened, deal(fx.dealId, `"plannedStartDate" = ${SAST_TODAY} - 1`))).toContain(message)
      expect(refusedSql(reopened, deal(fx.dealId, `"plannedStartDate" = DATE '2020-02-01'`))).toContain(message)
      expect(refusedSql(`${reopened}; ${deal(fx.dealId, `"firstDueDate" = ${SAST_TODAY} + 120`)}`,
        deal(fx.dealId, `"plannedStartDate" = ${SAST_TODAY} + 91`))).toContain(message)
      acceptedSql(reopened, deal(fx.dealId, `"plannedStartDate" = ${SAST_TODAY} + 1`))
      acceptedSql(`${reopened}; ${deal(fx.dealId, `"firstDueDate" = ${SAST_TODAY} + 120`)}`, deal(fx.dealId, `"plannedStartDate" = ${SAST_TODAY} + 90`))
    })

    it("booking after the planned start is refused (409 start_passed, audited), nothing written; on the start day it books", async () => {
      const b = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealB }, include: { asset: true } })
      for (const row of await database().payoutChecklistItem.findMany({ where: { dealId: fx.dealB, required: true } })) {
        const type = EVIDENCE[row.item]
        const evidenceDocumentId = type ? await dealDocument(database(), fx, fx.dealB, type) : null
        staff(fx.officer, "CREDIT_OFFICER")
        const confirmed = await bookingRoutes(fx.host).confirm(fx.dealB, row.item, { evidenceDocumentId, attestedSerial: b.asset.serialNumber, note: null })
        expect(confirmed.status).toBe(200)
      }
      staff(fx.adminA, "LOAN_ADMIN")
      expect((await bookingRoutes(fx.host).createPayout(fx.dealB)).status).toBe(201)

      if (!b.plannedStartDate) throw new Error("fixture deal was not prepared")
      const start = new Date(`${isoOfDbDate(b.plannedStartDate)}T12:00:00.000Z`)
      // The route books as of the supplied SAST day: one day after the signed start is too late.
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date(start.getTime() + 86_400_000))
      const late = await bookingRoutes(fx.host).book(fx.dealB)
      expect(late.status).toBe(409)
      expect((await late.json()).error).toMatch(/has passed .*cancel the deal and do it again/)
      expect(await refusals(fx.dealB, "ASSET_PAYOUT_REFUSED", "start_passed")).toBe(1)
      expect(await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealB } })).toMatchObject({ status: "CONTRACTED", loanId: null })
      expect(await database().loan.count({ where: { applicationId: b.applicationId } })).toBe(0)

      vi.setSystemTime(start)
      const onTime = await bookingRoutes(fx.host).book(fx.dealB)
      expect(onTime.status).toBe(201)
      vi.useRealTimers()
    })
  })

  describe("an approved deal's terms are fixed (the breaker's deal-row swaps)", () => {
    // `otherAsset`: an asset that is not the deal's own.
    const changes = (otherAsset: string): Array<[string, string]> => [
      ["assetId", `'${otherAsset}'`], ["supplierId", `'${otherSupplier}'`], ["entityId", `'${fx.unevidenced}'`],
      ["applicationId", `'app_other_${t}'`], ["contractType", `'FINANCE_LEASE'`], ["depositCents", `"depositCents" + 1`],
      ["tradeInCents", `"tradeInCents" + 1`], ["financedFeesCents", `"financedFeesCents" + 1`], ["balloonCents", `"balloonCents" + 1`],
      ["weights", `'[1]'::jsonb`], ["structurePreset", `'OTHER'`], ["firstDueDate", `"firstDueDate" + 1`],
      ["vatDeferralPeriodIndex", "0"], ["rateBasis", `'FIXED'`], ["rateMargin", `"rateMargin" + 0.01`], ["fixedRate", "0.10"],
    ]

    // The columns whose change is NOT refused as frozen (all of them are listed when the trigger is gone).
    const notFrozen = (dealId: string, otherAsset: string) => changes(otherAsset).filter(([column, value]) => {
      try {
        return !refusedSql("", deal(dealId, `"${column}" = ${value}`)).includes(FROZEN)
      } catch {
        return true
      }
    }).map(([column]) => column)

    it("CONTRACTED: every column of the approved terms is refused", () => {
      expect(notFrozen(fx.dealId, fx.assets[2])).toEqual([])
    })

    it("APPROVED: refused too; before approval (SUBMITTED) the same edits are allowed", () => {
      expect(notFrozen(dealC, fx.assets[1])).toEqual([])
      const submitted = deal(dealC, `"status" = 'SUBMITTED'`)
      acceptedSql(submitted, deal(dealC, `"depositCents" = "depositCents" + 1, "supplierId" = '${otherSupplier}', "firstDueDate" = "firstDueDate" + 1`))
      acceptedSql(submitted, deal(dealC, `"assetId" = '${fx.assets[1]}'`))
    })

    it("the committed swap onto another machine is refused, so the signed machine is the one booked", () => {
      const swap = `INSERT INTO "FinancedAsset" ("id", "tenantId", "assetClass", "make", "model", "year", "serialNumber",
        "cashPriceExclVatCents", "vatCents", "updatedAt")
        SELECT 'swap_${t}', "tenantId", "assetClass", 'TEST OtherMake', 'TEST Swapped', 2015, 'SWAP${t.toUpperCase()}',
          "cashPriceExclVatCents", "vatCents", now() FROM "FinancedAsset" WHERE "id" = '${fx.assets[0]}'`
      expect(refusedSql(swap, deal(fx.dealId, `"assetId" = 'swap_${t}'`))).toContain(FROZEN)
    })
  })

  describe("prepared or contracted documents fix the entity identity printed in the agreement", () => {
    const entityUpdate = (dealId: string, set: string) => `UPDATE "BusinessEntity" SET ${set}
      WHERE "id" = (SELECT "entityId" FROM "AssetFinanceDeal" WHERE "id" = '${dealId}')`
    const message = "The entity has prepared or contracted documents: its signed identity is fixed"
    const preparedApproved = () => `UPDATE "AssetFinanceDeal" SET "entityId" = '${fx.unevidenced}'
      WHERE "entityId" = (SELECT "entityId" FROM "AssetFinanceDeal" WHERE "id" = '${fx.dealId}') AND "id" <> '${fx.dealId}';
      ${deal(fx.dealId, `"status" = 'APPROVED'`)}`

    it("refuses every signed identity field for prepared APPROVED and CONTRACTED deals", () => {
      const changes = [
        `"type" = 'CC'`, `"legalName" = 'TEST Changed Entity'`, `"tradingName" = 'TEST Changed Trading'`,
        `"registrationNumber" = '2099/999999/23'`, `"mastersReference" = 'IT9999/2099'`, `"vatNumber" = '4999999999'`,
        `"addressLine1" = '99 Changed Road'`, `"addressLine2" = 'Changed Park'`, `"city" = 'Changed City'`,
        `"province" = 'Changed Province'`, `"postalCode" = '9999'`,
      ]
      for (const change of changes) {
        expect(refusedSql(preparedApproved(), entityUpdate(fx.dealId, change))).toContain(message)
        expect(refusedSql("", entityUpdate(fx.dealId, change))).toContain(message)
      }
    })

    it("still allows classifier financials and identity completion before document preparation", () => {
      acceptedSql("", entityUpdate(dealC, `"annualTurnover" = COALESCE("annualTurnover", 0) + 1`))
      acceptedSql("", `UPDATE "BusinessEntity" SET "legalName" = 'TEST Unprepared Changed' WHERE "id" = '${fx.unevidenced}'`)
    })
  })

  describe("a deal never names a released asset", () => {
    const release = () => `UPDATE "FinancedAsset" SET "releasedAt" = now() WHERE "id" = '${fx.assets[1]}'`

    it("moving a deal onto a released asset is refused; onto an unreleased one it is not", () => {
      const submitted = deal(dealC, `"status" = 'SUBMITTED'`)
      expect(refusedSql(`${submitted}; ${release()}`, deal(dealC, `"assetId" = '${fx.assets[1]}'`))).toContain(RELEASED)
      acceptedSql(submitted, deal(dealC, `"assetId" = '${fx.assets[1]}'`))
    })

    it("a deal created on a released asset is refused", () => {
      const insert = `INSERT INTO "AssetFinanceDeal" ("id", "tenantId", "applicationId", "entityId", "assetId", "supplierId", "weights",
        "structurePreset", "firstDueDate", "rateBasis", "rateMargin", "status", "createdById", "updatedAt")
        SELECT 'rel_${t}', "tenantId", 'app_rel_${t}', "entityId", '${fx.assets[1]}', "supplierId", "weights", "structurePreset",
          "firstDueDate", "rateBasis", "rateMargin", 'DRAFT', "createdById", now() FROM "AssetFinanceDeal" WHERE "id" = '${dealC}'`
      expect(refusedSql(release(), insert)).toContain(RELEASED)
    })
  })
})
