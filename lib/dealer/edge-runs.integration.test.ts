/**
 * Independent black-box edge tests for dealer payable runs (spec:
 * docs/asset-finance/SLICE5.md Part A). Uses only the exported lib functions
 * the routes call, plus SQL. Principal, users and flow:
 * ./edge-principal-flow.integration.test.ts.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/edge-runs.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import {
  approvedDealerAccount, cleanupDealerFixtureIfCreated, createDealerFixture, insertDealer, insertDealerUser, insertRate, lit, newId, type DealerFixture,
} from "./dealer.integration-fixture"
import { bookedDealerDeal } from "./dealer-booking.integration-fixture"
import { inTenant, staffOf } from "./dealer-origination.integration-fixture"
import { approvePayableRun, cancelPayableRun, createPayableRun, releasePayableRun } from "./payable-runs"
import { deactivateDealer } from "./users"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture

const history = (stmt: string) => sql(`BEGIN; SET LOCAL session_replication_role = replica; ${stmt}; COMMIT;`)
const lineIdOf = (dealId: string, kind = "EARNED") => sql(`SELECT "id" FROM "DealerCommissionLine" WHERE "dealId" = ${lit(dealId)} AND "kind" = '${kind}'`)
const setLineDate = (lineId: string, date: string) => history(`UPDATE "DealerCommissionLine" SET "effectiveOn" = '${date}' WHERE "id" = ${lit(lineId)}`)
const runLines = (runId: string) =>
  sql(`SELECT "lineId" FROM "DealerPayableRunLine" WHERE "runId" = ${lit(runId)} AND NOT "voided" ORDER BY "lineId"`).split("\n").filter(Boolean)
const ok = <T extends { kind: string }>(r: T, kind: string): T => {
  expect(r.kind).toBe(kind)
  return r
}
function freshDealerWithAccount() {
  const dealerId = insertDealer(fx.tenantId, fx.adminA, { name: `TEST Run ${newId("n")}` })
  const userId = insertDealerUser(fx.tenantId, dealerId, { role: "DEALER_ADMIN", byUser: fx.adminA })
  insertRate(fx, { dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
  approvedDealerAccount(fx, dealerId, `00${Math.floor(Math.random() * 1e8)}`)
  return { dealerId, userId }
}
const createRun = (dealerId: string, periodEnd: string, by = fx.adminA) =>
  inTenant(fx, () => createPayableRun(staffOf(fx, by), dealerId, { periodEnd }))
const approveRun = (runId: string, by = fx.adminB) => inTenant(fx, () => approvePayableRun(staffOf(fx, by), runId))
const releaseRun = (runId: string) => inTenant(fx, () => releasePayableRun(staffOf(fx, fx.adminB), runId, { releaseReference: "TEST-EFT-EDGE" }))

suite.sequential("dealer payable run edges (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
  }, 60_000)
  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  // ---------------- payable runs ----------------
  it("R01 a line effective ON periodEnd is in the run; a line the day after is not", async () => {
    const d = freshDealerWithAccount()
    const a = bookedDealerDeal(fx, d.dealerId, d.userId)
    const b = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(a.dealId), "2026-09-30")
    setLineDate(lineIdOf(b.dealId), "2026-10-01")
    const created = ok(await createRun(d.dealerId, "2026-09-30"), "created") as { kind: "created"; runId: string }
    expect(runLines(created.runId)).toEqual([lineIdOf(a.dealId)])
    const approved = await approveRun(created.runId)
    expect(approved.kind).toBe("approved")
  }, 60_000)

  it("R02 periodEnd must be a month end not after today; bad input is a clean refusal, not a throw", async () => {
    const d = freshDealerWithAccount()
    for (const bad of ["2026-09-29", "2099-01-31", "2026-02-30", "garbage", "", null, 20260930, "2026-09-30T00:00:00Z"]) {
      const r = await createRun(d.dealerId, bad as string)
      expect(r, String(bad)).toMatchObject({ status: expect.any(Number) })
    }
  }, 60_000)

  it("R03 a leap-year month end (2024-02-29) is accepted as a period end; 2025-02-29 is not", async () => {
    const d = freshDealerWithAccount()
    expect(await createRun(d.dealerId, "2025-02-29")).toMatchObject({ status: 400 })
    // 2024-02-29 is a valid month end; with no lines due the refusal must be the 'no commission' 409, not a 400
    expect(await createRun(d.dealerId, "2024-02-29")).toMatchObject({ status: 409 })
  }, 60_000)

  it("R04 a run of only reversals (net negative) is refused and the lines wait; a later bigger earn nets with it", async () => {
    const d = freshDealerWithAccount()
    const old = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(old.dealId), "2026-06-15")
    const june = ok(await createRun(d.dealerId, "2026-06-30"), "created") as { runId: string }
    ok(await approveRun(june.runId), "approved")
    ok(await releaseRun(june.runId), "released")
    sql(`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = ${lit(old.loanId)}`) // clawback inside the 12 month window
    const reversalId = lineIdOf(old.dealId, "REVERSED")
    setLineDate(reversalId, "2026-09-10")
    const onlyReversal = await createRun(d.dealerId, "2026-09-30")
    expect(onlyReversal).toMatchObject({ status: 409, error: expect.stringMatching(/net to nothing or less|clawbacks/) })
    expect(sql(`SELECT count(*) FROM "DealerPayableRun" WHERE "dealerId" = ${lit(d.dealerId)} AND "periodEnd" = '2026-09-30'`)).toBe("0")
    const bigger = bookedDealerDeal(fx, d.dealerId, d.userId, { baseCents: 300_000_000 })
    setLineDate(lineIdOf(bigger.dealId), "2026-09-20")
    const nets = ok(await createRun(d.dealerId, "2026-09-30"), "created") as { runId: string }
    expect(runLines(nets.runId).sort()).toEqual([reversalId, lineIdOf(bigger.dealId)].sort())
    expect(sql(`SELECT "totalNetCents" FROM "DealerPayableRun" WHERE "id" = ${lit(nets.runId)}`)).toBe(String(3_000_000 - 1_500_000))
    ok(await approveRun(nets.runId), "approved")
  }, 60_000)

  it("R05 an EARNED and its REVERSED both due in the period net to zero: refused, nothing created", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    sql(`UPDATE "Loan" SET "status" = 'WRITTEN_OFF' WHERE "id" = ${lit(x.loanId)}`)
    setLineDate(lineIdOf(x.dealId), "2026-09-05")
    setLineDate(lineIdOf(x.dealId, "REVERSED"), "2026-09-06")
    expect(await createRun(d.dealerId, "2026-09-30")).toMatchObject({ status: 409 })
    expect(sql(`SELECT count(*) FROM "DealerPayableRun" WHERE "dealerId" = ${lit(d.dealerId)}`)).toBe("0")
  }, 60_000)

  it("R06 an EARNED line whose reversal falls AFTER periodEnd waits (does not pay out in the earlier run), per spec deviation 22", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    sql(`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = ${lit(x.loanId)}`)
    setLineDate(lineIdOf(x.dealId), "2026-08-10")
    setLineDate(lineIdOf(x.dealId, "REVERSED"), "2026-09-10")
    const r = await createRun(d.dealerId, "2026-08-31")
    // Spec: "run-create code must leave out an EARNED line whose reversal falls after periodEnd" -> nothing due.
    console.info(`[R06] earned Aug, reversal Sep, run Aug-31: ${JSON.stringify(r)}`)
    expect(r).toMatchObject({ status: 409 })
  }, 60_000)

  it("R07 same period twice: the second live run is a clean 409; after cancel the lines are free and the period reusable", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(x.dealId), "2026-09-12")
    const first = ok(await createRun(d.dealerId, "2026-09-30"), "created") as { runId: string }
    expect(await createRun(d.dealerId, "2026-09-30")).toMatchObject({ status: 409 })
    ok(await inTenant(fx, () => cancelPayableRun(staffOf(fx, fx.adminB), first.runId)), "cancelled")
    const again = ok(await createRun(d.dealerId, "2026-09-30"), "created") as { runId: string }
    expect(runLines(again.runId)).toEqual([lineIdOf(x.dealId)])
  }, 60_000)

  it("R08 a second run for a later period after the first is RELEASED excludes the released lines", async () => {
    const d = freshDealerWithAccount()
    const a = bookedDealerDeal(fx, d.dealerId, d.userId)
    const b = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(a.dealId), "2026-07-10")
    setLineDate(lineIdOf(b.dealId), "2026-08-10")
    const jul = ok(await createRun(d.dealerId, "2026-07-31"), "created") as { runId: string }
    ok(await approveRun(jul.runId), "approved")
    ok(await releaseRun(jul.runId), "released")
    const aug = ok(await createRun(d.dealerId, "2026-08-31"), "created") as { runId: string }
    expect(runLines(aug.runId)).toEqual([lineIdOf(b.dealId)])
    expect(await createRun(d.dealerId, "2026-07-31")).toMatchObject({ status: 409 }) // same period as a RELEASED run
  }, 60_000)

  it("R09 self-approval is refused by the lib and by the database", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(x.dealId), "2026-09-12")
    const run = ok(await createRun(d.dealerId, "2026-09-30", fx.adminA), "created") as { runId: string }
    expect(await approveRun(run.runId, fx.adminA)).toMatchObject({ kind: "self_approval" })
    expectRejected(`UPDATE "DealerPayableRun" SET "status" = 'APPROVED', "approvedById" = ${lit(fx.adminA)}, "approvedAt" = now() WHERE "id" = ${lit(run.runId)}`, "DealerPayableRun_four_eyes")
  }, 60_000)

  it("R10 a line dated into the period after the run was created blocks approval cleanly (cancel and recreate)", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    const late = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(x.dealId), "2026-09-12")
    setLineDate(lineIdOf(late.dealId), "2026-10-15")
    const run = ok(await createRun(d.dealerId, "2026-09-30"), "created") as { runId: string }
    setLineDate(lineIdOf(late.dealId), "2026-09-20")
    const approved = await approveRun(run.runId)
    expect(approved).toMatchObject({ status: 409 })
  }, 60_000)

  it("R11 deactivating a dealer with an OPEN run: what happens to approve / release / create (records the behaviour)", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(x.dealId), "2026-09-12")
    const run = ok(await createRun(d.dealerId, "2026-09-30"), "created") as { runId: string }
    ok(await inTenant(fx, () => deactivateDealer(staffOf(fx), d.dealerId)), "deactivated")
    const approved = await approveRun(run.runId)
    const released = approved.kind === "approved" ? await releaseRun(run.runId) : null
    const another = await createRun(d.dealerId, "2026-08-31")
    console.info(`[R11] approve=${approved.kind} release=${released?.kind} create-after-deactivation=${JSON.stringify(another)}`)
    expect(approved.kind).toBe("approved") // owed commission remains payable; adjust if the product decides otherwise
  }, 60_000)

  it("R12 creating a NEW run for a deactivated dealer (lines still owed): records the behaviour", async () => {
    const d = freshDealerWithAccount()
    const x = bookedDealerDeal(fx, d.dealerId, d.userId)
    setLineDate(lineIdOf(x.dealId), "2026-08-12")
    ok(await inTenant(fx, () => deactivateDealer(staffOf(fx), d.dealerId)), "deactivated")
    const r = await createRun(d.dealerId, "2026-08-31")
    console.info(`[R12] create run for deactivated dealer: ${JSON.stringify(r)}`)
    expect(r.kind === "created" || (r as { status?: number }).status === 409).toBe(true)
  }, 60_000)
})
