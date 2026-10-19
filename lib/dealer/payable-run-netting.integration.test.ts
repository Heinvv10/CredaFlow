/**
 * Real-Postgres proof of payable-run netting (migration
 * 20261019120200_dealer_portal_hardening): a run never pays an EARNED line
 * apart from its clawback.
 *
 *  - guardDealerPayableRunLineNetting: an EARNED line joins a run only after
 *    its REVERSED line (when one exists) is linked to the same run.
 *  - guardDealerPayableRunNetting, on PENDING_APPROVAL -> APPROVED: every
 *    EARNED line in the run with a reversal has that reversal in the run; every
 *    REVERSED line in the run has its EARNED line in a live run; and no line of
 *    the dealer effective by the period end is left out of every live run (an
 *    EARNED line whose reversal is also unpaid waits with it: they net to zero).
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/payable-run-netting.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { approvedDealerAccount, cleanupDealerFixtureIfCreated, createDealerFixture, insertRate, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { bookedDealerDeal } from "./dealer-booking.integration-fixture"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let account: string

const LINK_PAIRING = "An EARNED line joins a run only after its REVERSED line is linked to the same run"
const APPROVE_PAIRING = "A payable run pays an EARNED line and its reversal together"
const APPROVE_COMPLETE = "A payable run is approved with every line of its dealer due by its period end"

const lineOf = (dealId: string, kind: "EARNED" | "REVERSED") =>
  sql(`SELECT "id" FROM "DealerCommissionLine" WHERE "dealId" = ${lit(dealId)} AND "kind" = '${kind}'`)
/** History: the line took effect on `date` (triggers off for the one statement). */
const dated = (lineId: string | null, date: string) => sql(`BEGIN; SET LOCAL session_replication_role = replica;
  UPDATE "DealerCommissionLine" SET "effectiveOn" = '${date}' WHERE "id" = ${lit(lineId)}; COMMIT;`)
// A run's total must be positive: beside a reversal, the fresh line is a bigger deal.
const BIGGER = 300_000_000
/** A booked deal of dealer A whose EARNED line took effect on `date`. */
function booked(date: string, baseCents?: number): { earned: string; loanId: string; dealId: string } {
  const { dealId, loanId } = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA, { baseCents })
  const earned = lineOf(dealId, "EARNED")
  dated(earned, date)
  return { earned, loanId, dealId }
}
/** The loan settles early inside the window: the REVERSED line, dated `date`. */
function settle(deal: { loanId: string; dealId: string }, date: string): string {
  sql(`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = ${lit(deal.loanId)}`)
  const reversed = lineOf(deal.dealId, "REVERSED")
  dated(reversed, date)
  return reversed
}
/** A run of dealer A for `periodEnd`, its totals the sums of `totalsOf`. */
function run(periodEnd: string, totalsOf: string[]): string {
  const id = newId("run")
  sql(`INSERT INTO "DealerPayableRun" ("id", "tenantId", "dealerId", "periodEnd", "bankAccountId", "totalNetCents", "totalVatCents", "totalGrossCents", "createdById")
    SELECT ${lit(id)}, ${lit(fx.tenantId)}, ${lit(fx.dealerA)}, '${periodEnd}', ${lit(account)}, sum("netCents"), sum("vatCents"), sum("grossCents"), ${lit(fx.adminA)}
    FROM "DealerCommissionLine" WHERE "id" IN (${totalsOf.map(lit).join(", ")})`)
  return id
}
const link = (runId: string, lineId: string) =>
  `INSERT INTO "DealerPayableRunLine" ("id", "tenantId", "runId", "lineId") VALUES ('${newId("drl")}', ${lit(fx.tenantId)}, ${lit(runId)}, ${lit(lineId)})`
const linkAll = (runId: string, lineIds: string[]) => lineIds.forEach((lineId) => sql(link(runId, lineId)))
const approve = (runId: string) =>
  `UPDATE "DealerPayableRun" SET "status" = 'APPROVED', "approvedById" = ${lit(fx.adminB)}, "approvedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(runId)}`
const cancel = (runId: string) => sql(`UPDATE "DealerPayableRun" SET "status" = 'CANCELLED', "cancelledById" = ${lit(fx.adminB)},
  "cancelledAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(runId)}`)
const release = (runId: string) => sql(`UPDATE "DealerPayableRun" SET "status" = 'RELEASED', "releasedById" = ${lit(fx.adminB)},
  "releasedAt" = CURRENT_TIMESTAMP, "releaseReference" = 'TEST-EFT-N', "dealerTaxInvoiceReference" = 'TEST-INV-N',
  "dealerTaxInvoiceDate" = CURRENT_DATE WHERE "id" = ${lit(runId)}`)
const status = (runId: string) => sql(`SELECT "status" FROM "DealerPayableRun" WHERE "id" = ${lit(runId)}`)

// Each test works one month of 2026 and leaves every line up to it paid or
// netted, so the next month's completeness check sees only its own lines.
suite.sequential("dealer payable-run netting (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t, { clawbackMonths: 12 })
    insertRate(fx, { dealerId: null, from: "'2020-01-01'", bps: 250, flatCents: 150_000 })
    account = approvedDealerAccount(fx, fx.dealerA)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("links an EARNED line only after its REVERSED line, in the same run", () => {
    const settled = booked("2026-01-15")
    const reversed = settle(settled, "2026-01-20")
    const paid = booked("2026-01-15")
    const runId = run("2026-01-31", [paid.earned])
    expectRejected(link(runId, settled.earned), LINK_PAIRING)
    linkAll(runId, [reversed, settled.earned, paid.earned])
    sql(approve(runId))
    release(runId)
    expect(status(runId)).toBe("RELEASED")
  })

  it("refuses approving a run whose EARNED line was clawed back after it was linked", () => {
    const deal = booked("2026-02-15")
    const runId = run("2026-02-28", [deal.earned])
    sql(link(runId, deal.earned))
    settle(deal, "2026-03-15")
    expectRejected(approve(runId), APPROVE_PAIRING)
    expect(status(runId)).toBe("PENDING_APPROVAL")
    cancel(runId)
  })

  it("refuses a run that leaves out a line of the dealer due by its period end", () => {
    // From the test above: an unpaid EARNED line (February) and its reversal (March).
    const deal = sql(`SELECT "dealId" FROM "DealerCommissionLine" WHERE "tenantId" = ${lit(fx.tenantId)} AND "effectiveOn" = '2026-02-15'`)
    const fresh = booked("2026-03-15")
    const partial = run("2026-03-31", [fresh.earned])
    sql(link(partial, fresh.earned))
    expectRejected(approve(partial), APPROVE_COMPLETE)
    cancel(partial)
    const netted = run("2026-03-31", [fresh.earned])
    linkAll(netted, [lineOf(deal, "REVERSED"), lineOf(deal, "EARNED"), fresh.earned])
    sql(approve(netted))
    expect(status(netted)).toBe("APPROVED")
  })

  it("refuses a REVERSED line paid without its EARNED line in a live run", () => {
    const settled = booked("2026-04-10")
    const reversed = settle(settled, "2026-04-15")
    const other = booked("2026-04-15", BIGGER)
    const lonely = run("2026-04-30", [other.earned, reversed])
    linkAll(lonely, [reversed, other.earned])
    expectRejected(approve(lonely), APPROVE_PAIRING)
    cancel(lonely)
    const whole = run("2026-04-30", [other.earned])
    linkAll(whole, [reversed, settled.earned, other.earned])
    sql(approve(whole))
    expect(status(whole)).toBe("APPROVED")
  })

  it("lets an EARNED line wait with a reversal that falls after the period end", () => {
    const settled = booked("2026-05-15")
    const reversed = settle(settled, "2026-06-15")
    const other = booked("2026-05-15")
    const runId = run("2026-05-31", [other.earned])
    sql(link(runId, other.earned))
    sql(approve(runId))
    expect(status(runId)).toBe("APPROVED")
    expect(sql(`SELECT count(*) FROM "DealerPayableRunLine" WHERE "lineId" IN (${lit(settled.earned)}, ${lit(reversed)}) AND NOT "voided"`)).toBe("0")
    // June: the waiting pair is due now, and nets to zero beside a fresh line.
    const fresh = booked("2026-06-15")
    const june = run("2026-06-30", [fresh.earned])
    linkAll(june, [reversed, settled.earned, fresh.earned])
    sql(approve(june))
    release(june)
  })

  it("pays a reversal after its EARNED line was paid in an earlier run", () => {
    const deal = booked("2026-07-15")
    const first = run("2026-07-31", [deal.earned])
    sql(link(first, deal.earned))
    sql(approve(first))
    release(first)
    const reversed = settle(deal, "2026-08-15")
    const bigger = booked("2026-08-15", BIGGER)
    const second = run("2026-08-31", [bigger.earned, reversed])
    linkAll(second, [reversed, bigger.earned])
    sql(approve(second))
    expect(status(second)).toBe("APPROVED")
  })
})
