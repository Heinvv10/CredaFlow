import { PERIODS_PER_YEAR, type Frequency } from "./types"

/**
 * The instalment affordability sets against MONTHLY income, as a monthly figure: the regular instalment x periods a year
 * / 12 (weekly 52/12, fortnightly 26/12). The regular instalment is the largest after the first row (which carries the
 * one-off initiation fee), so a grace period's smaller payments never understate the burden; a single payment is itself.
 */
export function monthlyEquivalentInstalment(rows: ReadonlyArray<{ totalDue: number }>, frequency: Frequency): number {
  if (rows.length === 0) return 0
  const regular = rows.length === 1 ? rows[0]!.totalDue : Math.max(...rows.slice(1).map((r) => r.totalDue))
  return frequency === "MONTHLY" ? regular : Math.round((regular * PERIODS_PER_YEAR[frequency]) / 12)
}
