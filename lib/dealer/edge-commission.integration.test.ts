/**
 * Independent black-box edge tests for dealer commission rate resolution,
 * accrual and the deal lifecycle (spec: docs/asset-finance/SLICE5.md Part A).
 * Clawback boundaries: ./edge-clawback.integration.test.ts.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/edge-commission.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, insertRate, TODAY_SQL, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { approve, approveSql, book, submitSql, DEALER_DEAL_BASE_CENTS, DEALER_DEAL_FEES_CENTS, commissionLines } from "./dealer-booking.integration-fixture"
import { edgeCommissionHelpers } from "./edge-commission.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
const { freshDealer, draftDeal, bookWith, snap, lines, cancel } = edgeCommissionHelpers(() => fx)

suite.sequential("dealer commission edges (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t, { clawbackMonths: 12 })
  }, 60_000)
  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  // ---- rate resolution (run before any tenant default exists) ----
  it("E01 no dealer row and no tenant default: source NONE, null rate id, books with no line", () => {
    const d = freshDealer()
    const { dealId } = bookWith(d)
    expect(snap(dealId)).toBe("NONE|0|0|150000020|t")
    expect(lines(dealId)).toEqual([])
  })

  it("E02 a dealer rate effective TODAY applies to a deal approved today", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 50, flatCents: 0 })
    insertRate(fx, { dealerId: d.dealerId, from: TODAY_SQL, bps: 100, flatCents: 0 })
    const { dealId } = bookWith(d)
    expect(snap(dealId).split("|").slice(0, 3)).toEqual(["DEALER", "100", "0"])
  })

  it("E03 a dealer rate effective TOMORROW is ignored", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 50, flatCents: 0 })
    insertRate(fx, { dealerId: d.dealerId, from: `${TODAY_SQL} + 1`, bps: 900, flatCents: 0 })
    const { dealId } = bookWith(d)
    expect(snap(dealId).split("|").slice(0, 3)).toEqual(["DEALER", "50", "0"])
  })

  it("E04 a rate added AFTER approval (even effective today) does not change the snapshot or the line", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 50, flatCents: 0 })
    const { dealId } = draftDeal(d)
    approve(fx, dealId)
    insertRate(fx, { dealerId: d.dealerId, from: TODAY_SQL, bps: 900, flatCents: 0 })
    book(fx, dealId)
    expect(snap(dealId).split("|").slice(0, 3)).toEqual(["DEALER", "50", "0"])
    expect(commissionLines(dealId, `"kind", "bps", "netCents"`)).toEqual(["EARNED|50|750000"])
  })

  it("E05 a rate in the past but with a dealer row older than a newer tenant default: the dealer row wins; no dealer row: the tenant default", () => {
    sql(`INSERT INTO "DealerCommissionRate" ("id", "tenantId", "dealerId", "effectiveFrom", "bps", "flatCents", "createdById")
      VALUES ('${newId("dcr")}', ${lit(fx.tenantId)}, NULL, ${TODAY_SQL}, 700, 0, ${lit(fx.adminA)})`)
    const withRow = freshDealer()
    insertRate(fx, { dealerId: withRow.dealerId, from: "'2020-01-01'", bps: 50, flatCents: 0 })
    const futureOnly = freshDealer()
    insertRate(fx, { dealerId: futureOnly.dealerId, from: `${TODAY_SQL} + 1`, bps: 900, flatCents: 0 })
    const bare = freshDealer()
    expect(snap(bookWith(withRow).dealId).split("|").slice(0, 3)).toEqual(["DEALER", "50", "0"])
    expect(snap(bookWith(futureOnly).dealId).split("|").slice(0, 3)).toEqual(["TENANT_DEFAULT", "700", "0"])
    expect(snap(bookWith(bare).dealId).split("|").slice(0, 3)).toEqual(["TENANT_DEFAULT", "700", "0"])
  })

  it("E06 a dealer row that is explicitly 0/0 beats a positive tenant default (no commission)", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 0, flatCents: 0 })
    const { dealId } = bookWith(d)
    expect(snap(dealId).split("|").slice(0, 3)).toEqual(["DEALER", "0", "0"])
    expect(lines(dealId)).toEqual([])
  })

  it("E07 rate bounds: bps 1001, negative bps, flat over ceiling, duplicate effective date are refused", () => {
    const d = freshDealer()
    const ins = (bps: number, flat: number, from = "'2021-01-01'") =>
      `INSERT INTO "DealerCommissionRate" ("id", "tenantId", "dealerId", "effectiveFrom", "bps", "flatCents", "createdById")
       VALUES ('${newId("dcr")}', ${lit(fx.tenantId)}, ${lit(d.dealerId)}, ${from}, ${bps}, ${flat}, ${lit(fx.adminA)})`
    expectRejected(ins(1001, 0), "DealerCommissionRate_bounds")
    expectRejected(ins(-1, 0), "DealerCommissionRate_bounds")
    expectRejected(ins(0, 10_000_001), "DealerCommissionRate_bounds")
    expectRejected(ins(0, -1), "DealerCommissionRate_bounds")
    sql(ins(1000, 10_000_000))
    expectRejected(ins(5, 5), "duplicate key")
  })

  // ---- accrual shapes ----
  it("E10 flat-only commission: bps 0, flat > 0 earns the flat", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 0, flatCents: 12_345 })
    expect(lines(bookWith(d).dealId)).toEqual(["EARNED|12345|0|12345"])
  })

  it("E11 bps-only commission: flat 0 earns round(base x bps / 10000)", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
    expect(lines(bookWith(d).dealId)).toEqual(["EARNED|1500000|0|1500000"]) // 1,500,000.2 -> 1,500,000
  })

  it("E12 half-cent bps x cents rounds half UP; below half earns nothing", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
    expect(lines(bookWith(d, 50).dealId)).toEqual(["EARNED|1|0|1"]) // 0.5 -> 1
    expect(lines(bookWith(d, 49).dealId)).toEqual([]) // 0.49 -> 0: no line
    expect(lines(bookWith(d, 149).dealId)).toEqual(["EARNED|1|0|1"]) // 1.49 -> 1
    expect(lines(bookWith(d, 150).dealId)).toEqual(["EARNED|2|0|2"]) // 1.5 -> 2
  })

  it("E13 VAT half-cent rounds half UP for a vendor dealer; gross = net + vat", () => {
    const d = freshDealer(true)
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
    expect(lines(bookWith(d, 1000).dealId)).toEqual(["EARNED|10|2|12"]) // 10 x 0.15 = 1.5 -> 2
    expect(lines(bookWith(d, 3000).dealId)).toEqual(["EARNED|30|5|35"]) // 4.5 -> 5
    expect(lines(bookWith(d, 200).dealId)).toEqual(["EARNED|2|0|2"]) // 0.3 -> 0
  })

  it("E14 largest bps on a large base stays exact (no int overflow)", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 1000, flatCents: 10_000_000 })
    expect(lines(bookWith(d, 2_100_000_000).dealId)).toEqual(["EARNED|220000000|0|220000000"])
  })

  it("E15 the base is the goods advance: the financed fees never count, and a deposit covering the price earns only the flat", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 250, flatCents: 500 })
    const { dealId, applicationId } = draftDeal(d)
    approve(fx, dealId)
    expect(Number(snap(dealId).split("|")[3])).toBe(DEALER_DEAL_BASE_CENTS)
    expect(Number(sql(`SELECT "appliedAmount" FROM "LoanApplication" WHERE "id" = ${lit(applicationId)}`))).toBe(DEALER_DEAL_BASE_CENTS + DEALER_DEAL_FEES_CENTS)
    expect(lines(bookWith(d, 0).dealId)).toEqual(["EARNED|500|0|500"])
  })

  it("E16 johannesburg date: the EARNED line is dated the SAST calendar day, not the UTC day", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
    const { dealId } = bookWith(d)
    expect(sql(`SELECT "effectiveOn" = ${TODAY_SQL} FROM "DealerCommissionLine" WHERE "dealId" = ${lit(dealId)}`)).toBe("t")
    // Only discriminating between 22:00 and 24:00 UTC; the assertion above holds always.
  })

  // ---- deal lifecycle ----
  it("E20 cancelled after APPROVED, before BOOKED: no commission, ever", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 100 })
    const { dealId } = draftDeal(d)
    approve(fx, dealId)
    sql(`UPDATE "AssetFinanceDeal" SET ${cancel()} WHERE "id" = ${lit(dealId)}`)
    expect(lines(dealId)).toEqual([])
    expectRejected(`UPDATE "AssetFinanceDeal" SET "status" = 'BOOKED', "loanId" = 'nope' WHERE "id" = ${lit(dealId)}`, "")
    expect(lines(dealId)).toEqual([])
  })

  it("E21 BOOKED then deal CANCELLED: the single EARNED line stays; no duplicate", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
    const { dealId } = bookWith(d)
    let outcome = "allowed"
    try {
      sql(`UPDATE "AssetFinanceDeal" SET ${cancel()} WHERE "id" = ${lit(dealId)}`)
    } catch {
      outcome = "refused"
    }
    console.info(`[E21] BOOKED -> CANCELLED deal update was ${outcome}`)
    expect(lines(dealId)).toEqual(["EARNED|1500000|0|1500000"])
  })

  it("E22 a no-op status write on a BOOKED deal never accrues twice", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
    const { dealId } = bookWith(d)
    sql(`UPDATE "AssetFinanceDeal" SET "status" = 'BOOKED' WHERE "id" = ${lit(dealId)}`)
    expect(lines(dealId)).toHaveLength(1)
  })

  it("E23 a caller-set snapshot on the move into APPROVED is refused (even equal to the computed one)", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
    const { dealId } = draftDeal(d)
    sql(submitSql(dealId))
    expectRejected(approveSql(fx, dealId, `, "dealerCommissionBps" = 100`), "")
    expectRejected(approveSql(fx, dealId, `, "dealerCommissionBps" = 9000`), "")
  })
})
