type FlaggedEvent = { commissionStatus: string; qualityFlag: string | null }

// Whether a flagged commission event still needs a human decision, for the
// Overview tab's "flagged events" attention count.
//
// Product rule: BLOCKED is excluded alongside APPROVED — both
// are a resolved staff decision, not an outstanding one. Leaving BLOCKED in
// would make the attention list nag forever about something already decided,
// defeating its purpose ("genuinely undecided"). REVERSED is excluded because
// a reversed row can carry a stale qualityFlag. UNMATCHED_CODE is excluded
// because it already has its own dedicated attention row.
//
// commissionStatus and qualityFlag are different columns (see
// prisma/schema.prisma): BLOCKED/REVERSED are commissionStatus values,
// UNMATCHED_CODE/APPROVED are qualityFlag values — both are checked here.
//
// This predicate governs the attention count ONLY, not the commission queue
// (queueWhere in page.tsx) — see that file's comment for why the queue must
// keep showing blocked events.
export function needsCommissionAttention(event: FlaggedEvent): boolean {
  if (event.qualityFlag === null) return false
  if (event.commissionStatus === "REVERSED") return false
  if (event.commissionStatus === "BLOCKED") return false
  if (event.qualityFlag === "UNMATCHED_CODE") return false
  if (event.qualityFlag === "APPROVED") return false
  return true
}
