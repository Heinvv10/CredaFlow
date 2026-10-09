/**
 * The readiness SHAPE and its copy, with no server imports.
 *
 * Deliberately separate from `readiness.ts`. Computing readiness reuses the
 * guard helpers the enforcing routes call, and several of those reach
 * `lib/storage` and therefore `node:fs/promises`. Pulling the card's one-line
 * summary out of the same module dragged that whole graph into the client
 * bundle and failed the build outright. Anything a "use client" component
 * touches belongs here; anything that evaluates a gate belongs there.
 */
export type ReadinessStage = "READY" | "MISSING"

export interface ApplicationReadiness {
  stage: ReadinessStage
  /** Short human labels, in the order staff should work them. */
  blockers: string[]
}

export const READY_LABELS: Record<string, string> = {
  SUBMITTED: "Ready for review",
  UNDER_REVIEW: "Ready to approve",
  APPROVED: "Ready to disburse",
}

/**
 * What the application is ready FOR, which is not the same at each status.
 * "Ready for review" over an UNDER_REVIEW card would name a step already taken.
 */
export function readinessReadyLabel(status: string): string {
  return READY_LABELS[status] ?? "Ready"
}

/**
 * What the green chip is honest about.
 *
 * READY means every gate decidable without opening a file is clear. Four
 * integrity checks in the payout path re-read stored bytes and are not run per
 * card, so a READY card can still be refused. That caveat used to live only in
 * a source comment, where the operator reading the chip could not see it; it
 * belongs on the chip itself.
 */
export const READY_CAVEAT =
  "No outstanding blockers. Document integrity is re-checked at payout, so this is not a guarantee."

/** "2 missing: Payslip missing, Bureau check required" — the card's one line. */
export function readinessSummary(
  readiness: ApplicationReadiness,
  status: string,
  namedLimit = 2,
): string {
  if (readiness.stage === "READY") return readinessReadyLabel(status)
  const named = readiness.blockers.slice(0, namedLimit)
  const rest = readiness.blockers.length - named.length
  return `${readiness.blockers.length} missing: ${named.join(", ")}${
    rest > 0 ? ` +${rest}` : ""
  }`
}
