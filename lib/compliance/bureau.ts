// NCA s.81 (reckless lending prohibition) requires a current credit
// assessment before entering into a credit agreement. NCR enforcement
// guidance for short-term unsecured lending treats 30-60 days as "current";
// 90 days is on the edge. Default to 60 days, which is defensible for
// instalment products and lenient enough for short workflows.
//
// Single source so /decide and /disburse stay in lockstep — drift between
// the two would let a stale check pass approval and then a fresh window
// refuse disburse, or vice versa.
export const BUREAU_STALENESS_DAYS = 60

export function bureauStalenessCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - BUREAU_STALENESS_DAYS * 24 * 60 * 60 * 1000)
}
