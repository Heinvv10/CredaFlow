/** Pace ceilings worked by hand, shared by the TS (pace-ceiling.test.ts) and SQL (meter-route IT) checks. */
export const PACE_TABLE: readonly { start: number; startDate: string; on: string; allowance: number; ceiling: number }[] = [
  { start: 50, startDate: "2026-12-01", on: "2027-03-01", allowance: 1_000, ceiling: 1_045 },
  { start: 1_000, startDate: "2026-09-01", on: "2026-09-01", allowance: 1_500, ceiling: 1_383 },
  { start: 1_000, startDate: "2026-09-01", on: "2026-09-11", allowance: 1_500, ceiling: 1_506 },
  { start: 0, startDate: "2026-01-01", on: "2026-12-31", allowance: 365, ceiling: 1_185 },
  { start: 0, startDate: "2026-01-01", on: "2026-01-01", allowance: 1, ceiling: 1 },
  { start: 12_000, startDate: "2026-02-28", on: "2028-02-29", allowance: 40_000, ceiling: 12_000 + Math.ceil((40_000 * 3 * (731 + 31)) / 365) },
]
