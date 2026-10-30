import type { Authority } from "./evaluate"
import type { MatrixLevel } from "./types"

export type ApprovalPlan =
  | { kind: "refuse"; status: number; code: string; error: string }
  /** Level `level` of `requiredLevels` approved; the application stays under review for the next. */
  | { kind: "record"; level: number; requiredLevels: number; via: Authority["via"]; delegationId: string | null }
  /** This approval completes the chain (or none is required): the application is approved with it. */
  | { kind: "final"; level: number; requiredLevels: number; via: Authority["via"]; delegationId: string | null }

export interface PlanInput {
  /** How many levels the case needs (0: no staff chain). */
  required: number
  levels: readonly MatrixLevel[]
  steps: ReadonlyArray<{ level: number; approverId: string }>
  userId: string
  /** The staff who captured the application or changed its inputs: the maker. */
  inputStaffIds: readonly string[]
  authority: Authority
  /**
   * The level the user would hold if the delegators who already acted on this application (made it, or approved it) could still
   * delegate: above `authority.level` only when such a delegation is being refused.
   */
  blockedAuthorityLevel: number
  /** The user is the delegator of a delegate who already approved this application. */
  delegatorActed: boolean
  /** The decision engine is asking. */
  automated: boolean
  /** The latest committee decision at the committee's level, if any. */
  committeeDecision: { decision: "APPROVED" | "DECLINED" | "DEFERRED" } | null
  /** Everyone who recorded a committee decision at the committee's level: none of them gives that level's approval. */
  committeeRecorderIds: readonly string[]
}

const refuse = (status: number, code: string, error: string): ApprovalPlan => ({ kind: "refuse", status, code, error })

/**
 * What an approval attempt does under the matrix, from the data already read. Pure. Order matters: the engine and the maker
 * are refused before anything about authority is said, and a level is approved only in sequence, by a different person each time.
 */
export function planApproval(input: PlanInput): ApprovalPlan {
  const { required, authority } = input
  if (input.automated) {
    return required > 0
      ? refuse(409, "AUTOMATION_NOT_PERMITTED", `The approval matrix needs ${required} level${required === 1 ? "" : "s"} of staff approval for this application; the decision engine leaves it with staff.`)
      : { kind: "final", level: 0, requiredLevels: 0, via: "ROLE", delegationId: null }
  }
  if (required === 0) return { kind: "final", level: 0, requiredLevels: 0, via: "ROLE", delegationId: null }
  if (input.inputStaffIds.includes(input.userId)) {
    return refuse(403, "MAKER_CANNOT_APPROVE", "You captured this application or changed its figures, so you cannot approve it at any level.")
  }
  if (input.steps.some((s) => s.approverId === input.userId)) {
    return refuse(409, "ALREADY_APPROVED", "You have already approved this application at a lower level; the next level needs a different person.")
  }
  if (input.delegatorActed) {
    return refuse(403, "DELEGATOR_ALREADY_ACTED", "Your delegate already approved this application on your authority, so you cannot also approve it.")
  }
  const next = input.steps.length + 1
  if (next > required) return refuse(409, "CHAIN_COMPLETE", "Every required level has already approved this application.")
  const level = input.levels.find((l) => l.level === next)
  if (!level) return refuse(409, "LEVEL_UNKNOWN", `The approval matrix has no level ${next}.`)
  if (authority.level < next) {
    if (input.blockedAuthorityLevel >= next) {
      return refuse(403, "DELEGATOR_ALREADY_ACTED", `Level ${next} (${level.name}) would come to you only by a delegation from someone who captured this application or already approved it; one person does not hold two seats.`)
    }
    return refuse(403, "LEVEL_AUTHORITY_REQUIRED", `Level ${next} (${level.name}) needs the ${level.role} role or a delegation of that authority; yours reaches level ${authority.level}.`)
  }
  if (level.committee) {
    if (input.committeeRecorderIds.includes(input.userId)) {
      return refuse(409, "COMMITTEE_RECORDER_CANNOT_APPROVE", "You recorded the committee's decision, so another person must give the committee level's approval.")
    }
    if (input.committeeDecision?.decision === "DECLINED") {
      return refuse(409, "COMMITTEE_DECLINED", "The credit committee declined this application. Decline it, or have the committee record a new decision.")
    }
    if (input.committeeDecision?.decision !== "APPROVED") {
      return refuse(409, "COMMITTEE_DECISION_REQUIRED", "This level is the credit committee's: record its approval decision (with any conditions) before approving.")
    }
  }
  const outcome = { level: next, requiredLevels: required, via: authority.via, delegationId: authority.delegationId }
  return next === required ? { kind: "final", ...outcome } : { kind: "record", ...outcome }
}
