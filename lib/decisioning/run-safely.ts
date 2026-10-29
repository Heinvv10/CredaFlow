import { runAutoDecision, type AutoDecisionOutcome, type Trigger } from "./auto-decision"

/**
 * runAutoDecision for a caller that must not fail because of it (the review
 * route): an error is logged and answered with null, and the application stays
 * with staff.
 */
export async function runAutoDecisionSafely(input: { tenantId: string; applicationId: string; trigger: Trigger }): Promise<AutoDecisionOutcome | null> {
  try {
    return await runAutoDecision(input)
  } catch (error) {
    console.error("[auto-decision] run failed; the application stays with staff:", input.applicationId, error)
    return null
  }
}

/** The status the application is in once the engine has run: only an executed approval or decline moves it. */
export function statusAfterAutoDecision(outcome: AutoDecisionOutcome): "UNDER_REVIEW" | "APPROVED" | "DECLINED" {
  if (outcome.status !== "RAN") return "UNDER_REVIEW"
  return outcome.execution === "APPROVED" ? "APPROVED" : outcome.execution === "DECLINED" ? "DECLINED" : "UNDER_REVIEW"
}
