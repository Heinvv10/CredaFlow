import { describe, expect, it } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { repriceTail } from "./reprice"
import { solveStructure } from "./structure"
import { annualSeasonal, monthly, skipN, stepUp } from "./structure-presets"
import {
  deriveWeights,
  dueDateInstant,
  modalPositive,
  storedScheduleForReprice,
  toScheduleRecord,
  type StoredScheduleRow,
} from "./schedule-records"
import type { RatePoint, StructureInput, StructureResult } from "./types"
import { expectRowIdentities } from "./__tests__/oracle-assertions"
import { oracleDealFromInput, oracleReplay } from "./__tests__/structure-oracle"

// Synthetic deal: R1 250 000, 10% deposit, 20% balloon, prime 11.75% + 1%.
const BASE: Omit<StructureInput, "weights"> = {
  cashPriceCents: 125_000_000,
  depositCents: 12_500_000,
  tradeInCents: 0,
  financedFeesCents: 150_000,
  balloonCents: 25_000_000,
  startDate: "2026-01-15",
  ratePath: [{ effectiveDate: "2026-01-15", annualRate: 0.1275 }],
}

/** The schedule as booking stores it, rows 0..paid settled. */
function stored(result: StructureResult, paid: number): StoredScheduleRow[] {
  return result.rows.map((row, i) => ({
    ...toScheduleRecord(row),
    id: `row-${i}`,
    status: i <= paid ? "PAID" : "PENDING",
    totalPaid: i <= paid ? row.totalCents : 0,
  }))
}

function readBack(result: StructureResult, paid: number, recordedBase: number | null) {
  const schedule = storedScheduleForReprice(stored(result, paid), BASE.balloonCents, recordedBase)
  if ("error" in schedule) throw new Error(schedule.error)
  return schedule
}

describe("toScheduleRecord", () => {
  const result = solveStructure({ ...BASE, weights: monthly(60) })
  const records = result.rows.map(toScheduleRecord)

  it("stores the balloon as capital on the last row, so principal sums to the financed amount", () => {
    expect(records[59].principalDue).toBe(result.rows[59].principalCents + BASE.balloonCents)
    expect(records.reduce((sum, r) => sum + r.principalDue, 0)).toBe(result.financedAmountCents)
    expect(records.every((r, i) => r.totalDue === r.principalDue + r.interestDue && r.installmentNo === i + 1)).toBe(true)
  })

  it("stores a due date at SAST midnight, which reads back as the same calendar day", () => {
    expect(dueDateInstant("2027-01-15").toISOString()).toBe("2027-01-14T22:00:00.000Z")
    expect(records.map((r) => sastCalendarDate(r.dueDate))).toEqual(result.rows.map((r) => r.dueDate))
  })
})

describe("modalPositive", () => {
  it("takes the most common positive value, the smallest on a tie, ignoring zeros", () => {
    expect(modalPositive([0, 0, 0, 500, 500, 300])).toBe(500)
    expect(modalPositive([700, 300, 700, 300])).toBe(300)
    expect(modalPositive([0, 0])).toBeNull()
  })
})

describe("deriveWeights", () => {
  it("snaps a weight to 4 decimals when that reproduces the stored round(R × w) payment", () => {
    // R = 2 183 357: 1.15 × R = 2 510 860.55 → stored 2 510 861; 0.5 × R → 1 091 679 (rounded up from .5)
    expect(deriveWeights([2_183_357, 0, 2_510_861, 1_091_679, 2_183_357], 2_183_357, 60)).toEqual([1, 0, 1.15, 0.5, 1])
  })

  it("keeps the raw ratio when no 4-decimal weight reproduces the payment", () => {
    const third = Math.round(2_183_357 / 3) // 727 786
    const [w] = deriveWeights([third, 2_183_357], 2_183_357, 60)
    expect(w).toBe(third / 2_183_357)
    expect(Math.round(2_183_357 * w)).toBe(third)
  })

  it("lets the final row carry the solver's residue of up to one cent per schedule row", () => {
    expect(deriveWeights([2_183_357, 2_183_357 + 37], 2_183_357, 60)).toEqual([1, 1])
    expect(deriveWeights([2_183_357, 2_183_357 + 61], 2_183_357, 60)[1]).toBe((2_183_357 + 61) / 2_183_357)
  })
})

describe("storedScheduleForReprice", () => {
  const result = solveStructure({ ...BASE, weights: monthly(60) })

  it("reads the balance at the last settled due date as the capital the pending rows still owe", () => {
    const schedule = readBack(result, 11, null)
    expect(schedule.paidThroughIndex).toBe(11)
    expect(schedule.capitalOutstandingCents).toBe(result.rows[11].closingBalanceCents)
    expect(schedule.rows[11].closingBalanceCents).toBe(result.rows[11].closingBalanceCents)
    expect(schedule.referenceInstalmentCents).toBe(result.baseInstalmentCents)
    expect(schedule.rows.slice(12).every((r) => r.weight === 1)).toBe(true)
  })

  it("reads the whole financed amount when nothing is settled", () => {
    const schedule = readBack(result, -1, null)
    expect(schedule.paidThroughIndex).toBe(-1)
    expect(schedule.capitalOutstandingCents).toBe(result.financedAmountCents)
  })

  it("refuses a schedule with nothing pending, a gap, or fees it would drop", () => {
    expect(storedScheduleForReprice(stored(result, 59), BASE.balloonCents, null)).toEqual({ error: "no_pending_rows" })
    const gap = stored(result, 11)
    gap[30] = { ...gap[30], status: "OVERDUE" }
    expect(storedScheduleForReprice(gap, BASE.balloonCents, null)).toEqual({ error: "schedule_not_contiguous" })
    const partly = stored(result, 11)
    partly[40] = { ...partly[40], totalPaid: 100 } // PENDING but part-paid is not re-solvable
    expect(storedScheduleForReprice(partly, BASE.balloonCents, null)).toEqual({ error: "schedule_not_contiguous" })
    const fees = stored(result, 11)
    fees[20] = { ...fees[20], feesDue: 6_900, totalDue: fees[20].totalDue + 6_900 }
    expect(storedScheduleForReprice(fees, BASE.balloonCents, null)).toEqual({ error: "unsupported_schedule" })
  })
})

describe("re-solving a stored schedule at an unchanged rate returns it unchanged", () => {
  const cases: [string, number[], number | "recorded" | null][] = [
    ["MONTHLY", monthly(60), null],
    ["SKIP_N", skipN(36, 3), null],
    // Recorded base: weights 1 and 1.15 exactly.
    ["STEP_UP, recorded base", stepUp(48, [{ fromPeriod: 24, weight: 1.15 }]), "recorded"],
    // No recorded base: the modal payment is the off-season round(0.5 × B), so
    // the weights come back as 1 and ≈6 (raw ratios when 6 does not reproduce
    // the stored payment) — the same payments at half the scale.
    ["ANNUAL_SEASONAL, derived base", annualSeasonal(48, 2, [3, 4, 5], 3, 0.5), null],
  ]
  it.each(cases)("%s", (_name, weights, base) => {
    const result = solveStructure({ ...BASE, weights })
    for (const paid of [-1, 11]) {
      const schedule = readBack(result, paid, base === "recorded" ? result.baseInstalmentCents : base)
      const solved = repriceTail({
        rows: schedule.rows,
        paidThroughIndex: paid,
        balanceAtRepriceCents: schedule.capitalOutstandingCents,
        repriceDate: paid >= 0 ? result.rows[paid].dueDate : BASE.startDate,
        ratePath: BASE.ratePath,
        balloonCents: BASE.balloonCents,
      })
      const original = result.rows.slice(paid + 1)
      const amounts = (rows: typeof original) => rows.map(({ weight: _weight, ...rest }) => rest)
      expect(amounts(solved.rows)).toEqual(amounts(original))
      // The weights come back in one common scale (≈2 for the seasonal case).
      const scale = Math.max(...solved.rows.map((r) => r.weight)) / Math.max(...original.map((r) => r.weight))
      solved.rows.forEach((row, i) => expect(row.weight).toBeCloseTo(original[i].weight * scale, 5))
    }
  })
})

describe("a mid-period reference change on a stored schedule", () => {
  // 12 rows paid (through 2027-01-15); prime 11.75% → 12.00% from 3 Feb 2027,
  // inside period 12: old rate for 16 Jan–2 Feb, new rate from 3 Feb.
  const input: StructureInput = { ...BASE, weights: monthly(60) }
  const result = solveStructure(input)
  const newPath: RatePoint[] = [...BASE.ratePath, { effectiveDate: "2027-02-03", annualRate: 0.13 }]
  const schedule = readBack(result, 11, null)
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
