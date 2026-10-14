/**
 * The screening state machine, pure. Facts in, state out; no database.
 *
 * A client's state is the state of their LATEST run (one row per type):
 *
 *   NOT_CONFIGURED  lender has no provider: approval passes, nothing written
 *   NOT_SCREENED    configured, never screened: approval blocked
 *   BLOCKED         confirmed sanctions match, a REJECTED match, or simulated
 *                   evidence this deployment forbids: approval blocked and no
 *                   reviewer can clear it
 *   INCOMPLETE      a type errored or is missing: re-run
 *   REFER           an undecided match: a reviewer must decide it
 *   CLEAR           every type clear, or every match FALSE_POSITIVE/ACCEPTED
 *
 * The SQL trigger guardLoanApplicationScreening applies the same rule
 * (simulation excepted, which SQL cannot see).
 */
import { createHash } from "node:crypto"
import type { AmlStatus, ScreeningDecision, ScreeningResult, ScreeningType, UserRole } from "@prisma/client"
import { hasMinRole } from "@/lib/permissions"
import { SCREENING_TYPES, type ScreeningMatch } from "./types"

export type ScreeningCheckFacts = {
  id: string
  type: ScreeningType
  result: ScreeningResult
  decision: ScreeningDecision | null
  simulated: boolean
}

export type BlockReason = "SANCTIONS_MATCH" | "REJECTED" | "SIMULATED_NOT_PERMITTED"

export type ScreeningState =
  | { state: "NOT_CONFIGURED" }
  | { state: "NOT_SCREENED" }
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
}): ScreeningState {
  const { configured, latestRun, simulationPermitted } = input
  if (!configured) return { state: "NOT_CONFIGURED" }
  if (latestRun.length === 0) return { state: "NOT_SCREENED" }

  const sanctions = latestRun.filter(isConfirmedSanctionsMatch)
  if (sanctions.length > 0) return { state: "BLOCKED", reason: "SANCTIONS_MATCH", checkIds: ids(sanctions) }
  const rejected = latestRun.filter((c) => c.decision === "REJECTED")
  if (rejected.length > 0) return { state: "BLOCKED", reason: "REJECTED", checkIds: ids(rejected) }
  const simulated = latestRun.filter((c) => c.simulated)
  if (simulated.length > 0 && !simulationPermitted) {
    return { state: "BLOCKED", reason: "SIMULATED_NOT_PERMITTED", checkIds: ids(simulated) }
  }
  const errored = latestRun.filter((c) => c.result === "ERROR")
  const missing = SCREENING_TYPES.some((t) => !latestRun.some((c) => c.type === t))
  if (errored.length > 0 || missing) return { state: "INCOMPLETE", checkIds: ids(errored) }
  const open = latestRun.filter((c) => isMatch(c.result) && c.decision === null)
  if (open.length > 0) return { state: "REFER", checkIds: ids(open) }
  return { state: "CLEAR" }
}

export function screeningAllowsApproval(s: ScreeningState): boolean {
  return s.state === "CLEAR" || s.state === "NOT_CONFIGURED"
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
    case "NOT_SCREENED": return "The client has not been screened."
    case "CLEAR": return "Screening is clear."
    case "INCOMPLETE": return "Screening did not complete (a provider error). Run it again."
    case "REFER": return `${s.checkIds.length} screening match${s.checkIds.length === 1 ? " needs" : "es need"} a reviewer's decision.`
    case "BLOCKED":
      return s.reason === "SANCTIONS_MATCH"
        ? "The client is a confirmed sanctions match. This cannot be overridden."
        : s.reason === "REJECTED"
          ? "A reviewer confirmed a screening match against this client. This cannot be overridden."
          : "The screening result is simulated, which this deployment does not accept as evidence."
  }
}

export type ReviewRefusalCode =
  | "already_decided"
  | "not_a_match"
  | "sanctions_not_clearable"
  | "sanctions_not_acceptable"
  | "role_below_policy"
  | "totp_required"

export function reviewEligibility(input: {
  check: Pick<ScreeningCheckFacts, "type" | "result" | "decision">
  decision: ScreeningDecision
  policy: { reviewMinRole: UserRole; requireStaffTotp: boolean }
  caller: { role: UserRole; totpVerified: boolean }
}): { allowed: true } | { allowed: false; code: ReviewRefusalCode } {
  const { check, decision, policy, caller } = input
  if (check.decision !== null) return { allowed: false, code: "already_decided" }
  if (!isMatch(check.result)) return { allowed: false, code: "not_a_match" }
  if (isConfirmedSanctionsMatch(check)) return { allowed: false, code: "sanctions_not_clearable" }
  if (check.type === "SANCTIONS" && decision === "ACCEPTED") return { allowed: false, code: "sanctions_not_acceptable" }
  if (!hasMinRole(caller.role, policy.reviewMinRole)) return { allowed: false, code: "role_below_policy" }
  if (policy.requireStaffTotp && !caller.totpVerified) return { allowed: false, code: "totp_required" }
  return { allowed: true }
}

/** Stable across runs: the type plus the sorted, de-duplicated list-entry ids. */
export function matchFingerprint(type: ScreeningType, matches: ScreeningMatch[]): string {
  const entries = [...new Set(matches.map((m) => m.listEntryId))].sort()
  return createHash("sha256").update(`${type}|${entries.join("\u0000")}`).digest("hex")
}

export type PriorDecision = {
  id: string
  type: ScreeningType
  matchFingerprint: string | null
  decision: ScreeningDecision | null
  decisionReason: string | null
  createdAt: Date
}

/**
 * The decision a new match inherits: the newest decided earlier check of the
 * same type with the same fingerprint. A different set of list entries is new
 * evidence and is referred again.
 */
export function carriedDecision(
  candidate: { type: ScreeningType; fingerprint: string },
  priors: PriorDecision[],
): PriorDecision | null {
  const same = priors
    .filter((p) => p.decision !== null && p.type === candidate.type && p.matchFingerprint === candidate.fingerprint)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  return same[0] ?? null
}
