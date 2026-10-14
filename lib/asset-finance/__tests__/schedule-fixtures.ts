// TEST-ONLY synthetic schedules in their stored form. Not a test file.
import { toScheduleRecord } from "../schedule-records"
import type { StoredScheduleRow } from "../stored-schedule"
import { solveStructure } from "../structure"
import { annualSeasonal, biannual, monthly, skipN, stepUp } from "../structure-presets"
import type { StructureInput, StructureResult } from "../types"

// Synthetic deal: R1 250 000, 10% deposit, 20% balloon, prime 11.75% + 1%.
export const BASE: Omit<StructureInput, "weights"> = {
  cashPriceCents: 125_000_000,
  depositCents: 12_500_000,
  tradeInCents: 0,
  financedFeesCents: 150_000,
  balloonCents: 25_000_000,
  startDate: "2026-01-15",
  ratePath: [{ effectiveDate: "2026-01-15", annualRate: 0.1275 }],
}

/** Patterns with skip rows (weight 0) and low-weight rows whose payment is below their interest. */
export const PATTERNS: Record<string, number[]> = {
  MONTHLY: monthly(60),
  SKIP_N: skipN(36, 3),
  // 0.2 × B in the off season does not cover the interest.
  SEASONAL: annualSeasonal(48, 2, [3, 4, 5], 3, 0.2),
  // Pays in March and September only; the 50th period is a March.
  BIANNUAL: biannual(50, [3, 9], 2),
  STEP_UP: stepUp(48, [{ fromPeriod: 24, weight: 1.15 }]),
}

export const solvePattern = (weights: number[]): StructureResult => solveStructure({ ...BASE, weights })

/**
 * The schedule as booking stores it with rows 0..paid settled. A skip row
 * (nothing due) is never paid, so it stays PENDING with nothing paid, as
 * apply-payment leaves it.
 */
export function storedRows(result: StructureResult, paid: number): StoredScheduleRow[] {
  return result.rows.map((row, i) => {
    const settled = i <= paid && row.totalCents > 0
    return {
      ...toScheduleRecord(row),
      id: `row-${i}`,
      status: settled ? "PAID" : "PENDING",
      totalPaid: settled ? row.totalCents : 0,
    }
  })
}
