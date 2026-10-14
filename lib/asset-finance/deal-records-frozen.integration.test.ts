/**
 * Real-Postgres proof of three deal rules of migration
 * 20261013114500_asset_finance_review_round3:
 *  - a deal is BOOKED no later than its planned start date, SAST
 *    (guardAssetDealBookingStart; the app's start_passed);
 *  - from APPROVED on, the decision record (decision, reasons, decider, time,
 *    creator) and the base instalment are fixed; booking alone sets the base
 *    instalment, to the signed one (freezeApprovedAssetDealTerms);
 *  - a CANCELLED, DECLINED or REFUSED_NCA deal never changes, and the move to
 *    CANCELLED changes only the cancellation columns (freezeTerminalAssetDeal).
 * Deal A is CONTRACTED with an APPROVED payout, deal B BOOKED
 * (./review-gates.integration-fixture.ts). A past planned start cannot be
 * written with triggers on, so each probe builds its state with triggers off
 * and attempts the move with them on, in one rolled-back transaction.
 *
 *   RUN_ASSET_FINANCE_REVIEW_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/deal-records-frozen.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dealFixtureTenantId } from "./deal.integration-fixture"
import { cancelDeal } from "./deal-cancel"
import { cleanupBookingFixture, type SessionUser } from "./payout-booking.integration-fixture"
import { acceptedSql, createReviewGatesFixture, refusedSql, type ReviewGatesFixture } from "./review-gates.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_REVIEW_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: ReviewGatesFixture

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_REVIEW_IT=1 is required")
  return db
}
const deal = (id: string, set: string) => `UPDATE "AssetFinanceDeal" SET ${set} WHERE "id" = '${id}'`
const SAST_TODAY = `(now() AT TIME ZONE 'Africa/Johannesburg')::date`
const BOOKED_LATE = "A deal is booked no later than its planned start date"
const RECORD = "An approved deal's decision record and base instalment are fixed"
const TERMINAL = "A cancelled, declined or NCA-refused deal is terminal: it never changes"
const CANCEL_SHAPE = "Cancelling a deal records who cancelled it, when and why, and changes nothing else"
/** Another user of the deal's tenant than the one in `column`. */
const otherUser = (column: string) => `(SELECT u."id" FROM "User" u WHERE u."tenantId" = "AssetFinanceDeal"."tenantId"
  AND u."id" IS DISTINCT FROM "AssetFinanceDeal"."${column}" ORDER BY u."id" LIMIT 1)`

/** Of `changes` (column, new value), the columns whose change after `setup` is NOT refused with `message`. */
function notRefused(setup: string, dealId: string, changes: Array<[string, string]>, message: string): string[] {
  return changes.filter(([column, value]) => {
    try {
      return !refusedSql(setup, deal(dealId, `"${column}" = ${value}`)).includes(message)
    } catch {
      return true
    }
  }).map(([column]) => column)
}

const decisionRecord = (): Array<[string, string]> => [
  ["decision", `'REFER'`], ["decisionReasons", `array_append("decisionReasons", 'TEST another reason')`],
  ["decidedById", otherUser("decidedById")], ["decidedAt", `"decidedAt" + interval '1 minute'`],
  ["createdById", otherUser("createdById")], ["baseInstalmentCents", `"baseInstalmentCents" + 1`],
]

suite.sequential("deal records frozen in the database: booking by the start, the decision record, terminal deals (real Postgres)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    fx = await createReviewGatesFixture(database(), t, (user) => { session.current = user && { user } })
  }, 240_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    await cleanupBookingFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  describe("booking by the planned start (deal B unbooked: CONTRACTED, payout APPROVED, no loan)", () => {
    // The loan and its contract rate start on the same `start`, so every other booking gate passes.
    const unbook = (start: string, extra = "") => `UPDATE "Payout" SET "status" = 'APPROVED', "releasedAt" = NULL, "releasedById" = NULL
      WHERE "dealId" = '${fx.dealB}';
      UPDATE "Loan" SET "startDate" = ((${start})::timestamp AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'UTC' WHERE "id" = '${fx.loanB}';
      UPDATE "ContractRate" SET "effectiveDate" = ${start} WHERE "loanId" = '${fx.loanB}';
      ${deal(fx.dealB, `"status" = 'CONTRACTED', "loanId" = NULL, "plannedStartDate" = ${start}${extra}`)}`
    const book = (extra = "") => deal(fx.dealB, `"status" = 'BOOKED', "loanId" = '${fx.loanB}'${extra}`)

    it("refused once the SAST date of the write is after the planned start; on the start day and before it, booked", () => {
      expect(refusedSql(unbook(`${SAST_TODAY} - 1`), book())).toContain(BOOKED_LATE)
      expect(refusedSql(unbook(`DATE '2020-02-01'`), book())).toContain(BOOKED_LATE)
      acceptedSql(unbook(SAST_TODAY), book())
      acceptedSql(unbook(`${SAST_TODAY} + 1`), book())
    })

    it("booking sets the base instalment to the signed one, and to nothing else", () => {
      const approvedFigure = `, "baseInstalmentCents" = "signedBaseInstalmentCents" + 7`
      acceptedSql(unbook(SAST_TODAY, approvedFigure), book(`, "baseInstalmentCents" = "signedBaseInstalmentCents"`))
      expect(refusedSql(unbook(SAST_TODAY, approvedFigure), book(`, "baseInstalmentCents" = "signedBaseInstalmentCents" + 1`))).toContain(RECORD)
    })
  })

  describe("the decision record from APPROVED on", () => {
    it("CONTRACTED and APPROVED: every column of the decision record and the base instalment is refused", () => {
      expect(notRefused("", fx.dealId, decisionRecord(), RECORD)).toEqual([])
      expect(notRefused(deal(fx.dealId, `"status" = 'APPROVED'`), fx.dealId, decisionRecord(), RECORD)).toEqual([])
    })

    it("before approval (SUBMITTED) the same edits are allowed", () => {
      const set = decisionRecord().map(([column, value]) => `"${column}" = ${value}`).join(", ")
      acceptedSql(deal(fx.dealId, `"status" = 'SUBMITTED'`), deal(fx.dealId, set))
    })
  })

  describe("terminal deals", () => {
    const cancelMove = (extra = "") => deal(fx.dealId, `"status" = 'CANCELLED', "cancelledAt" = now(), "cancelledById" = '${fx.officer}',
      "cancelReason" = 'TEST the borrower walked away'${extra}`)
    // Deal A SUBMITTED with its payout cancelled: the cancel move's other gates pass.
    const submitted = () => `UPDATE "Payout" SET "status" = 'CANCELLED', "cancelledAt" = now(), "cancelledById" = '${fx.adminA}'
      WHERE "dealId" = '${fx.dealId}'; ${deal(fx.dealId, `"status" = 'SUBMITTED'`)}`
    const changes = (): Array<[string, string]> => [
      ...decisionRecord(), ["depositCents", `"depositCents" + 1`], ["assetId", `'${fx.assets[2]}'`],
      ["weights", `'[1]'::jsonb`], ["firstDueDate", `"firstDueDate" + 1`], ["fixedRate", "0.10"],
      ["cancelReason", `'TEST a different reason'`], ["cancelledAt", `now() - interval '1 day'`],
    ]

    it("the move to CANCELLED writes the cancellation and nothing else", () => {
      acceptedSql(submitted(), cancelMove())
      expect(refusedSql(submitted(), cancelMove(`, "depositCents" = "depositCents" + 1`))).toContain(CANCEL_SHAPE)
      expect(refusedSql(submitted(), cancelMove(`, "decisionReasons" = '{}'`))).toContain(CANCEL_SHAPE)
    })

    it("the cancel path cancels a CONTRACTED deal with an APPROVED payout", async () => {
      const result = await cancelDeal({ tenantId: fx.tenantId, userId: fx.officer }, fx.dealId, "TEST the supplier withdrew the machine")
      expect(result).toMatchObject({ kind: "cancelled", payoutCancelled: true })
      expect(await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId } })).toMatchObject({ status: "CANCELLED" })
    })

    it.each([
      ["CANCELLED", ""],
      ["DECLINED", `"status" = 'DECLINED', "cancelledAt" = NULL, "cancelledById" = NULL, "cancelReason" = NULL`],
      ["REFUSED_NCA", `"status" = 'REFUSED_NCA', "cancelledAt" = NULL, "cancelledById" = NULL, "cancelReason" = NULL`],
    ])("%s: every column change is refused; touching updatedAt alone is not", (_status, set) => {
      const setup = set ? deal(fx.dealId, set) : ""
      expect(notRefused(setup, fx.dealId, changes(), TERMINAL)).toEqual([])
      acceptedSql(setup, deal(fx.dealId, `"updatedAt" = now()`))
    })
  })
})
