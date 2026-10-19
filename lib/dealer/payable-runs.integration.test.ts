/**
 * Real-Postgres proof of dealer payable runs (migration
 * 20261019120100_dealer_portal, guardDealerPayableRun, guardDealerPayableRunLine
 * and their CHECKs): created PENDING_APPROVAL to the dealer's APPROVED account
 * for a period already ended; a line in one live run only (partial unique
 * DealerPayableRunLine_one_live_run_per_line), freed when its run is
 * cancelled; approval by a second user (CHECK DealerPayableRun_four_eyes) with
 * totals equal to its lines; release only after approval and only while the
 * account is still APPROVED; released and cancelled runs frozen; nothing deleted.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/payable-runs.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import {
  approvedDealerAccount, cleanupDealerFixtureIfCreated, createDealerFixture, decideDealerAccount, insertRate, lit, newId, requestDealerAccount,
  TODAY_SQL, type DealerFixture,
} from "./dealer.integration-fixture"
import { bookedDealerDeal } from "./dealer-booking.integration-fixture"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let account: string
const lines: string[] = []
let lineB: string

const lineOf = (dealId: string) => sql(`SELECT "id" FROM "DealerCommissionLine" WHERE "dealId" = ${lit(dealId)}`)
/** INSERT a run of dealer A; its totals are the sums of `totalsOf` (default `forLines`, else lines[0]). */
function runInsert(over: { periodEnd: string; account?: string; dealer?: string; status?: string; forLines?: string[]; totalsOf?: string[] }): { id: string; insert: string } {
  const id = newId("run")
  const ids = (over.totalsOf ?? over.forLines ?? [lines[0]]).map(lit).join(", ")
  const sums = `SELECT sum("netCents") AS n, sum("vatCents") AS v, sum("grossCents") AS g FROM "DealerCommissionLine" WHERE "id" IN (${ids})`
  return {
    id,
    insert: `INSERT INTO "DealerPayableRun" ("id", "tenantId", "dealerId", "periodEnd", "bankAccountId", "status", "totalNetCents", "totalVatCents",
        "totalGrossCents", "createdById")
      SELECT ${lit(id)}, ${lit(fx.tenantId)}, ${lit(over.dealer ?? fx.dealerA)}, ${over.periodEnd}, ${lit(over.account ?? account)},
        '${over.status ?? "PENDING_APPROVAL"}', s.n, s.v, s.g, ${lit(fx.adminA)} FROM (${sums}) s`,
  }
}
function run(over: Parameters<typeof runInsert>[0]): string {
  const { id, insert } = runInsert(over)
  sql(insert)
  for (const line of over.forLines ?? []) sql(link(id, line))
  return id
}
const link = (runId: string, lineId: string) =>
  `INSERT INTO "DealerPayableRunLine" ("id", "tenantId", "runId", "lineId") VALUES ('${newId("drl")}', ${lit(fx.tenantId)}, ${lit(runId)}, ${lit(lineId)})`
const approveRun = (runId: string, by: string) =>
  `UPDATE "DealerPayableRun" SET "status" = 'APPROVED', "approvedById" = ${lit(by)}, "approvedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(runId)}`
const releaseRun = (runId: string) => `UPDATE "DealerPayableRun" SET "status" = 'RELEASED', "releasedById" = ${lit(fx.adminB)},
  "releasedAt" = CURRENT_TIMESTAMP, "releaseReference" = 'TEST-EFT-1' WHERE "id" = ${lit(runId)}`
const cancelRun = (runId: string) => `UPDATE "DealerPayableRun" SET "status" = 'CANCELLED', "cancelledById" = ${lit(fx.adminB)},
  "cancelledAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(runId)}`
const status = (runId: string) => sql(`SELECT "status" FROM "DealerPayableRun" WHERE "id" = ${lit(runId)}`)

suite.sequential("dealer payable runs (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
    insertRate(fx, { dealerId: null, from: "'2020-01-01'", bps: 250, flatCents: 150_000 })
    for (let i = 0; i < 4; i++) lines.push(lineOf(bookedDealerDeal(fx, fx.dealerA, fx.salesUserA).dealId))
    lineB = lineOf(bookedDealerDeal(fx, fx.dealerB, fx.userB).dealId)
    // History: lines 0-1 were earned in January, so two month-end runs can both
    // hold them; lines 2-3 in July, after the June run (approval needs every
    // line due by the period end in a live run: migration 20261019120200).
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE "DealerCommissionLine" SET "effectiveOn" = '2026-01-15' WHERE "tenantId" = ${lit(fx.tenantId)};
      UPDATE "DealerCommissionLine" SET "effectiveOn" = '2026-07-15' WHERE "id" IN (${lit(lines[2])}, ${lit(lines[3])}); COMMIT;`)
    account = approvedDealerAccount(fx, fx.dealerA)
  }, 120_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("is created PENDING_APPROVAL, for a period already ended, to the dealer's APPROVED account", () => {
    const pending = requestDealerAccount(fx, fx.dealerA, fx.officer, "0000000003")
    const rejected = requestDealerAccount(fx, fx.dealerA, fx.officer, "0000000004")
    sql(decideDealerAccount(rejected, fx.adminB, "REJECTED"))
    const theirs = approvedDealerAccount(fx, fx.dealerB)
    expectRejected(runInsert({ periodEnd: "'2026-02-28'", account: pending }).insert, "A payable run pays the dealer's APPROVED bank account")
    expectRejected(runInsert({ periodEnd: "'2026-02-28'", account: rejected }).insert, "A payable run pays the dealer's APPROVED bank account")
    expectRejected(runInsert({ periodEnd: "'2026-02-28'", account: theirs }).insert, "A payable run pays the dealer's APPROVED bank account")
    expectRejected(runInsert({ periodEnd: `${TODAY_SQL} + 1` }).insert, "A payable run covers a period that has ended")
    expectRejected(runInsert({ periodEnd: "'2026-02-28'", status: "APPROVED" }).insert, "A payable run is created PENDING_APPROVAL")
  })

  it("links only the run's own dealer's lines earned by its period end", () => {
    const early = run({ periodEnd: "'2025-12-31'" })
    expectRejected(link(early, lines[0]), "A run holds its dealer's lines earned by its period end")
    sql(cancelRun(early))
    const runId = run({ periodEnd: "'2026-01-31'" })
    expectRejected(link(runId, lineB), "A run holds its dealer's lines earned by its period end")
    sql(cancelRun(runId))
  })

  it("holds a line in one live run only; cancelling a run frees its lines", () => {
    const first = run({ periodEnd: "'2026-02-28'", forLines: [lines[0], lines[1]] })
    const second = run({ periodEnd: "'2026-03-31'" })
    expectRejected(link(second, lines[0]), "DealerPayableRunLine_one_live_run_per_line")
    sql(cancelRun(first))
    expect(sql(`SELECT bool_and("voided") FROM "DealerPayableRunLine" WHERE "runId" = ${lit(first)}`)).toBe("t")
    sql(link(second, lines[0]))
    sql(cancelRun(second))
  })

  it("is approved by a second user, with totals equal to its live lines", () => {
    const empty = run({ periodEnd: "'2026-04-30'" })
    expectRejected(approveRun(empty, fx.adminB), "A payable run is approved with at least one line and totals equal to them")
    sql(cancelRun(empty))
    const wrong = run({ periodEnd: "'2026-05-31'", forLines: [lines[0]] })
    sql(link(wrong, lines[1]))
    expectRejected(approveRun(wrong, fx.adminB), "A payable run is approved with at least one line and totals equal to them")
    sql(cancelRun(wrong))
    const runId = run({ periodEnd: "'2026-06-30'", forLines: [lines[0], lines[1]] })
    expectRejected(approveRun(runId, fx.adminA), "DealerPayableRun_four_eyes")
    expect(status(runId)).toBe("PENDING_APPROVAL")
    sql(approveRun(runId, fx.adminB))
    expectRejected(link(runId, lines[2]), "A line joins a run only while the run awaits approval")
  })

  it("is released only after approval and only to a still-APPROVED account", () => {
    const pending = run({ periodEnd: "'2026-07-31'", forLines: [lines[2], lines[3]] })
    expectRejected(releaseRun(pending), "A payable run moves PENDING_APPROVAL -> APPROVED -> RELEASED, or is cancelled")
    sql(approveRun(pending, fx.adminB))
    // the dealer's account changes: the old one is superseded before the new one is approved
    sql(`UPDATE "DealerBankAccount" SET "status" = 'SUPERSEDED' WHERE "id" = ${lit(account)}`)
    expectRejected(releaseRun(pending), "A payable run pays the dealer's APPROVED bank account")
    account = approvedDealerAccount(fx, fx.dealerA, "0000000005")
    expectRejected(releaseRun(pending), "A payable run pays the dealer's APPROVED bank account")
    sql(cancelRun(pending))
    const runId = run({ periodEnd: "'2026-08-31'", forLines: [lines[2], lines[3]] })
    sql(approveRun(runId, fx.adminB))
    sql(releaseRun(runId))
    expect(status(runId)).toBe("RELEASED")
  })

  it("freezes released and cancelled runs and never deletes one", () => {
    const released = sql(`SELECT "id" FROM "DealerPayableRun" WHERE "tenantId" = ${lit(fx.tenantId)} AND "status" = 'RELEASED'`)
    const cancelled = sql(`SELECT "id" FROM "DealerPayableRun" WHERE "tenantId" = ${lit(fx.tenantId)} AND "status" = 'CANCELLED' LIMIT 1`)
    expectRejected(cancelRun(released), "A released or cancelled payable run never changes")
    expectRejected(`UPDATE "DealerPayableRun" SET "releaseReference" = 'X' WHERE "id" = ${lit(released)}`, "A released or cancelled payable run never changes")
    expectRejected(approveRun(cancelled, fx.adminB), "A released or cancelled payable run never changes")
    expectRejected(`UPDATE "DealerPayableRunLine" SET "voided" = true WHERE "runId" = ${lit(released)}`, "A run's line is only voided, when its run is cancelled")
    expectRejected(`DELETE FROM "DealerPayableRun" WHERE "id" = ${lit(cancelled)}`, "A payable run is never deleted")
    expectRejected(`DELETE FROM "DealerPayableRunLine" WHERE "runId" = ${lit(released)}`, "A run's line is never deleted")
    expectRejected(`BEGIN; TRUNCATE "DealerPayableRun" CASCADE; ROLLBACK;`, "A payable run is never deleted")
    expectRejected(`BEGIN; TRUNCATE "DealerPayableRunLine"; ROLLBACK;`, "A run's line is never deleted")
  })
})
