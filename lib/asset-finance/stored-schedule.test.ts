import { describe, expect, it } from "vitest"
import { repriceTail } from "./reprice"
import { toScheduleRecord } from "./schedule-records"
import { storedScheduleForReprice, type StoredScheduleRow } from "./stored-schedule"
import type { RatePoint, ScheduleRow, StructureResult } from "./types"
import { expectRowIdentities } from "./__tests__/oracle-assertions"
import { oracleDealFromInput, oracleReplay } from "./__tests__/structure-oracle"
import { BASE, PATTERNS, solvePattern, storedRows } from "./__tests__/schedule-fixtures"

const readBack = (stored: StoredScheduleRow[], ratePath: RatePoint[] = BASE.ratePath, recordedBaseCents: number | null = null) =>
  storedScheduleForReprice({ stored, balloonCents: BASE.balloonCents, recordedBaseCents, ratePath, startDate: BASE.startDate })

function ok(stored: StoredScheduleRow[], recordedBaseCents: number | null = null) {
  const schedule = readBack(stored, BASE.ratePath, recordedBaseCents)
  if ("error" in schedule) throw new Error(schedule.error)
  return schedule
}

/** The last row due on or before row `paid` that something was due on: what the schedule reads as settled. */
const lastSettled = (result: StructureResult, paid: number) =>
  Math.max(-1, ...result.rows.slice(0, paid + 1).flatMap((row, i) => (row.totalCents > 0 ? [i] : [])))

describe("storedScheduleForReprice: the balance after the last settled row", () => {
  describe.each(Object.entries(PATTERNS))("%s", (_name, weights) => {
    const result = solvePattern(weights)
    it.each([-1, 0, 2, 3, 11, 24, result.rows.length - 2])("settled through %i: the solver's own balance, capitalised interest included", (paid) => {
      const schedule = ok(storedRows(result, paid))
      const settled = lastSettled(result, paid)
      expect(schedule.paidThroughIndex).toBe(settled)
      expect(schedule.capitalOutstandingCents).toBe(settled < 0 ? result.financedAmountCents : result.rows[settled].closingBalanceCents)
      // Pending rows come back exactly, balances and interest included.
      const strip = (rows: ScheduleRow[]) => rows.map(({ weight: _weight, ...rest }) => rest)
      expect(strip(schedule.rows.slice(settled + 1))).toEqual(strip(result.rows.slice(settled + 1)))
      expect(schedule.rows.map((r) => r.index)).toEqual(result.rows.map((_, i) => i))
    })
  })

  it("treats a skip row left PENDING behind a settled row as history, not a gap", () => {
    const result = solvePattern(PATTERNS.SKIP_N)
    const stored = storedRows(result, 5)
    expect(stored.slice(0, 3).map((r) => [r.status, r.totalDue])).toEqual([["PENDING", 0], ["PENDING", 0], ["PENDING", 0]])
    expect(ok(stored).paidThroughIndex).toBe(5)
  })
})

describe("storedScheduleForReprice refuses what it cannot read back exactly", () => {
  const result = solvePattern(PATTERNS.MONTHLY)

  it("nothing pending", () => {
    expect(readBack(storedRows(result, 59))).toEqual({ error: "no_pending_rows" })
  })

  it("treats a database NULL contractual-weight snapshot like an older omitted snapshot", () => {
    const stored = storedRows(result, 11)
    expect(storedScheduleForReprice({
      stored, balloonCents: BASE.balloonCents, recordedBaseCents: result.baseInstalmentCents,
      ratePath: BASE.ratePath, startDate: BASE.startDate, contractualWeights: null,
    })).toEqual(readBack(stored, BASE.ratePath, result.baseInstalmentCents))
  })

  it("a gap in the installment numbers (installmentNo must be index + 1)", () => {
    const gap = storedRows(result, 11).filter((row) => row.installmentNo !== 30)
    expect(readBack(gap)).toEqual({ error: "schedule_not_contiguous" })
    const renumbered = storedRows(result, 11).map((row) => (row.installmentNo === 1 ? { ...row, installmentNo: 0 } : row))
    expect(readBack(renumbered)).toEqual({ error: "schedule_not_contiguous" })
  })

  it("an owed row behind a settled one: a flagged or part-paid row inside the pending rows", () => {
    const flagged = storedRows(result, 11)
    flagged[30] = { ...flagged[30], status: "OVERDUE" }
    expect(readBack(flagged)).toEqual({ error: "schedule_not_contiguous" })
    const partly = storedRows(result, 11)
    partly[40] = { ...partly[40], totalPaid: 100 } // PENDING but part-paid is not re-solvable
    expect(readBack(partly)).toEqual({ error: "schedule_not_contiguous" })
  })

  it("a hand-edited row or a rate path the rows were not solved under", () => {
    const fees = storedRows(result, 11)
    fees[20] = { ...fees[20], feesDue: 6_900, totalDue: fees[20].totalDue + 6_900 }
    expect("error" in readBack(fees)).toBe(false)
    const edited = storedRows(result, 11)
    edited[20] = { ...edited[20], principalDue: edited[20].principalDue + 1, interestDue: edited[20].interestDue - 1 }
    expect(readBack(edited)).toEqual({ error: "unsupported_schedule" })
    // Two compensating edits: the rebuilt balance and the closing balance are
    // both still right, only the row-by-row comparison sees the change.
    const shifted = storedRows(result, 11)
    shifted[20] = { ...shifted[20], principalDue: shifted[20].principalDue + 1, interestDue: shifted[20].interestDue - 1 }
    shifted[21] = { ...shifted[21], principalDue: shifted[21].principalDue - 1, interestDue: shifted[21].interestDue + 1 }
    expect(readBack(shifted)).toEqual({ error: "unsupported_schedule" })
    const seasonal = storedRows(solvePattern(PATTERNS.SEASONAL), 11)
    expect(readBack(seasonal, [{ effectiveDate: BASE.startDate, annualRate: 0.13 }])).toEqual({ error: "unsupported_schedule" })
  })
})

describe("re-solving a stored schedule at an unchanged rate returns it unchanged", () => {
  // STEP_UP's most common pending payment after row 11 is 1.15 × B, whose
  // ratio to B does not snap: without the recorded base it reproduces only to
  // within a cent per row (deriveWeights), so it is read with the recorded one.
  it.each(Object.entries(PATTERNS))("%s", (name, weights) => {
    const result = solvePattern(weights)
    const reads = name === "STEP_UP"
      ? [[-1, result.baseInstalmentCents], [11, result.baseInstalmentCents]] as const
      : [[-1, null], [11, null], [11, result.baseInstalmentCents]] as const
    for (const [paid, recorded] of reads) {
      const schedule = ok(storedRows(result, paid), recorded)
      const settled = schedule.paidThroughIndex
      const solved = repriceTail({
        rows: schedule.rows,
        paidThroughIndex: settled,
        balanceAtRepriceCents: schedule.capitalOutstandingCents,
        repriceDate: settled >= 0 ? result.rows[settled].dueDate : BASE.startDate,
        ratePath: BASE.ratePath,
        balloonCents: BASE.balloonCents,
      })
      const original = result.rows.slice(settled + 1)
      const amounts = (rows: ScheduleRow[]) => rows.map(({ weight: _weight, ...rest }) => rest)
      expect(amounts(solved.rows)).toEqual(amounts(original))
      // The weights come back in one common scale, zeros as zeros.
      const scale = Math.max(...solved.rows.map((r) => r.weight)) / Math.max(...original.map((r) => r.weight))
      solved.rows.forEach((row, i) => expect(row.weight).toBeCloseTo(original[i].weight * scale, 5))
    }
  })
})

describe("a mid-period reference change on a stored schedule", () => {
  // 12 rows paid (through 2027-01-15); the rate moves to 13% from 3 Feb 2027,
  // inside period 12: old rate for 16 Jan–2 Feb, new rate from 3 Feb.
  const input = { ...BASE, weights: PATTERNS.MONTHLY }
  const result = solvePattern(PATTERNS.MONTHLY)
  const newPath: RatePoint[] = [...BASE.ratePath, { effectiveDate: "2027-02-03", annualRate: 0.13 }]
  const schedule = ok(storedRows(result, 11))
  const solved = repriceTail({
    rows: schedule.rows,
    paidThroughIndex: 11,
    balanceAtRepriceCents: schedule.capitalOutstandingCents,
    repriceDate: result.rows[11].dueDate,
    ratePath: newPath,
    balloonCents: BASE.balloonCents,
  })

  it("keeps due dates and lands exactly on the balloon", () => {
    expect(solved.rows.map((r) => r.dueDate)).toEqual(result.rows.slice(12).map((r) => r.dueDate))
    expectRowIdentities(solved.rows, result.rows[11].closingBalanceCents, BASE.balloonCents)
    expect(solved.baseInstalmentCents).toBeGreaterThan(result.baseInstalmentCents)
  })

  it("charges simple daily interest across the change: the oracle's day walk agrees to the cent", () => {
    const merged = [...result.rows.slice(0, 12), ...solved.rows]
    const replay = oracleReplay(oracleDealFromInput({ ...input, ratePath: newPath }), merged.map((r) => r.totalCents - r.balloonCents))
    expect(replay.map((r) => r.interestCents)).toEqual(merged.map((r) => r.interestCents))
    expect(replay[replay.length - 1].balanceAfterPaymentCents).toBe(BASE.balloonCents)
  })
})

describe("a paid row reopened after a backdated reprice", () => {
  it("uses solved opening-balance snapshots instead of applying the newer rate to historical accrual", () => {
    const result = solvePattern(PATTERNS.MONTHLY)
    const ratePath: RatePoint[] = [...BASE.ratePath, { effectiveDate: result.rows[10].dueDate, annualRate: 0.15 }]
    const repriced = repriceTail({
      rows: result.rows,
      paidThroughIndex: 11,
      balanceAtRepriceCents: result.rows[11].closingBalanceCents,
      repriceDate: result.rows[11].dueDate,
      ratePath,
      balloonCents: BASE.balloonCents,
    })
    const stored = storedRows(result, 11).map((row, i) => ({
      ...row,
      assetFinanceOpeningBalanceCents: result.rows[i].openingBalanceCents,
    }))
    for (let i = 12; i < stored.length; i++) {
      stored[i] = {
        ...stored[i],
        ...toScheduleRecord(repriced.rows[i - 12]),
        assetFinanceOpeningBalanceCents: repriced.rows[i - 12].openingBalanceCents,
      }
    }
    stored[11] = { ...stored[11], status: "PENDING", totalPaid: 0 }

    const reopened = storedScheduleForReprice({
      stored,
      balloonCents: BASE.balloonCents,
      recordedBaseCents: repriced.baseInstalmentCents,
      ratePath,
      startDate: BASE.startDate,
      contractualWeights: PATTERNS.MONTHLY,
    })
    if ("error" in reopened) throw new Error(reopened.error)
    expect(reopened.paidThroughIndex).toBe(10)
    expect(reopened.capitalOutstandingCents).toBe(result.rows[11].openingBalanceCents)
    expect(reopened.rows[11].interestCents).toBe(result.rows[11].interestCents)
    expect(() => repriceTail({
      rows: reopened.rows,
      paidThroughIndex: reopened.paidThroughIndex,
      balanceAtRepriceCents: reopened.capitalOutstandingCents,
      repriceDate: result.rows[10].dueDate,
      ratePath: [...ratePath, { effectiveDate: result.rows[12].dueDate, annualRate: 0.16 }],
      balloonCents: BASE.balloonCents,
    })).not.toThrow()
  })
})

describe("NCA fixed charges stay outside the interest-bearing capital view", () => {
  it("reads real service/initiation fees and credit-life premiums without capitalising or dropping them", () => {
    const result = solvePattern(PATTERNS.MONTHLY)
    const charged = storedRows(result, 11).map((row, i) => {
      const feesDue = 6_000 + (i === 0 ? 120_750 : 0)
      return { ...row, feesDue: feesDue + 4_500, creditLifePremiumDue: 4_500, totalDue: row.totalDue + feesDue + 4_500, assetFinanceOpeningBalanceCents: result.rows[i].openingBalanceCents }
    })
    const read = readBack(charged, BASE.ratePath, result.baseInstalmentCents)
    if ("error" in read) throw new Error(read.error)
    expect(read.capitalOutstandingCents).toBe(result.rows[11].closingBalanceCents)
    expect(read.rows.slice(12).map((row) => [row.totalCents, row.interestCents, row.feesCents])).toEqual(result.rows.slice(12).map((row) => [row.totalCents, row.interestCents, 0]))
  })
})
