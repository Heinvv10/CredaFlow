import { describe, expect, it } from "vitest"
import { REPRICE_NOTICE_DAYS, noticeKeptThroughIndex, repriceRemaining, repriceTail } from "./reprice"
import { fromDayNumber, toDayNumber } from "./dates"
import { storedScheduleForReprice } from "./stored-schedule"
import { solveStructure } from "./structure"
import { monthly } from "./structure-presets"
import type { RatePoint, ScheduleRow, StructureInput } from "./types"
import { expectRowIdentities, expectRowsMatchOracle } from "./__tests__/oracle-assertions"
import { oracleDealFromInput, oracleReplay, type OracleDeal } from "./__tests__/structure-oracle"
import { BASE, PATTERNS, solvePattern, storedRows } from "./__tests__/schedule-fixtures"

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

const regular = (row: ScheduleRow): number => row.totalCents - row.balloonCents
const dayAfter = (iso: string, days = 1): string => fromDayNumber(toDayNumber(iso) + days)

describe("repricing skip and seasonal schedules: weights derived from the stored rows", () => {
  // Settled through row 1, so skip rows (SKIP_N rows 0-2, BIANNUAL's off months)
  // are among the pending rows; the rate moves 12.75% → 13.75% on 20 Mar 2026.
  const reprice = (name: string, recorded: boolean) => {
    const weights = PATTERNS[name]
    const result = solvePattern(weights)
    const read = storedScheduleForReprice({
      stored: storedRows(result, 1), balloonCents: BASE.balloonCents,
      recordedBaseCents: recorded ? result.baseInstalmentCents : null, ratePath: BASE.ratePath, startDate: BASE.startDate,
      contractualWeights: weights,
    })
    if ("error" in read) throw new Error(read.error)
    const settled = read.paidThroughIndex
    const ratePath: RatePoint[] = [...BASE.ratePath, { effectiveDate: "2026-03-20", annualRate: 0.1375 }]
    const tail = {
      paidThroughIndex: settled, balanceAtRepriceCents: read.capitalOutstandingCents,
      repriceDate: settled >= 0 ? result.rows[settled].dueDate : BASE.startDate, ratePath, balloonCents: BASE.balloonCents,
    }
    // The same re-solve on the solver's own rows, with the TRUE weights.
    return { weights, result, read, settled, ratePath, derived: repriceTail({ ...tail, rows: read.rows }), truth: repriceTail({ ...tail, rows: result.rows }) }
  }

  it.each(Object.keys(PATTERNS))("%s with the recorded base: exactly the true-weight re-solve, oracle-consistent", (name) => {
    const { weights, result, read, settled, ratePath, derived, truth } = reprice(name, true)
    expect(derived).toEqual({ ...truth, rows: truth.rows.map((row, i) => ({ ...row, weight: derived.rows[i].weight })) })
    expect(derived.rows.map((r) => r.totalCents === 0)).toEqual(result.rows.slice(settled + 1).map((r) => r.weight === 0))
    expectRowIdentities(derived.rows, read.capitalOutstandingCents, BASE.balloonCents)
    const merged = [...result.rows.slice(0, settled + 1), ...derived.rows]
    const replay = oracleReplay(oracleDealFromInput({ ...BASE, weights, ratePath }), merged.map(regular))
    expect(replay.map((r) => r.interestCents)).toEqual(merged.map((r) => r.interestCents))
    expect(replay[replay.length - 1].balanceAfterPaymentCents).toBe(BASE.balloonCents)
  })

  it("the fixtures exercise skip rows and capitalising rows in the pending tail", () => {
    expect(reprice("SKIP_N", true).derived.rows.slice(0, 3).map((r) => r.totalCents)).toEqual([0, 0, 0])
    expect(reprice("BIANNUAL", true).derived.rows.filter((r) => r.totalCents === 0).length).toBeGreaterThan(30)
    expect(reprice("SEASONAL", true).derived.rows.filter((r) => r.totalCents > 0 && r.totalCents < r.interestCents).length).toBeGreaterThan(3)
  })

  it.each(Object.keys(PATTERNS))("%s with no recorded base: preserves the persisted contractual weights exactly", (name) => {
    const { read, derived, truth } = reprice(name, false)
    expect(derived).toEqual(truth)
    expect(derived.rows.map((r) => r.totalCents === 0)).toEqual(truth.rows.map((r) => r.totalCents === 0))
    expectRowIdentities(derived.rows, read.capitalOutstandingCents, BASE.balloonCents)
  })

  it("does not turn the final row's rounding residue into a contractual weight", () => {
    const weights = Array(60).fill(1)
    const input = { ...BASE, cashPriceCents: 100_000, depositCents: 0, financedFeesCents: 0, balloonCents: 0, weights }
    const result = solveStructure(input)
    const read = storedScheduleForReprice({
      stored: storedRows(result, -1), balloonCents: 0, recordedBaseCents: result.baseInstalmentCents,
      ratePath: input.ratePath, startDate: input.startDate, contractualWeights: weights,
    })
    if ("error" in read) throw new Error(read.error)
    const tail = {
      paidThroughIndex: -1, balanceAtRepriceCents: result.financedAmountCents, repriceDate: input.startDate,
      ratePath: [...input.ratePath, { effectiveDate: "2026-02-01", annualRate: 0.1375 }], balloonCents: 0,
    }

    expect(repriceTail({ ...tail, rows: read.rows })).toEqual(repriceTail({ ...tail, rows: result.rows }))
  })

  it("reprices a capitalising tail whose interim balance is below its balloon", () => {
    const weights = [100, ...Array(11).fill(0.2)]
    const input = { ...BASE, cashPriceCents: 10_000_000, depositCents: 0, financedFeesCents: 0, balloonCents: 5_000_000, weights }
    const result = solveStructure(input)
    const read = storedScheduleForReprice({
      stored: storedRows(result, 0), balloonCents: input.balloonCents, recordedBaseCents: result.baseInstalmentCents,
      ratePath: input.ratePath, startDate: input.startDate, contractualWeights: weights,
    })
    if ("error" in read) throw new Error(read.error)
    expect(read.capitalOutstandingCents).toBeLessThan(input.balloonCents)

    const repriced = repriceTail({
      rows: read.rows, paidThroughIndex: read.paidThroughIndex,
      balanceAtRepriceCents: read.capitalOutstandingCents, repriceDate: result.rows[0].dueDate,
      ratePath: [...input.ratePath, { effectiveDate: "2026-02-01", annualRate: 0.1375 }], balloonCents: input.balloonCents,
    })
    expect(repriced.baseInstalmentCents).toBeGreaterThan(0)
    expectRowIdentities(repriced.rows, read.capitalOutstandingCents, input.balloonCents)
  })
})

describe("notice: rows due within REPRICE_NOTICE_DAYS of the run keep their instalment", () => {
  const result = solvePattern(PATTERNS.MONTHLY)
  const paid = 11
  const tomorrowDue = result.rows[paid + 1].dueDate // 2027-02-15
  const runDate = dayAfter(tomorrowDue, -1)
  const ratePath: RatePoint[] = [...BASE.ratePath, { effectiveDate: dayAfter(result.rows[paid].dueDate), annualRate: 0.1375 }]
  const tail = {
    rows: result.rows, paidThroughIndex: paid, balanceAtRepriceCents: result.rows[paid].closingBalanceCents,
    repriceDate: result.rows[paid].dueDate, ratePath, balloonCents: BASE.balloonCents,
  }

  it("keeps rows due less than 14 days after the run date, and only those", () => {
    expect(REPRICE_NOTICE_DAYS).toBe(14)
    expect(noticeKeptThroughIndex(result.rows, paid, runDate)).toBe(paid + 1)
    expect(noticeKeptThroughIndex(result.rows, paid, dayAfter(tomorrowDue, -13))).toBe(paid + 1)
    expect(noticeKeptThroughIndex(result.rows, paid, dayAfter(tomorrowDue, -14))).toBe(paid)
    expect(noticeKeptThroughIndex(result.rows, paid, dayAfter(result.rows[paid + 2].dueDate, -1))).toBe(paid + 2)
  })

  it("a row due tomorrow keeps its amount; the re-solve from the next row absorbs its interest at the new rate", () => {
    const kept = repriceTail({ ...tail, keptThroughIndex: noticeKeptThroughIndex(result.rows, paid, runDate) })
    const unkept = repriceTail(tail)
    expect(kept.rows[0].totalCents).toBe(result.rows[paid + 1].totalCents)
    expect(kept.rows[0].interestCents).toBe(unkept.rows[0].interestCents) // charged at the new rate
    expect(kept.rows[0].interestCents).toBeGreaterThan(result.rows[paid + 1].interestCents)
    // It pays less than the new instalment would have, so the rest pay more.
    expect(kept.rows[0].totalCents).toBeLessThan(unkept.rows[0].totalCents)
    expect(kept.baseInstalmentCents).toBeGreaterThan(unkept.baseInstalmentCents)
    expect(kept.rows[1].totalCents).toBe(kept.baseInstalmentCents)
    expectRowIdentities(kept.rows, result.rows[paid].closingBalanceCents, BASE.balloonCents)
    const merged = [...result.rows.slice(0, paid + 1), ...kept.rows]
    const replay = oracleReplay(oracleDealFromInput({ ...BASE, weights: PATTERNS.MONTHLY, ratePath }), merged.map(regular))
    expect(replay.map((r) => r.interestCents)).toEqual(merged.map((r) => r.interestCents))
    expect(replay[replay.length - 1].balanceAfterPaymentCents).toBe(BASE.balloonCents)
  })

  it("refuses to keep every pending row (the last must absorb the residue)", () => {
    expect(() => repriceTail({ ...tail, keptThroughIndex: result.rows.length - 1 })).toThrow(RangeError)
    expect(() => repriceTail({ ...tail, keptThroughIndex: paid - 1 })).toThrow(RangeError)
  })
})
