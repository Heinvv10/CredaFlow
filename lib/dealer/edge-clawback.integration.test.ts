/**
 * Independent black-box edge tests for dealer commission clawback window
 * boundaries (spec: docs/asset-finance/SLICE5.md Part A).
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/edge-clawback.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealerFixtureIfCreated, createDealerFixture, insertRate, TODAY_SQL, lit, type DealerFixture } from "./dealer.integration-fixture"
import { edgeCommissionHelpers } from "./edge-commission.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
const { freshDealer, bookWith, lines, loanStatus, setMonths, earnedAt, reversalApproved } = edgeCommissionHelpers(() => fx)

suite.sequential("dealer commission clawback edges (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t, { clawbackMonths: 12 })
  }, 60_000)
  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  // ---- clawback window boundaries ----
  it("E30 window of 1 month: a month ago today is OUTSIDE, a month ago plus one day is INSIDE", () => {
    setMonths(1)
    try {
      const d = freshDealer()
      insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
      const outside = bookWith(d)
      earnedAt(outside.dealId, `(${TODAY_SQL} - INTERVAL '1 month')::date`)
      loanStatus(outside.loanId, "COMPLETED")
      expect(lines(outside.dealId)).toEqual(["EARNED|1500000|0|1500000"])
      const inside = bookWith(d)
      earnedAt(inside.dealId, `(${TODAY_SQL} - INTERVAL '1 month')::date + 1`)
      loanStatus(inside.loanId, "COMPLETED")
      expect(lines(inside.dealId)).toHaveLength(2)
    } finally {
      setMonths(12)
    }
  }, 60_000)

  it("E31 12-month window: day-before-boundary inside, boundary day outside, day-after outside", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
    const cases: Array<[number, number]> = [[1, 2], [0, 1], [-1, 1]]
    for (const [days, expected] of cases) {
      const deal = bookWith(d)
      earnedAt(deal.dealId, `(${TODAY_SQL} - INTERVAL '12 months')::date + (${days})`)
      loanStatus(deal.loanId, "WRITTEN_OFF")
      expect(lines(deal.dealId), `earned 12 months ago ${days >= 0 ? "+" : ""}${days} days`).toHaveLength(expected)
    }
  }, 60_000)

  it("E32 clawback months 0 plus WRITTEN_OFF: nothing; clawbackMonths range CHECK: 61 and -1 refused, 60 accepted", () => {
    expectRejected(`UPDATE "TenantConfig" SET "dealerCommissionClawbackMonths" = 61 WHERE "tenantId" = ${lit(fx.tenantId)}`, "TenantConfig_dealer_clawback_months_range")
    expectRejected(`UPDATE "TenantConfig" SET "dealerCommissionClawbackMonths" = -1 WHERE "tenantId" = ${lit(fx.tenantId)}`, "TenantConfig_dealer_clawback_months_range")
    setMonths(60)
    setMonths(0)
    try {
      const d = freshDealer()
      insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
      const deal = bookWith(d)
      loanStatus(deal.loanId, "WRITTEN_OFF")
      expect(lines(deal.dealId)).toHaveLength(1)
    } finally {
      setMonths(12)
    }
  }, 60_000)

  it("E33 the window is the one SNAPSHOT on the EARNED line: changing the tenant setting after earning does not move it", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
    const deal = bookWith(d) // earned with 12
    setMonths(0)
    try {
      loanStatus(deal.loanId, "COMPLETED")
      expect(lines(deal.dealId), "snapshot of 12 months should still claw back").toHaveLength(2)
    } finally {
      setMonths(12)
    }
  }, 60_000)

  it("E34 early settlement judged on the SAST date of maturity: maturity tomorrow (SAST) 00:30 is early; maturity today (SAST) 00:30 is not", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
    const sastMidnightPlus = (offsetDays: number) =>
      `((${TODAY_SQL} + ${offsetDays})::timestamp + INTERVAL '30 minutes') AT TIME ZONE 'Africa/Johannesburg' AT TIME ZONE 'UTC'`
    const early = bookWith(d, undefined, { maturity: sastMidnightPlus(1) })
    loanStatus(early.loanId, "COMPLETED")
    expect(lines(early.dealId), "maturity is tomorrow in Johannesburg: early").toHaveLength(2)
    const onTime = bookWith(d, undefined, { maturity: sastMidnightPlus(0) })
    loanStatus(onTime.loanId, "COMPLETED")
    expect(lines(onTime.dealId), "maturity is today in Johannesburg: not early").toHaveLength(1)
  }, 60_000)

  it("E35 WRITTEN_OFF at/after maturity but inside window still reverses (spec: only COMPLETED is maturity-gated)", () => {
    const d = freshDealer()
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
    const deal = bookWith(d, undefined, { maturity: `(now() AT TIME ZONE 'UTC') - INTERVAL '1 day'` })
    loanStatus(deal.loanId, "WRITTEN_OFF")
    expect(lines(deal.dealId)).toHaveLength(2)
  }, 60_000)

  it("E36 reversal of a vendor dealer's line carries the exact negative VAT and is dated today", () => {
    const d = freshDealer(true)
    insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
    const deal = bookWith(d, 1000)
    loanStatus(deal.loanId, "COMPLETED")
    expect(lines(deal.dealId)).toEqual(["EARNED|10|2|12", "REVERSED|-10|-2|-12"])
    expect(sql(`SELECT "effectiveOn" = ${TODAY_SQL} FROM "DealerCommissionLine" WHERE "dealId" = ${lit(deal.dealId)} AND "kind" = 'REVERSED'`)).toBe("t")
  }, 60_000)

  it("E37 CANCELLED loan after the window and with months 0 still reverses (spec dev 6)", () => {
    setMonths(0)
    try {
      const d = freshDealer()
      insertRate(fx, { dealerId: d.dealerId, from: "'2020-01-01'", bps: 100, flatCents: 0 })
      const deal = bookWith(d)
      earnedAt(deal.dealId, `(${TODAY_SQL} - INTERVAL '5 years')::date`)
      reversalApproved(deal.loanId)
      loanStatus(deal.loanId, "CANCELLED")
      expect(lines(deal.dealId)).toHaveLength(2)
    } finally {
      setMonths(12)
    }
  }, 60_000)
})
