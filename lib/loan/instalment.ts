/**
 * The recurring instalment a client is quoted / should budget for.
 *
 * A DEFERRED initiation fee is folded into instalment 1 only
 * (lib/loan-calculator.ts: `schedule[0].totalDue += initiationFee`), so for a
 * multi-instalment loan the first instalment is fee-loaded and NOT the
 * recurring amount. The recurring instalment is instalment 2 (`schedule[1]`);
 * for a single-instalment loan (e.g. a micro loan) it is the sole instalment.
 *
 * This mirrors loan-calculator's own `monthlyInstalment` selection so the
 * loan-detail page shows the same figure the Apply page quoted (audit F-3).
 */
export function recurringInstalmentDue(schedule: { totalDue: number }[]): number {
  if (schedule.length === 0) return 0
  return schedule[1]?.totalDue ?? schedule[0].totalDue
}
