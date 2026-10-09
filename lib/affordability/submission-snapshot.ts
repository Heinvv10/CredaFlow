import {
  affordabilityDecisionSnapshotIsIntact,
  readAffordabilitySnapshotStore,
  type AffordabilityDecisionSnapshot,
} from "@/lib/affordability/snapshot"

/**
 * The immutable submission snapshot, checked exactly as every gate checks it.
 *
 * Three call sites enforced these same three lines independently — the
 * approval gate in decide/route.ts, the payout evidence check, and
 * `verifyCurrentAffordabilityApproval` — each free to drift from the others.
 * The rule is one rule: the snapshot must exist, must be a SUBMISSION, must be
 * pinned to the exact instant the application was submitted, and must still
 * hash to itself.
 *
 * `submittedAt` is accepted as a string too because a serialised application
 * reaches this from a JSON boundary; an unparseable value is a changed
 * snapshot, not a crash.
 */
export function verifySubmissionAffordabilitySnapshot(application: {
  affordabilityResult: unknown
  submittedAt: Date | string | null
}):
  | { ok: true; submission: AffordabilityDecisionSnapshot }
  | { ok: false; reason: "submission_missing" | "submission_changed" } {
  const submission = readAffordabilitySnapshotStore(
    application.affordabilityResult,
  ).submission
  if (!submission || !application.submittedAt) {
    return { ok: false, reason: "submission_missing" }
  }
  let submittedAt: string
  try {
    submittedAt = new Date(application.submittedAt).toISOString()
  } catch {
    return { ok: false, reason: "submission_changed" }
  }
  if (
    submission.stage !== "SUBMISSION" ||
    submission.capturedAt !== submittedAt ||
    !affordabilityDecisionSnapshotIsIntact(submission)
  ) {
    return { ok: false, reason: "submission_changed" }
  }
  return { ok: true, submission }
}
