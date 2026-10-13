import { describe, expect, it } from "vitest"
import { repriceRemaining } from "./reprice"
import { solveStructure } from "./structure"
import { monthly } from "./structure-presets"
import type { RatePoint, ScheduleRow, StructureInput } from "./types"
import { expectRowIdentities, expectRowsMatchOracle } from "./__tests__/oracle-assertions"
import { oracleDealFromInput, oracleReplay, type OracleDeal } from "./__tests__/structure-oracle"

// Synthetic deal: R1 250 000, 10% deposit, 20% balloon, 60 months at 11.75%.
const INPUT: StructureInput = {
  cashPriceCents: 125_000_000,
  depositCents: 12_500_000,
  tradeInCents: 0,
  financedFeesCents: 150_000,
  balloonCents: 25_000_000,
  weights: monthly(60),
  startDate: "2026-01-15",
  ratePath: [{ effectiveDate: "2026-01-15", annualRate: 0.1175 }],
}
const ORIGINAL = solveStructure(INPUT)
const PAID_THROUGH = 11 // rows 0..11 are no longer PENDING
// Period 12 runs (2027-01-15, 2027-02-15]; its first day is the first at 12.00%.
const NEW_PATH: RatePoint[] = [...INPUT.ratePath, { effectiveDate: "2027-01-16", annualRate: 0.12 }]

function tailDeal(rows: ScheduleRow[], from: number, openingCents: number, startDate: string, ratePath: RatePoint[]): OracleDeal {
  const tail = rows.slice(from)
  return {
    openingCents,
    startDate,
    dueDates: tail.map((r) => r.dueDate),
    weights: tail.map((r) => r.weight),
    lumpsCents: tail.map(() => 0),
    ratePath,
    balloonCents: INPUT.balloonCents,
  }
}

const reprice = (overrides: Partial<Parameters<typeof repriceRemaining>[0]> = {}): ScheduleRow[] =>
  repriceRemaining({
    rows: ORIGINAL.rows,
    paidThroughIndex: PAID_THROUGH,
    balanceAtRepriceCents: ORIGINAL.rows[PAID_THROUGH].closingBalanceCents,
    repriceDate: ORIGINAL.rows[PAID_THROUGH].dueDate,
    ratePath: NEW_PATH,
    balloonCents: INPUT.balloonCents,
    ...overrides,
  })

describe("repriceRemaining: 11.75% → 12.00% from period 12", () => {
  const before = structuredClone(ORIGINAL.rows)
  const repriced = reprice()

  it("replaces only the pending rows, keeping due dates and weights", () => {
    expect(ORIGINAL.rows).toEqual(before)
    expect(repriced.map((r) => r.index)).toEqual(ORIGINAL.rows.slice(PAID_THROUGH + 1).map((r) => r.index))
    expect(repriced.map((r) => [r.dueDate, r.weight])).toEqual(
      ORIGINAL.rows.slice(PAID_THROUGH + 1).map((r) => [r.dueDate, r.weight]),
    )
  })

  it("re-solves a higher instalment that still lands exactly on the balloon", () => {
    expectRowIdentities(repriced, ORIGINAL.rows[PAID_THROUGH].closingBalanceCents, INPUT.balloonCents)
    expect(repriced[0].totalCents).toBeGreaterThan(ORIGINAL.rows[PAID_THROUGH + 1].totalCents)
  })

  it("agrees with the oracle on the repriced tail", () => {
    const deal = tailDeal(ORIGINAL.rows, PAID_THROUGH + 1, repriced[0].openingBalanceCents, ORIGINAL.rows[PAID_THROUGH].dueDate, NEW_PATH)
    expectRowsMatchOracle(deal, repriced, repriced[0].totalCents)
  })

  it("agrees with a whole-contract oracle walk over the merged schedule", () => {
    const merged = [...ORIGINAL.rows.slice(0, PAID_THROUGH + 1), ...repriced]
    const replay = oracleReplay(
      oracleDealFromInput({ ...INPUT, ratePath: NEW_PATH }),
      merged.map((r) => r.totalCents - r.balloonCents),
    )
    expect(replay.map((r) => r.interestCents)).toEqual(merged.map((r) => r.interestCents))
    expect(replay[replay.length - 1].balanceAfterPaymentCents).toBe(INPUT.balloonCents)
  })

  it("is idempotent", () => {
    expect(reprice()).toEqual(repriced)
    expect(JSON.stringify(reprice())).toBe(JSON.stringify(repriced))
  })

  it("with no rate change reproduces the original pending rows", () => {
    expect(reprice({ ratePath: INPUT.ratePath })).toEqual(ORIGINAL.rows.slice(PAID_THROUGH + 1))
  })

  it("before any payment, from the contract start, equals the original solve", () => {
    const rows = reprice({
      paidThroughIndex: -1,
      balanceAtRepriceCents: ORIGINAL.financedAmountCents,
      repriceDate: INPUT.startDate,
      ratePath: INPUT.ratePath,
    })
    expect(rows).toEqual(ORIGINAL.rows)
  })
})

describe("repriceRemaining mid-period", () => {
  it("accrues from the reprice date on the balance given at that date", () => {
    // Rows 0..13 paid; row 13 fell due 2027-03-15. The caller's balance on
    // 2027-03-27 includes the 12 days accrued at the old rate.
    const paid = 13
    const repriceDate = "2027-03-27"
    const path: RatePoint[] = [...INPUT.ratePath, { effectiveDate: "2027-03-28", annualRate: 0.125 }]
    const capital = ORIGINAL.rows[paid].closingBalanceCents
    const balance = capital + Math.round((capital * 0.1175 * 12) / 365)
    const rows = reprice({ paidThroughIndex: paid, balanceAtRepriceCents: balance, repriceDate, ratePath: path })
    expectRowIdentities(rows, balance, INPUT.balloonCents)
    expectRowsMatchOracle(tailDeal(ORIGINAL.rows, paid + 1, balance, repriceDate, path), rows, rows[0].totalCents)
  })
})

describe("repriceRemaining refuses invalid input", () => {
  const due = (i: number): string => ORIGINAL.rows[i].dueDate
  const cases: [string, Partial<Parameters<typeof repriceRemaining>[0]>][] = [
    ["no pending rows", { paidThroughIndex: 59, repriceDate: due(59) }],
    ["paidThroughIndex below -1", { paidThroughIndex: -2 }],
    ["fractional paidThroughIndex", { paidThroughIndex: 10.5 }],
    ["reprice date before the last paid due date", { repriceDate: "2027-01-14" }],
    ["reprice date on the first pending due date", { repriceDate: due(PAID_THROUGH + 1) }],
    ["balance not above the balloon", { balanceAtRepriceCents: INPUT.balloonCents }],
    ["non-integer balance", { balanceAtRepriceCents: 1.5 }],
    ["rate path starting after the reprice date", { ratePath: [{ effectiveDate: "2027-02-01", annualRate: 0.12 }] }],
    ["rows not indexed 0..n-1", { rows: ORIGINAL.rows.slice(1) }],
  ]
  for (const [name, patch] of cases) {
    it(name, () => {
      expect(() => reprice(patch)).toThrow(RangeError)
    })
  }
})
