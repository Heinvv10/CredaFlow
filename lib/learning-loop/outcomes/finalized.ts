/**
 * Which loans the nightly job need not derive again (DESIGN.md §4). A loan is
 * finalised when it has ended (settled, written off or cancelled), its rows
 * for the approval are all in a state no later day can change, they carry the
 * current OUTCOME_DEFINITION_VERSION and this lender's demoData flag, and no
 * returned debit order has arrived that they do not hold. Anything else, an
 * open loan or a still-pending, revisable or older-version row, is derived
 * again, so a version bump recomputes every row.
 *
 * Final means OBSERVED, or UNOBSERVABLE for a reason that is a fact of the
 * past: a history gap or outage (the history is never backfilled) or a
 * cancellation. A missing close date, paid-at or schedule can be corrected,
 * so those stay revisable.
 */
import type { prisma } from "@/lib/prisma"
import { OUTCOME_DEFINITION_VERSION, UNOBSERVABLE_REASONS } from "./definition"

export type FinalizedDb = Pick<typeof prisma, "decisionOutcome">

const REVISABLE_REASONS = [UNOBSERVABLE_REASONS.CLOSE_DATE_MISSING, UNOBSERVABLE_REASONS.PAID_AT_MISSING, UNOBSERVABLE_REASONS.NO_SCHEDULE]

export interface FinalizedCandidate {
  approvalId: string
  /** Returned debit orders the source holds for the loan (the rows RETURNED_DEBIT_ORDER would be). */
  returns: number
}

/** The approvals, among the candidates (loans that have ended), whose rows need no new derivation. */
export async function finalizedApprovals(
  db: FinalizedDb,
  args: { tenantId: string; demoTenant: boolean; candidates: readonly FinalizedCandidate[] },
): Promise<Set<string>> {
  if (args.candidates.length === 0) return new Set()
  const where = {
    tenantId: args.tenantId, sourceSystem: "credaflow", decisionRecordId: { in: args.candidates.map((c) => c.approvalId) },
  }
  const [held, notFinal] = await Promise.all([
    db.decisionOutcome.groupBy({ by: ["decisionRecordId", "outcomeKind"], where, _count: { _all: true } }),
    db.decisionOutcome.groupBy({
      by: ["decisionRecordId"],
      where: {
        ...where,
        OR: [
          { state: "PENDING" },
          { state: "UNOBSERVABLE", reasonCode: { in: REVISABLE_REASONS } },
          { definitionVersion: { not: OUTCOME_DEFINITION_VERSION } },
          { demoData: { not: args.demoTenant } },
        ],
      },
    }),
  ])
  const rows = new Map<string, number>()
  const returned = new Map<string, number>()
  for (const g of held) {
    rows.set(g.decisionRecordId, (rows.get(g.decisionRecordId) ?? 0) + g._count._all)
    if (g.outcomeKind === "RETURNED_DEBIT_ORDER") returned.set(g.decisionRecordId, g._count._all)
  }
  const open = new Set(notFinal.map((g) => g.decisionRecordId))
  return new Set(args.candidates
    .filter((c) => (rows.get(c.approvalId) ?? 0) > 0 && !open.has(c.approvalId) && (returned.get(c.approvalId) ?? 0) === c.returns)
    .map((c) => c.approvalId))
}
