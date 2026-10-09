import type { DefaultChargeInput, DefaultChargeScheduleRow } from "@/lib/loan/default-charges"

// Shared inputs for the charges engine tests.

// Midday SAST so a date never straddles the SAST/UTC day boundary.
export const d = (ymd: string) => new Date(`${ymd}T12:00:00+02:00`)

export function row(
  due: string,
  principalDue: number,
  interestDue: number,
  feesDue = 0,
): DefaultChargeScheduleRow {
  return {
    dueDate: d(due),
    principalDue,
    interestDue,
    feesDue,
    totalDue: principalDue + interestDue + feesDue,
  }
}

// R2,000 MICRO30 bullet: R100 interest, R69 service fee, due 1 Sep.
export const bullet = row("2026-09-01", 200_000, 10_000, 6_900)

export function input(over: Partial<DefaultChargeInput>): DefaultChargeInput {
  return {
    schedule: [bullet],
    receipts: [],
    adminCharges: [],
    interestRatePm: 0.05,
    monthlyServiceFee: 0,
    maturityDate: bullet.dueDate,
    asOf: d("2026-09-11"),
    ...over,
  }
}
