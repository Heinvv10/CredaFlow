/**
 * Real-Postgres proof of the staff payable-run actions (lib/dealer/payable-runs.ts)
 * on top of the database's own run guards: create takes the dealer's lines due
 * by a month end with each clawback linked with its commission, leaves out a
 * commission whose clawback falls after the period end (and the approval the
 * database then checks accepts that), refuses lines that net to nothing or
 * less; approve by another user only; release only with a reference and to
 * a still-APPROVED account; cancel frees the lines; a refusal raised by a
 * trigger is answered with its own sentence. Every step audited.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/payable-run-actions.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { approvedDealerAccount, cleanupDealerFixtureIfCreated, createDealerFixture, insertRate, lit, type DealerFixture } from "./dealer.integration-fixture"
import { bookedDealerDeal } from "./dealer-booking.integration-fixture"
import { inTenant, staffOf } from "./dealer-origination.integration-fixture"
import { approvePayableRun, cancelPayableRun, createPayableRun, releasePayableRun } from "./payable-runs"
import { decideDealerBankAccount, requestDealerBankAccount } from "./staff-bank-accounts"
import { prisma } from "@/lib/prisma"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture

type Deal = { dealId: string; loanId: string; earned: string }
const lineOf = (dealId: string, kind: "EARNED" | "REVERSED") =>
  sql(`SELECT "id" FROM "DealerCommissionLine" WHERE "dealId" = ${lit(dealId)} AND "kind" = '${kind}'`)
const dated = (lineId: string, date: string) => sql(`BEGIN; SET LOCAL session_replication_role = replica;
  UPDATE "DealerCommissionLine" SET "effectiveOn" = '${date}' WHERE "id" = ${lit(lineId)}; COMMIT;`)
function booked(date: string): Deal {
  const deal = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA)
  const earned = lineOf(deal.dealId, "EARNED")
  dated(earned, date)
  return { ...deal, earned }
}
function settle(deal: Deal, date: string): string {
  sql(`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = ${lit(deal.loanId)}`)
  const reversed = lineOf(deal.dealId, "REVERSED")
  dated(reversed, date)
  return reversed
}
/** The run's live lines, sorted (one transaction links them, so createdAt cannot order them). */
const linked = (runId: string) =>
  sql(`SELECT string_agg("lineId", ',' ORDER BY "lineId") FROM "DealerPayableRunLine" WHERE "runId" = ${lit(runId)} AND NOT "voided"`)
const sorted = (...ids: string[]) => [...ids].sort()
const runRow = (runId: string, columns: string) => sql(`SELECT ${columns} FROM "DealerPayableRun" WHERE "id" = ${lit(runId)}`)
const net = (lineId: string) => Number(sql(`SELECT "netCents" FROM "DealerCommissionLine" WHERE "id" = ${lit(lineId)}`))
const audited = (runId: string, action: string) =>
  sql(`SELECT "userId" FROM "AuditLog" WHERE "entityId" = ${lit(runId)} AND "action" = '${action}'`)

const as = (userId: string) => staffOf(fx, userId)
const create = (periodEnd: string, by = fx.adminA) => inTenant(fx, () => createPayableRun(as(by), fx.dealerA, { periodEnd }))
const created = async (periodEnd: string) => {
  const result = await create(periodEnd)
  if (result.kind !== "created") throw new Error(`run not created: ${JSON.stringify(result)}`)
  return result.runId
}

const deals: Record<string, Deal> = {}
const reversals: Record<string, string> = {}
const runs: Record<string, string> = {}

suite.sequential("staff payable-run actions (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t, { clawbackMonths: 12 })
    insertRate(fx, { dealerId: null, from: "'2020-01-01'", bps: 250, flatCents: 150_000 })
    approvedDealerAccount(fx, fx.dealerA)
    deals.paid = booked("2026-01-15")
    deals.late = booked("2026-01-20")
    reversals.late = settle(deals.late, "2026-02-10")
    deals.netted = booked("2026-01-25")
    reversals.netted = settle(deals.netted, "2026-01-28")
  }, 120_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("refuses a period that is not an ended month end, and a dealer with no approved account", async () => {
    expect(await create("2026-01-30")).toMatchObject({ status: 400 })
    expect(await create("2099-12-31")).toMatchObject({ status: 400 })
    expect(await inTenant(fx, () => createPayableRun(as(fx.adminA), fx.dealerB, { periodEnd: "2026-01-31" })))
      .toEqual({ kind: "refused", status: 409, error: "The dealer has no approved bank account" })
    expect(await inTenant(fx, () => createPayableRun(as(fx.adminA), "no-such-dealer", { periodEnd: "2026-01-31" }))).toMatchObject({ status: 404 })
  })

  it("creates January: a clawback with its commission (the link trigger accepts the order), one clawed back in February left out", async () => {
    runs.january = await created("2026-01-31")
    expect(linked(runs.january).split(",")).toEqual(sorted(reversals.netted, deals.netted.earned, deals.paid.earned))
    expect(runRow(runs.january, `"status", "totalNetCents", "createdById"`)).toBe(`PENDING_APPROVAL|${net(deals.paid.earned)}|${fx.adminA}`)
    expect(audited(runs.january, "DEALER_PAYABLE_RUN_CREATED")).toBe(fx.adminA)
    expect(await create("2026-01-31")).toMatchObject({ status: 409 })
  })

  it("is approved only by another user, and the database accepts the commission left waiting", async () => {
    expect(await inTenant(fx, () => approvePayableRun(as(fx.adminA), runs.january))).toEqual({ kind: "self_approval" })
    expect(runRow(runs.january, `"status"`)).toBe("PENDING_APPROVAL")
    expect(await inTenant(fx, () => approvePayableRun(as(fx.adminB), runs.january))).toEqual({ kind: "approved", runId: runs.january })
    expect(runRow(runs.january, `"status", "approvedById"`)).toBe(`APPROVED|${fx.adminB}`)
    expect(audited(runs.january, "DEALER_PAYABLE_RUN_APPROVED")).toBe(fx.adminB)
    expect(await inTenant(fx, () => approvePayableRun(as(fx.adminB), runs.january))).toMatchObject({ status: 409 })
  })

  it("is released with the lender's EFT reference and, the dealer being a VAT vendor, its tax invoice", async () => {
    const release = (body: Record<string, unknown>) => inTenant(fx, () => releasePayableRun(as(fx.adminB), runs.january, body))
    expect(await release({ releaseReference: "  " })).toMatchObject({ status: 400 })
    expect(await release({ releaseReference: "TEST-EFT-0001" })).toMatchObject({ status: 422, error: expect.stringMatching(/tax invoice/) })
    expect(await release({ releaseReference: "TEST-EFT-0001", taxInvoiceReference: "TEST-INV-0001" })).toMatchObject({ status: 400 })
    expect(await release({ releaseReference: "TEST-EFT-0001", taxInvoiceReference: "TEST-INV-0001", taxInvoiceDate: "2026-02-30" })).toMatchObject({ status: 400 })
    expect(await release({ releaseReference: "TEST-EFT-0001", taxInvoiceReference: "TEST-INV-0001", taxInvoiceDate: "2099-01-01" })).toMatchObject({ status: 400 })
    expect(runRow(runs.january, `"status"`)).toBe("APPROVED")
    expect(await release({ releaseReference: "TEST-EFT-0001", taxInvoiceReference: " TEST-INV-0001 ", taxInvoiceDate: "2026-02-03" }))
      .toEqual({ kind: "released", runId: runs.january })
    expect(runRow(runs.january, `"status", "releaseReference", "releasedById", "dealerTaxInvoiceReference", "dealerTaxInvoiceDate"`))
      .toBe(`RELEASED|TEST-EFT-0001|${fx.adminB}|TEST-INV-0001|2026-02-03`)
    expect(audited(runs.january, "DEALER_PAYABLE_RUN_RELEASED")).toBe(fx.adminB)
    expect(await inTenant(fx, () => cancelPayableRun(as(fx.adminB), runs.january))).toMatchObject({ status: 409 })
  })

  it("lets lines that net to nothing wait, then takes them beside a fresh commission; cancel frees them", async () => {
    expect(await create("2026-02-28")).toMatchObject({ status: 409, error: expect.stringMatching(/net to nothing/) })
    deals.february = booked("2026-02-15")
    const first = await created("2026-02-28")
    expect(linked(first).split(",")).toEqual(sorted(reversals.late, deals.late.earned, deals.february.earned))
    expect(await inTenant(fx, () => cancelPayableRun(as(fx.adminB), first))).toEqual({ kind: "cancelled", runId: first })
    expect(linked(first)).toBe("")
    expect(audited(first, "DEALER_PAYABLE_RUN_CANCELLED")).toBe(fx.adminB)
    runs.february = await created("2026-02-28")
    expect(linked(runs.february).split(",")).toEqual(sorted(reversals.late, deals.late.earned, deals.february.earned))
  })

  it("answers a trigger's refusal with its own sentence: a clawback written after the run was created", async () => {
    settle(deals.february, "2026-02-20")
    expect(await inTenant(fx, () => approvePayableRun(as(fx.adminB), runs.february))).toEqual({
      kind: "refused", status: 409, error: "A payable run pays an EARNED line and its reversal together",
    })
    expect(runRow(runs.february, `"status"`)).toBe("PENDING_APPROVAL")
    await inTenant(fx, () => cancelPayableRun(as(fx.adminB), runs.february))
  })

  it("refuses to release to an account superseded after approval", async () => {
    deals.march = booked("2026-03-15")
    const march = await created("2026-03-31")
    expect(await inTenant(fx, () => approvePayableRun(as(fx.adminB), march))).toMatchObject({ kind: "approved" })
    // A change of account through the staff path: requested, then approved by another user (superseding the old one).
    const requested = await inTenant(fx, () => requestDealerBankAccount(as(fx.officer), fx.dealerA, {
      bankName: "TEST Bank", branchCode: "000001", accountNumber: "0000000077", accountHolder: "TEST Motors (Pty) Ltd", accountType: null,
    }))
    if (requested.kind !== "requested") throw new Error(JSON.stringify(requested))
    const decided = await inTenant(fx, () => prisma.$transaction((tx) => decideDealerBankAccount(tx, {
      tenantId: fx.tenantId, accountId: requested.account.id, decision: "APPROVE", note: "TEST bank letter on file", decider: { id: fx.adminB },
    })))
    expect(decided).toMatchObject({ kind: "decided", supersededId: expect.any(String) })
    expect(await inTenant(fx, () => releasePayableRun(as(fx.adminB), march, { releaseReference: "TEST-EFT-0002" })))
      .toMatchObject({ status: 409, error: expect.stringMatching(/no longer the dealer's approved account/) })
    expect(runRow(march, `"status"`)).toBe("APPROVED")
  })

  it("refuses lines netting to less than nothing once a paid commission is clawed back (they wait)", async () => {
    const march = sql(`SELECT "id" FROM "DealerPayableRun" WHERE "tenantId" = ${lit(fx.tenantId)} AND "status" = 'APPROVED'`)
    await inTenant(fx, () => cancelPayableRun(as(fx.adminB), march))
    // Due by May: February's netted pair, March's commission, and January's paid commission clawed back.
    settle(deals.paid, "2026-05-10")
    expect(await create("2026-05-31")).toMatchObject({ status: 409, error: expect.stringMatching(/net to nothing or less/) })
  })
})
