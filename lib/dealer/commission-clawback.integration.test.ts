/**
 * Real-Postgres proof of the commission clawback (migration
 * 20261019120100_dealer_portal, clawbackDealerCommission and the REVERSED
 * branch of guardDealerCommissionLine): when the loan moves into COMPLETED,
 * WRITTEN_OFF or CANCELLED, a NEW negative REVERSED line (the EARNED line is
 * never touched) — always for CANCELLED; for WRITTEN_OFF, and for COMPLETED
 * before maturity, only inside the clawback window the EARNED line snapshotted;
 * never twice; never by hand outside those rules.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/commission-clawback.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, insertRate, lit, newId, TODAY_SQL, type DealerFixture } from "./dealer.integration-fixture"
import { bookedDealerDeal, commissionLines } from "./dealer-booking.integration-fixture"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture

// 150 000 020 × 250 bps + R1 500 = 3 900 001 net; VAT 585 000; gross 4 485 001 (dealer A is a VAT vendor)
const EARNED = "EARNED|3900001|585000|4485001|"
const reversed = (reason: string) => `REVERSED|-3900001|-585000|-4485001|${reason}`

const loanStatus = (loanId: string, status: string) => sql(`UPDATE "Loan" SET "status" = '${status}' WHERE "id" = ${lit(loanId)}`)
const earnedId = (dealId: string) => sql(`SELECT "id" FROM "DealerCommissionLine" WHERE "dealId" = ${lit(dealId)} AND "kind" = 'EARNED'`)
const setMonths = (months: number) => sql(`UPDATE "TenantConfig" SET "dealerCommissionClawbackMonths" = ${months} WHERE "tenantId" = ${lit(fx.tenantId)}`)

/** History: the EARNED line was written `months` months ago (triggers off for the one statement). */
function earnedMonthsAgo(dealId: string, months: number) {
  sql(`BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE "DealerCommissionLine" SET "effectiveOn" = ${TODAY_SQL} - INTERVAL '${months} months' WHERE "dealId" = ${lit(dealId)} AND "kind" = 'EARNED';
    COMMIT;`)
}

/** History: an approved disbursement reversal, which a loan needs to become CANCELLED (guardLoanCancellation). */
function reversalApproved(loanId: string) {
  sql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO "DisbursementReversal" ("id", "tenantId", "loanId", "status", "reason", "requestedById", "decidedById", "decidedAt")
    VALUES ('${newId("dr")}', ${lit(fx.tenantId)}, ${lit(loanId)}, 'APPROVED', 'Synthetic: payout returned', ${lit(fx.officer)}, ${lit(fx.adminB)}, CURRENT_TIMESTAMP);
    COMMIT;`)
}

function reversalInsert(dealId: string, loanId: string, reason: string, net = -3_900_001) {
  return `INSERT INTO "DealerCommissionLine" ("id", "tenantId", "dealerId", "dealId", "loanId", "kind", "reversesLineId", "reason", "effectiveOn",
      "baseCents", "bps", "flatCents", "netCents", "vatRate", "vatCents", "grossCents", "dealerVatVendor", "clawbackMonths")
    VALUES ('${newId("dcl")}', ${lit(fx.tenantId)}, ${lit(fx.dealerA)}, ${lit(dealId)}, ${lit(loanId)}, 'REVERSED', ${lit(earnedId(dealId))}, '${reason}',
      ${TODAY_SQL}, -150000020, 250, -150000, ${net}, 0.1500, -585000, ${net - 585_000}, true, 12)`
}

suite.sequential("dealer commission clawback (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t, { clawbackMonths: 12 })
    insertRate(fx, { dealerId: fx.dealerA, from: "'2020-01-01'", bps: 250, flatCents: 150_000 })
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("settled early inside the window: a new negative line, the EARNED line untouched", () => {
    const { dealId, loanId } = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA)
    const before = sql(`SELECT to_jsonb(l) FROM "DealerCommissionLine" l WHERE "dealId" = ${lit(dealId)}`)
    loanStatus(loanId, "COMPLETED")
    expect(commissionLines(dealId)).toEqual([EARNED, reversed("LOAN_SETTLED_EARLY")])
    expect(sql(`SELECT to_jsonb(l) FROM "DealerCommissionLine" l WHERE "dealId" = ${lit(dealId)} AND "kind" = 'EARNED'`)).toBe(before)
    expect(commissionLines(dealId, `"reversesLineId" = ${lit(earnedId(dealId))}, "effectiveOn" = ${TODAY_SQL}, "baseCents", "flatCents", "bps", "clawbackMonths"`)
      .at(-1)).toBe("t|t|-150000020|-150000|250|12")
  })

  it("never reverses twice: a reopened then re-completed loan, or a second line by hand", () => {
    const { dealId, loanId } = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA)
    loanStatus(loanId, "COMPLETED")
    loanStatus(loanId, "ACTIVE")
    loanStatus(loanId, "COMPLETED")
    expect(commissionLines(dealId)).toEqual([EARNED, reversed("LOAN_SETTLED_EARLY")])
    expectRejected(reversalInsert(dealId, loanId, "LOAN_SETTLED_EARLY"), "A commission line is reversed once")
  })

  it("written off inside the window: reversed", () => {
    const { dealId, loanId } = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA)
    loanStatus(loanId, "WRITTEN_OFF")
    expect(commissionLines(dealId)).toEqual([EARNED, reversed("LOAN_WRITTEN_OFF")])
  })

  it("outside the window: settled early or written off keeps the commission; cancelled still reverses", () => {
    const { dealId, loanId } = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA)
    earnedMonthsAgo(dealId, 13)
    loanStatus(loanId, "COMPLETED")
    expect(commissionLines(dealId)).toEqual([EARNED])
    expectRejected(reversalInsert(dealId, loanId, "LOAN_SETTLED_EARLY"), "outside the clawback window")
    loanStatus(loanId, "ACTIVE")
    loanStatus(loanId, "WRITTEN_OFF")
    expect(commissionLines(dealId)).toEqual([EARNED])
    loanStatus(loanId, "ACTIVE")
    reversalApproved(loanId)
    loanStatus(loanId, "CANCELLED")
    expect(commissionLines(dealId)).toEqual([EARNED, reversed("LOAN_CANCELLED")])
  })

  it("a window that ends today is over", () => {
    const { dealId, loanId } = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA)
    earnedMonthsAgo(dealId, 12)
    loanStatus(loanId, "COMPLETED")
    expect(commissionLines(dealId)).toEqual([EARNED])
  })

  it("clawback months 0: off for early settlement, and CANCELLED still reverses", () => {
    setMonths(0)
    try {
      const { dealId, loanId } = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA)
      expect(commissionLines(dealId, `"clawbackMonths"`)).toEqual(["0"])
      loanStatus(loanId, "COMPLETED")
      expect(commissionLines(dealId).map((line) => line.split("|")[0])).toEqual(["EARNED"])
      loanStatus(loanId, "ACTIVE")
      reversalApproved(loanId)
      loanStatus(loanId, "CANCELLED")
      expect(commissionLines(dealId, `"kind", "reason", "clawbackMonths"`)).toEqual(["EARNED||0", "REVERSED|LOAN_CANCELLED|0"])
    } finally {
      setMonths(12)
    }
  })

  it("completed at maturity, inside the window: not an early settlement", () => {
    const { dealId, loanId } = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA, { maturity: `(now() AT TIME ZONE 'UTC') - INTERVAL '1 day'` })
    loanStatus(loanId, "COMPLETED")
    expect(commissionLines(dealId)).toEqual([EARNED])
    expectRejected(reversalInsert(dealId, loanId, "LOAN_SETTLED_EARLY"), "settled before its maturity")
  })

  it("refuses a hand-written reversal on a live loan, with the wrong reason, or with amounts that are not the exact negatives", () => {
    const { dealId, loanId } = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA)
    expectRejected(reversalInsert(dealId, loanId, "LOAN_SETTLED_EARLY"), "A commission line is reversed only when its loan is settled, written off or cancelled")
    loanStatus(loanId, "WRITTEN_OFF")
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
      DELETE FROM "DealerCommissionLine" WHERE "dealId" = ${lit(dealId)} AND "kind" = 'REVERSED'; COMMIT;`)
    expectRejected(reversalInsert(dealId, loanId, "LOAN_SETTLED_EARLY"), "The reversal reason is the loan's status")
    expectRejected(reversalInsert(dealId, loanId, "LOAN_WRITTEN_OFF", -3_900_000), "A reversal's amounts are the exact negatives of the EARNED line")
    sql(reversalInsert(dealId, loanId, "LOAN_WRITTEN_OFF"))
    expect(commissionLines(dealId)).toEqual([EARNED, reversed("LOAN_WRITTEN_OFF")])
  })
})
