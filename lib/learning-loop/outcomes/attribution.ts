/**
 * Which decision record an outcome attaches to (DESIGN.md §3, "Attribution").
 *
 * - A loan's credit outcomes attach to the FINAL approval of the application
 *   that produced it: the latest CREDIT_DECISION/APPROVE decided at or before
 *   disbursement. An approval undone by a return to review gets nothing.
 * - An offer (APPROVED_TERMS, QUOTATION_ISSUED) gets its take-up: TAKEN_UP
 *   true when the loan was disbursed, false when a later return, decline or
 *   cancellation ended it first. NOT_TAKEN_UP is TAKEN_UP false.
 * - Declines get no outcome (no repayment is observable); CLEAR_FLAG records
 *   inherit their approval's outcome by a join, not a row.
 * - Collection actions are not logged yet (PR A defers them), so nothing is
 *   attributed to one; that is the follow-up.
 */
import type { DecisionRecordKind } from "@prisma/client"
import { observed, pending, type DerivedOutcome } from "./definition"

export interface DecisionRef {
  id: string
  kind: DecisionRecordKind
  decision: string
  applicationId: string
  decidedAt: Date
  createdAt: Date
}

export interface ApplicationState {
  id: string
  status: string
  /** When the loan was paid out; null if it never was. */
  disbursedAt: Date | null
  /** The application's last change: when a DECLINED or CANCELLED status was set. */
  updatedAt: Date
}

const later = (a: DecisionRef, b: DecisionRef) =>
  a.decidedAt.getTime() - b.decidedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)

/** The approval a disbursed loan's outcomes attach to; null when none was logged before disbursement. */
export function finalApproval(records: readonly DecisionRef[], disbursedAt: Date): DecisionRef | null {
  const approvals = records
    .filter((r) => r.kind === "CREDIT_DECISION" && r.decision === "APPROVE" && r.decidedAt.getTime() <= disbursedAt.getTime())
    .sort(later)
  return approvals[approvals.length - 1] ?? null
}

const ENDS_AN_OFFER = new Set(["RETURN_TO_REVIEW", "RETURN_TO_DRAFT", "DECLINE"])

/** Take-up for every offer record of one application. */
export function takeUpOutcomes(records: readonly DecisionRef[], app: ApplicationState): DerivedOutcome[] {
  const offers = records.filter((r) => r.kind === "OFFER")
  return offers.map((offer) => {
    const base = { decisionRecordId: offer.id, outcomeKind: "TAKEN_UP" as const, window: "OFFER", sourceRef: app.id }
    const ended = records
      .filter((r) => r.kind === "CREDIT_DECISION" && ENDS_AN_OFFER.has(r.decision) && later(r, offer) > 0)
      .sort(later)[0]
    if (ended && (app.disbursedAt === null || ended.decidedAt.getTime() < app.disbursedAt.getTime())) {
      return { ...base, ...observed(false, ended.decidedAt) }
    }
    if (app.disbursedAt !== null) return { ...base, ...observed(true, app.disbursedAt) }
    if (app.status === "DECLINED" || app.status === "CANCELLED") return { ...base, ...observed(false, app.updatedAt) }
    return { ...base, ...pending() }
  })
}
