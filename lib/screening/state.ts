/**
 * The screening state machine, pure. Facts in, state out; no database.
 *
 * A subject's state is: an unlifted ScreeningBlock blocks; otherwise the state
 * of its LATEST run, provided that run screened the subject's CURRENT identity:
 *
 *   NOT_CONFIGURED  lender has no provider: approval passes, nothing written
 *   NOT_SCREENED    never screened, or the latest run screened another identity
 *   BLOCKED         sticky block, confirmed sanctions match, REJECTED match, or
 *                   simulated evidence this deployment forbids: no reviewer clears it
 *   INCOMPLETE      a supported type errored or is missing: re-run
 *   REFER           an undecided match: a reviewer must decide it
 *   CLEAR           every type clear, or every match FALSE_POSITIVE/ACCEPTED
 *
 * The SQL function screeningSubjectRefusal applies the same rule (simulation
 * and supported types excepted, which SQL cannot see).
 */
import type { AmlStatus, ScreeningDecision, ScreeningResult, ScreeningType, UserRole } from "@prisma/client"
import { hasMinRole } from "@/lib/permissions"

export type ScreeningCheckFacts = {
  id: string
  type: ScreeningType
  result: ScreeningResult
  decision: ScreeningDecision | null
  simulated: boolean
  subjectFingerprint: string | null
}

export type BlockReason = "STICKY_BLOCK" | "SANCTIONS_MATCH" | "REJECTED" | "SIMULATED_NOT_PERMITTED"

export type ScreeningState =
  | { state: "NOT_CONFIGURED" }
  | { state: "NOT_SCREENED"; reason?: "SUBJECT_CHANGED" }
  | { state: "BLOCKED"; reason: BlockReason; checkIds: string[] }
  | { state: "INCOMPLETE"; checkIds: string[] }
  | { state: "REFER"; checkIds: string[] }
  | { state: "CLEAR" }

const isMatch = (r: ScreeningResult) => r === "POSSIBLE_MATCH" || r === "CONFIRMED_MATCH"
const ids = (checks: ScreeningCheckFacts[]) => checks.map((c) => c.id)

export function isConfirmedSanctionsMatch(c: Pick<ScreeningCheckFacts, "type" | "result">): boolean {
  return c.type === "SANCTIONS" && c.result === "CONFIRMED_MATCH"
}

export function deriveScreeningState(input: {
  configured: boolean
  latestRun: ScreeningCheckFacts[]
  simulationPermitted: boolean
  /** The types the provider screens; a run lacking one of these is INCOMPLETE. */
  expectedTypes: readonly ScreeningType[]
  /** screeningCurrentFingerprint of the subject now. */
  currentFingerprint: string | null
  /** Source-check ids of unlifted ScreeningBlocks on the subject. */
  activeBlockCheckIds: string[]
}): ScreeningState {
  const { configured, latestRun, simulationPermitted, expectedTypes, currentFingerprint, activeBlockCheckIds } = input
  if (!configured) return { state: "NOT_CONFIGURED" }
  if (activeBlockCheckIds.length > 0) return { state: "BLOCKED", reason: "STICKY_BLOCK", checkIds: activeBlockCheckIds }
  if (latestRun.length === 0) return { state: "NOT_SCREENED" }
  if (!currentFingerprint || latestRun.some((c) => c.subjectFingerprint !== currentFingerprint)) {
    return { state: "NOT_SCREENED", reason: "SUBJECT_CHANGED" }
  }

  const sanctions = latestRun.filter(isConfirmedSanctionsMatch)
  if (sanctions.length > 0) return { state: "BLOCKED", reason: "SANCTIONS_MATCH", checkIds: ids(sanctions) }
  const rejected = latestRun.filter((c) => c.decision === "REJECTED")
  if (rejected.length > 0) return { state: "BLOCKED", reason: "REJECTED", checkIds: ids(rejected) }
  const simulated = latestRun.filter((c) => c.simulated)
  if (simulated.length > 0 && !simulationPermitted) {
    return { state: "BLOCKED", reason: "SIMULATED_NOT_PERMITTED", checkIds: ids(simulated) }
  }
  const errored = latestRun.filter((c) => c.result === "ERROR")
  const missing = expectedTypes.some((t) => !latestRun.some((c) => c.type === t))
  if (errored.length > 0 || missing) return { state: "INCOMPLETE", checkIds: ids(errored) }
  const open = latestRun.filter((c) => isMatch(c.result) && c.decision === null)
  if (open.length > 0) return { state: "REFER", checkIds: ids(open) }
  return { state: "CLEAR" }
}

export function screeningAllowsApproval(s: ScreeningState): boolean {
  return s.state === "CLEAR" || s.state === "NOT_CONFIGURED"
}

/** Whether the approval gate (and the cron) should run the provider again first. */
export function needsRerun(s: ScreeningState): boolean {
  return s.state === "NOT_SCREENED" || s.state === "INCOMPLETE"
}

/** Client.amlScreeningStatus for a state; null = leave the column alone. */
export function amlStatusFor(s: ScreeningState): AmlStatus | null {
  switch (s.state) {
    case "NOT_CONFIGURED": return null
    case "CLEAR": return "CLEARED"
    case "REFER":
    case "BLOCKED": return "FLAGGED"
    case "INCOMPLETE":
    case "NOT_SCREENED": return "PENDING"
  }
}

export function screeningStateMessage(s: ScreeningState): string {
  switch (s.state) {
    case "NOT_CONFIGURED": return "Screening is not configured for this lender."
    case "NOT_SCREENED":
      return s.reason === "SUBJECT_CHANGED"
        ? "The identity details changed since the last screening. Screen again."
        : "Not screened yet."
    case "CLEAR": return "Screening is clear."
    case "INCOMPLETE": return "Screening did not complete (a provider error). Run it again."
    case "REFER": return `${s.checkIds.length} screening match${s.checkIds.length === 1 ? " needs" : "es need"} a reviewer's decision.`
    case "BLOCKED":
      return s.reason === "STICKY_BLOCK"
        ? "An earlier sanctions match or rejected match blocks this party until a super admin lifts it."
        : s.reason === "SANCTIONS_MATCH"
          ? "A confirmed sanctions match. This cannot be overridden."
          : s.reason === "REJECTED"
            ? "A reviewer confirmed a screening match. This cannot be overridden."
            : "The screening result is simulated, which this deployment does not accept as evidence."
  }
}

export type ReviewRefusalCode =
  | "already_decided"
  | "not_a_match"
  | "sanctions_not_clearable"
  | "sanctions_not_acceptable"
  | "own_run"
  | "role_below_policy"
  | "totp_required"

export function reviewEligibility(input: {
  check: Pick<ScreeningCheckFacts, "type" | "result" | "decision"> & { triggeredById: string | null }
  decision: ScreeningDecision
  policy: { reviewMinRole: UserRole; requireStaffTotp: boolean }
  caller: { id: string; role: UserRole; totpVerified: boolean }
}): { allowed: true } | { allowed: false; code: ReviewRefusalCode } {
  const { check, decision, policy, caller } = input
  if (check.decision !== null) return { allowed: false, code: "already_decided" }
  if (!isMatch(check.result)) return { allowed: false, code: "not_a_match" }
  if (isConfirmedSanctionsMatch(check)) return { allowed: false, code: "sanctions_not_clearable" }
  if (check.type === "SANCTIONS" && decision === "ACCEPTED") return { allowed: false, code: "sanctions_not_acceptable" }
  if (check.triggeredById !== null && check.triggeredById === caller.id) return { allowed: false, code: "own_run" }
  if (!hasMinRole(caller.role, policy.reviewMinRole)) return { allowed: false, code: "role_below_policy" }
  if (policy.requireStaffTotp && !caller.totpVerified) return { allowed: false, code: "totp_required" }
  return { allowed: true }
}
